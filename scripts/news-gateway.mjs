const MONITOR_URL = process.env.MONITOR_URL || 'https://xsmahlsqdszxqordgcvt.supabase.co/functions/v1/monitor-worker';
const MONITOR_SECRET = process.env.MONITOR_SECRET || '';
if (!MONITOR_SECRET) {
  console.log('MONITOR_SECRET yoxdur; Web/Xəbər gateway buraxıldı.');
  process.exit(0);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 MediaMonitorinqGateway/1.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let lastExternalFetchAt = 0;
let gdeltBlockedUntil = 0;
const DIRECT_ONLY = ['1','true','yes'].includes(String(process.env.NEWS_DIRECT_ONLY || '').toLowerCase());
const SOURCE_BATCH_SIZE = Math.max(4, Math.min(40, Number(process.env.NEWS_SOURCE_BATCH || (DIRECT_ONLY ? 24 : 8))));
const DOMAIN_SEARCH_BATCH = Math.max(0, Math.min(SOURCE_BATCH_SIZE, Number(process.env.NEWS_DOMAIN_SEARCH_BATCH ?? (DIRECT_ONLY ? 0 : 6))));
const BROAD_QUERY_LIMIT = Math.max(0, Math.min(12, Number(process.env.NEWS_BROAD_QUERY_LIMIT ?? (DIRECT_ONLY ? 0 : 2))));
const FAST_LINK_LIMIT = Math.max(4, Math.min(20, Number(process.env.NEWS_FAST_LINK_LIMIT || 8)));
const FAST_FEED_LIMIT = Math.max(4, Math.min(20, Number(process.env.NEWS_FAST_FEED_LIMIT || 10)));
const MAX_INGEST_ITEMS = Math.max(20, Math.min(180, Number(process.env.NEWS_MAX_INGEST_ITEMS || (DIRECT_ONLY ? 90 : 120))));
const MAX_ENRICH_ITEMS = Math.max(2, Math.min(24, Number(process.env.NEWS_MAX_ENRICH_ITEMS || (DIRECT_ONLY ? 8 : 12))));
const MAX_SCREENSHOTS = Math.max(1, Math.min(12, Number(process.env.NEWS_MAX_SCREENSHOTS || (DIRECT_ONLY ? 3 : 5))));
const SOURCE_SHARD_COUNT = Math.max(1, Math.min(20, Number(process.env.NEWS_SOURCE_SHARD_COUNT || 1)));
const SOURCE_SHARD_INDEX = Math.max(0, Math.min(SOURCE_SHARD_COUNT - 1, Number(process.env.NEWS_SOURCE_SHARD_INDEX || 0)));

async function politeWait(minGapMs = 1200) {
  const elapsed = Date.now() - lastExternalFetchAt;
  if (elapsed < minGapMs) await sleep(minGapMs - elapsed);
  lastExternalFetchAt = Date.now();
}

async function fetchText(url, {timeoutMs = 15000, retries = 1, minGapMs = 1200} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await politeWait(minGapMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,text/html;q=0.7,*/*;q=0.5',
          'accept-language': 'az-AZ,az;q=0.9,tr;q=0.7,en;q=0.5',
          'cache-control': 'no-cache'
        },
        signal: controller.signal
      });
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.retryAfter = retryAfter;
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastError = e;
      const status = Number(e?.status || 0);
      const retryable = status === 429 || status === 503 || status === 502 || status === 504 || e?.name === 'AbortError';
      if (!retryable || attempt >= retries) throw e;
      const delay = Math.max(Number(e?.retryAfter || 0) * 1000, 2200 * (attempt + 1));
      await sleep(Math.min(delay, 7000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('fetch failed');
}

async function callMonitor(body, timeoutMs = 35000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(MONITOR_URL, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-monitor-secret': MONITOR_SECRET},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {ok:false,error:text.slice(0,500)}; }
    if (!res.ok) throw new Error(`monitor-worker HTTP ${res.status}: ${text.slice(0,500)}`);
    return data;
  } finally { clearTimeout(timer); }
}

function chunks(items, size = 10) {
  const rows = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function ingestInChunks({org, platform, label, items}) {
  const pieces = chunks(items, 10);
  const aggregate = {
    received: 0, accepted: 0, rejected: 0, inserted: 0,
    sample_results: [], screenshot_targets: [], accepted_targets: [], errors: [], chunk_failures: 0
  };
  for (let i = 0; i < pieces.length; i++) {
    const part = pieces[i];
    try {
      const result = await callMonitor({
        mode:'news_ingest', organization_id:org.id, source_platform:platform,
        source_label:label, items:part
      });
      aggregate.received += Number(result?.received || 0);
      aggregate.accepted += Number(result?.accepted || 0);
      aggregate.rejected += Number(result?.rejected || 0);
      aggregate.inserted += Number(result?.inserted || 0);
      if (Array.isArray(result?.sample_results)) aggregate.sample_results.push(...result.sample_results.slice(0,3));
      if (Array.isArray(result?.screenshot_targets)) aggregate.screenshot_targets.push(...result.screenshot_targets);
      if (Array.isArray(result?.accepted_targets)) aggregate.accepted_targets.push(...result.accepted_targets);
      if (Array.isArray(result?.errors)) aggregate.errors.push(...result.errors.slice(0,3));
      console.log(`[${org.short_name}] ${label}: paket ${i+1}/${pieces.length} — received=${result?.received||0}, accepted=${result?.accepted||0}, rejected=${result?.rejected||0}, inserted=${result?.inserted||0}`);
    } catch (e) {
      aggregate.chunk_failures++;
      console.log(`[${org.short_name}] ${label}: paket ${i+1}/${pieces.length} ingest xəta — ${e?.message||e}`);
      // Bir paket Edge resource limit/timeout alsa bütün GitHub job dayanmasın.
      // Növbəti run eyni discovery nəticələrini yenidən görəcək və duplicate qoruması var.
      await sleep(900);
    }
  }
  aggregate.screenshot_targets = dedupe(aggregate.screenshot_targets.map(x=>({ ...x, url:String(x?.url||'') }))).filter(x=>x.url);
  aggregate.accepted_targets = dedupe(aggregate.accepted_targets.map(x=>({ ...x, url:String(x?.url||'') }))).filter(x=>x.url);
  return aggregate;
}

function decodeXml(s='') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function stripHtml(s='') { return decodeXml(String(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()); }
function tag(block,name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'));
  return m ? decodeXml(m[1].trim()) : '';
}
function attr(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  return block.match(re)?.[1] || '';
}
function normalizeDate(value='') {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function unwrapSearchUrl(value='') {
  let current=String(value||'').trim();
  if(!current) return current;
  try {
    const u=new URL(current);
    const host=u.hostname.replace(/^www\./i,'').toLowerCase();
    // Bing RSS nəticələri tez-tez apiclick.aspx wrapper-i ilə gəlir. Stabil dedupe,
    // düzgün original açılışı və enrich üçün daxildəki real xəbər URL-ni saxlayırıq.
    if(host==='bing.com' || host==='www.bing.com') {
      const raw=u.searchParams.get('url');
      if(raw) {
        try { current=decodeURIComponent(raw); } catch { current=raw; }
      }
    }
  } catch {}
  return current;
}

function parseFeed(xml, rawKind, discoveryQuery, provider) {
  const rssBlocks = [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
  const atomBlocks = rssBlocks.length ? [] : [...String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(m=>m[1]);
  const blocks = rssBlocks.length ? rssBlocks : atomBlocks;
  const atom = !rssBlocks.length && atomBlocks.length > 0;
  return blocks.map(block=>{
    const title = stripHtml(tag(block,'title'));
    let url = atom ? (attr(block,'link','href') || stripHtml(tag(block,'link'))) : stripHtml(tag(block,'link'));
    if (!url) url = stripHtml(tag(block,'guid')) || stripHtml(tag(block,'id'));
    url = unwrapSearchUrl(url);
    const description = stripHtml(tag(block, atom ? 'summary' : 'description') || tag(block,'content'));
    const pub = stripHtml(tag(block,'pubDate') || tag(block,'published') || tag(block,'updated'));
    const source = stripHtml(tag(block,'source') || tag(block,'author'));
    const sourceUrl = attr(block,'source','url') || '';
    const enclosure = attr(block,'enclosure','url') || attr(block,'media:content','url') || attr(block,'media:thumbnail','url') || (tag(block, atom ? 'summary' : 'description').match(/<img[^>]+src=[\"']([^\"']+)[\"']/i)?.[1] || null);
    return {
      title,
      text: description,
      url,
      published_at: normalizeDate(pub),
      image: enclosure,
      author: source || null,
      raw: {kind:rawKind,provider,discovery_query:discoveryQuery,source_url:sourceUrl||null}
    };
  }).filter(x=>x.url && x.title);
}
function normalizeTitleKey(value='') {
  return stripHtml(String(value||'')).toLocaleLowerCase('az-AZ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
}
function canonicalUrlKey(value='') {
  try {
    const u=new URL(String(value||''));
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|yclid$|ref$|source$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash='';
    return u.toString().replace(/\/$/,'');
  } catch { return String(value||'').trim(); }
}
function dedupe(items) {
  const seenUrl = new Set();
  const seenStory = new Set();
  return items.filter(x=>{
    const urlKey=canonicalUrlKey(x?.url||'');
    const titleKey=normalizeTitleKey(x?.title||'');
    const day=x?.published_at ? String(x.published_at).slice(0,10) : '';
    const storyKey=titleKey.length>=18 ? `${titleKey}|${day}` : '';
    if((urlKey && seenUrl.has(urlKey)) || (storyKey && seenStory.has(storyKey))) return false;
    if(urlKey) seenUrl.add(urlKey);
    if(storyKey) seenStory.add(storyKey);
    return Boolean(urlKey || storyKey);
  });
}
function rotate(items, count, salt='') {
  if (!Array.isArray(items) || !items.length || count <= 0) return [];
  const bucket = Math.floor(Date.now()/300000);
  let hash = 0;
  for (const c of String(salt)) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  const start = Math.abs(bucket + hash) % items.length;
  const out=[];
  for (let i=0;i<Math.min(count,items.length);i++) out.push(items[(start+i)%items.length]);
  return out;
}

function rotateSources(items, count, salt='') {
  if (!Array.isArray(items) || !items.length || count <= 0) return [];
  const bucket = Math.floor(Date.now()/(DIRECT_ONLY ? 45000 : 300000));
  let hash = 0;
  for (const c of String(salt)) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  const start = Math.abs(bucket * Math.max(1,count) + hash) % items.length;
  const out=[];
  for (let i=0;i<Math.min(count,items.length);i++) out.push(items[(start+i)%items.length]);
  return out;
}

function sourceShard(items=[]) {
  const rows=[...(Array.isArray(items)?items:[])].sort((a,b)=>String(a?.url||'').localeCompare(String(b?.url||'')));
  if (SOURCE_SHARD_COUNT <= 1) return rows;
  return rows.filter((_,index)=>index % SOURCE_SHARD_COUNT === SOURCE_SHARD_INDEX);
}

async function googleNews(query) {
  // GitHub runner-də 3 locale ardıcıl sorğu vaxtı uzadır və timeout riskini artırır.
  // Azərbaycan monitorinqi üçün discovery-ni AZ feed-dən edirik; geniş rayon sorğusu
  // nəticələri gətirir, aidiyyət filtri isə monitor-worker-də qalır.
  const locales = [ ['az','AZ','AZ:az'] ];
  const out=[]; const errors=[];
  for (const [hl,gl,ceid] of locales) {
    const u = new URL('https://news.google.com/rss/search');
    u.searchParams.set('q',query); u.searchParams.set('hl',hl); u.searchParams.set('gl',gl); u.searchParams.set('ceid',ceid);
    try {
      const xml = await fetchText(u.toString(),{timeoutMs:15000,retries:1,minGapMs:1400});
      const items = parseFeed(xml,'google_news',query,`Google News ${hl}-${gl}`);
      out.push(...items);
      // İlk locale real nəticə verirsə əlavə iki sorğu ilə Google-a yük vermirik.
      if (items.length >= 3) break;
    } catch (e) {
      errors.push(`${hl}-${gl}: ${e?.message||e}`);
      if (Number(e?.status||0) === 429) break;
    }
  }
  return {items:dedupe(out),errors};
}

async function bingNews(query, page = 0) {
  const variants = [ ['az','AZ'], ['tr','TR'], ['en','US'] ];
  const out=[];
  for (const [setlang,cc] of variants) {
    const u = new URL('https://www.bing.com/news/search');
    u.searchParams.set('q',query); u.searchParams.set('format','rss'); u.searchParams.set('setlang',setlang); u.searchParams.set('cc',cc);
    if (page > 0) u.searchParams.set('first', String(page * 10 + 1));
    try {
      const xml = await fetchText(u.toString(),{timeoutMs:13000,retries:0,minGapMs:900});
      const items = parseFeed(xml,'bing_news',query,`Bing News RSS ${setlang}-${cc}`);
      out.push(...items);
      if (items.length >= 5) break;
    } catch {}
  }
  return dedupe(out);
}

async function bingWeb(query, page = 0) {
  const u = new URL('https://www.bing.com/search');
  u.searchParams.set('q',query); u.searchParams.set('format','rss'); u.searchParams.set('setlang','az-AZ'); u.searchParams.set('cc','AZ');
  if (page > 0) u.searchParams.set('first', String(page * 10 + 1));
  try {
    const xml = await fetchText(u.toString(),{timeoutMs:13000,retries:0,minGapMs:900});
    return parseFeed(xml,'bing_web',query,'Bing Web RSS');
  } catch { return []; }
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m?.[1]) return decodeXml(m[1].trim());
  }
  return '';
}
function absoluteUrl(base, value='') {
  if (!value) return '';
  try { return new URL(decodeXml(value),base).toString(); } catch { return decodeXml(value); }
}
function jsonLdObjects(html='') {
  const out=[];
  for (const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed=JSON.parse(decodeXml(m[1]));
      const queue=Array.isArray(parsed)?[...parsed]:[parsed];
      while(queue.length){
        const x=queue.shift();
        if(!x||typeof x!=='object') continue;
        out.push(x);
        if(Array.isArray(x['@graph'])) queue.push(...x['@graph']);
      }
    } catch {}
  }
  return out;
}
function cleanArticleText(value='') {
  return stripHtml(String(value||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/p>/gi,'\n')).replace(/\s*\n\s*/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function paragraphText(html='') {
  const raw=String(html||'')
    .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi,' ');
  const candidates=[];
  const selectors=[
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<(?:div|section)\b[^>]*(?:class|id)=["'][^"']*(?:article|news|post|entry|story|detail|content|text|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi
  ];
  for(const re of selectors){
    for(const m of raw.matchAll(re)){
      const paras=[...m[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map(x=>cleanArticleText(x[1])).filter(x=>x.length>=35 && !/cookie|reklam|advert|abunə|subscribe/i.test(x));
      if(paras.length) candidates.push(paras.join('\n\n'));
    }
  }
  // Bəzi xəbər saytlarında məqalə nested div-lərlə qurulur və regex ilk bağlanan div-də
  // dayanır. Ona görə səhifədəki bütün real paraqraflardan ayrıca uzun namizəd də qururuq.
  const allParas=[...raw.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(x=>cleanArticleText(x[1]))
    .filter(x=>x.length>=35 && !/cookie|reklam|advert|abunə|subscribe|copyright|bütün hüquqlar/i.test(x));
  if(allParas.length) candidates.push([...new Set(allParas)].join('\n\n'));
  candidates.sort((a,b)=>b.length-a.length);
  return candidates[0]||'';
}
async function fetchPage(url,{timeoutMs=10000}={}) {
  await politeWait(650);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(url,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,*/*;q=0.8','accept-language':'az-AZ,az;q=0.9,tr;q=0.7,en;q=0.5'},signal:controller.signal,redirect:'follow'});
    if(!res.ok){const e=new Error(`HTTP ${res.status}`);e.status=res.status;throw e;}
    return {html:await res.text(),finalUrl:res.url||url};
  } finally {clearTimeout(timer);}
}
async function enrichPage(item) {
  if (!item?.url) return item;
  try {
    const {html,finalUrl}=await fetchPage(item.url,{timeoutMs:10000});
    const ld=jsonLdObjects(html);
    const articleLd=ld.find(x=>String(x?.['@type']||'').toLowerCase().includes('article')) || ld.find(x=>x?.articleBody) || {};
    const title = articleLd?.headline || firstMatch(html,[/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,/<title[^>]*>([\s\S]*?)<\/title>/i]);
    const desc = articleLd?.description || firstMatch(html,[/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i]);
    const body = cleanArticleText(articleLd?.articleBody || '') || paragraphText(html) || stripHtml(desc) || item.text || '';
    let image = '';
    if(typeof articleLd?.image==='string') image=articleLd.image;
    else if(Array.isArray(articleLd?.image)) image=typeof articleLd.image[0]==='string'?articleLd.image[0]:(articleLd.image[0]?.url||'');
    else if(articleLd?.image?.url) image=articleLd.image.url;
    if(!image) image=firstMatch(html,[/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i]);
    const published = articleLd?.datePublished || firstMatch(html,[/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+(?:name|itemprop)=["']datePublished["'][^>]+content=["']([^"']+)["']/i,/"datePublished"\s*:\s*"([^"]+)"/i]);
    const author = typeof articleLd?.author==='string' ? articleLd.author : (Array.isArray(articleLd?.author)?articleLd.author.map(x=>x?.name).filter(Boolean).join(', '):(articleLd?.author?.name||item.author||null));
    return {
      ...item,
      title:stripHtml(title)||item.title,
      text:String(body||item.text||'').slice(0,40000),
      image:absoluteUrl(finalUrl,image||item.image||'' )||null,
      published_at:normalizeDate(published)||item.published_at,
      author:author||item.author||null,
      raw:{...(item.raw||{}),enriched:true,canonical_url:finalUrl||item.url}
    };
  } catch { return item; }
}

async function fetchBinaryBase64(url) {
  if(!url) return null;
  await politeWait(500);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const res=await fetch(url,{headers:{'user-agent':UA,'accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8','referer':new URL(url).origin+'/'},signal:controller.signal,redirect:'follow'});
    if(!res.ok) return null;
    const type=(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!/^image\/(png|jpeg|webp)$/i.test(type)) return null;
    const buf=Buffer.from(await res.arrayBuffer());
    if(!buf.length || buf.length>2_500_000) return null;
    return {base64:buf.toString('base64'),mime_type:type};
  }catch{return null;} finally{clearTimeout(timer);}
}

function findChrome() {
  for (const bin of ['google-chrome','google-chrome-stable','chromium','chromium-browser']) {
    const r=spawnSync('which',[bin],{encoding:'utf8'});
    if (r.status===0 && r.stdout.trim()) return r.stdout.trim();
  }
  return '';
}

async function captureScreenshot(target) {
  const chrome=findChrome();
  if (!chrome || !target?.url) return null;
  const file=join(tmpdir(),`media-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const args=['--headless=new','--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1440,2400','--force-device-scale-factor=0.8',`--screenshot=${file}`,target.url];
  const r=spawnSync(chrome,args,{encoding:'utf8',timeout:25000});
  if (r.status!==0 || !existsSync(file)) return null;
  try {
    const base64=readFileSync(file).toString('base64');
    if (base64.length > 3_800_000) return null;
    return {base64,mime_type:'image/png'};
  } finally { try{unlinkSync(file)}catch{} }
}

async function gdeltNews(query) {
  if (Date.now() < gdeltBlockedUntil) return {items:[],skipped:'rate-limit-circuit'};
  const u = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  u.searchParams.set('query',query); u.searchParams.set('mode','artlist'); u.searchParams.set('maxrecords','50');
  u.searchParams.set('format','rssarchive'); u.searchParams.set('sort','datedesc'); u.searchParams.set('timespan','3months');
  try {
    const xml = await fetchText(u.toString(),{timeoutMs:18000,retries:0,minGapMs:6500});
    return {items:parseFeed(xml,'gdelt_article',query,'GDELT DOC 2.0')};
  } catch (e) {
    if (Number(e?.status||0) === 429) gdeltBlockedUntil = Date.now() + 15*60*1000;
    throw e;
  }
}

function isFeedLikeUrl(value='') {
  return /(?:\/feed\/?$|\/rss\/?$|\.xml(?:$|\?)|news\.google\.com\/rss\/)/i.test(String(value||''));
}
function domainFromUrl(value='') { try { return new URL(value).hostname.replace(/^www\./i,'').toLowerCase(); } catch { return ''; } }
function urlMatchesDomain(value='', domain='') {
  const host=domainFromUrl(value);
  const expected=String(domain||'').replace(/^www\./i,'').toLowerCase();
  return Boolean(host && expected && (host===expected || host.endsWith(`.${expected}`)));
}
function keepDomain(items=[], domain='') {
  return dedupe((Array.isArray(items)?items:[]).filter(item=>urlMatchesDomain(item?.url||'',domain)));
}
function buildDomainQueries(org, domain, keyword='') {
  const district=String(org?.district||'').trim();
  const cleanKeyword=String(keyword||'').replace(/["“”]+/g,' ').replace(/\s+/g,' ').trim();

  // Domen üzrə arxiv axtarışında əvvəlcə sadə rayon sorğusu işlədilir.
  // Əvvəlki yalnız çox sərt (rayon + böyük OR bloku / təsadüfi açar söz) sorğuları
  // Bing-də çox vaxt raw nəticə qaytarsa da konkret media domenindən exact=0 verirdi.
  // Sadə site:domain + rayon sorğusu həmin domenin Bərdə arxivini tapır; aidiyyət
  // (suvarma/meliorasiya və s.) yenə monitor-worker-də dəqiq filtrdən keçirilir.
  const districtOnly = district ? `site:${domain} "${district}"` : '';
  const topic = district
    ? `site:${domain} "${district}" (suvarma OR meliorasiya OR subartezian OR artezian OR drenaj OR kanal OR arx OR "su təchizatı" OR "su problemi")`
    : `site:${domain} (suvarma OR meliorasiya OR subartezian OR artezian OR drenaj OR kanal OR arx)`;
  // Açar söz bankındakı frazanı axtarış sisteminə bütöv dırnaq içində vermirik.
  // Məs: "Alaçadırlı artezian quyusu" yalnız eyni cümləni tapırdı; halbuki xəbərdə
  // "Alaçadırlıda yeni artezian quyusu qazılıb" yazıla bilər. Burada sözləri OR ilə
  // elastikləşdiririk, dəqiq aidiyyət qərarını isə monitor-worker lokal olaraq verir.
  const keywordParts = cleanKeyword
    .split(/\s+/)
    .map(x=>x.replace(/[^\p{L}\p{N}-]+/gu,'').trim())
    .filter(x=>x.length >= 4)
    .filter(x=>!district || asciiToken(x)!==asciiToken(district))
    .slice(0,4);
  const specific = keywordParts.length
    ? `site:${domain} ${district ? `"${district}" ` : ''}(${keywordParts.join(' OR ')})`
    : '';

  // Sadə rayon sorğusunu həmişə birinci saxlayırıq. 3 sorğudan artıq etmirik ki,
  // 5 paralel shard GitHub Actions vaxtını yenidən 10-15 dəqiqəyə çıxarmasın.
  return [...new Set([districtOnly,specific,topic].filter(Boolean))].slice(0,3);
}
function inferredOrgDomains(org) {
  const out=new Set();
  for (const source of (Array.isArray(org?.rss_sources)?org.rss_sources:[])) {
    const d=domainFromUrl(source?.url||''); if(d && !/google\.com$|bing\.com$/i.test(d)) out.add(d);
  }
  const district=String(org?.district||'').trim().toLocaleLowerCase('az-AZ')
    .replace(/ə/g,'e').replace(/ğ/g,'g').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ş/g,'s').replace(/ç/g,'c')
    .replace(/[^a-z0-9]+/g,'');
  const short=String(org?.short_name||'').toLocaleLowerCase('az-AZ');
  if(district && /sms[iıİI]{2}/i.test(short)) out.add(`${district}smsii.az`);
  return [...out];
}
function parseSitemap(xml='') {
  const urls=[];
  for (const m of String(xml).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const b=m[1]; const loc=stripHtml(tag(b,'loc')); if(!loc) continue;
    urls.push({url:loc,lastmod:normalizeDate(stripHtml(tag(b,'lastmod')))});
  }
  const indexes=[];
  for (const m of String(xml).matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc=stripHtml(tag(m[1],'loc')); if(loc) indexes.push(loc);
  }
  return {urls,indexes};
}
function linkItemsFromHtml(html='',base='') {
  const out=[];
  for (const m of String(html).matchAll(/<a\b[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href=absoluteUrl(base,m[1]); const title=stripHtml(m[2]);
    if(!href || !/^https?:/i.test(href) || title.length<12) continue;
    try { if(new URL(href).hostname!==new URL(base).hostname) continue; } catch { continue; }
    out.push({title,text:'',url:href,published_at:null,image:null,author:null,raw:{kind:'configured_site_link',provider:'Configured Web'}});
  }
  return dedupe(out).slice(0,120);
}
function advertisedFeedUrls(html='',base='') {
  const out=[];
  for (const m of String(html).matchAll(/<link\b[^>]*rel=["'][^"']*alternate[^"']*["'][^>]*>/gi)) {
    const tagText=m[0];
    if(!/application\/(?:rss\+xml|atom\+xml)|text\/xml/i.test(tagText)) continue;
    const href=tagText.match(/href=["']([^"']+)["']/i)?.[1]||'';
    const url=absoluteUrl(base,href);
    if(url && /^https?:/i.test(url)) out.push(url);
  }
  return [...new Set(out)].slice(0,2);
}

function asciiToken(value='') {
  return String(value||'').toLocaleLowerCase('az-AZ')
    .replace(/ə/g,'e').replace(/ğ/g,'g').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ş/g,'s').replace(/ç/g,'c')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}
function relevantSitemapUrl(url='', org={}) {
  const hay=asciiToken(url);
  const district=asciiToken(org?.district||'').replace(/\s+/g,'');
  const districtSpaced=asciiToken(org?.district||'');
  const locationHit=Boolean((district && hay.replace(/\s+/g,'').includes(district)) || (districtSpaced && hay.includes(districtSpaced)));
  const topicTokens=['suvarma','meliorasiya','subartezian','artezian','drenaj','kanal','arx','su teminati','su problemi','su catismamazligi','fermer','ekin'];
  return locationHit && topicTokens.some(t=>hay.includes(t));
}
function rotatingIndexes(indexes=[], count=8, salt='') {
  const preferred=indexes.filter(x=>/news|xeber|post|article|story/i.test(String(x||'')));
  const base=preferred.length>=count ? preferred : indexes;
  return rotate(base,count,`sitemap-${salt}`);
}
function configuredLinkIsRelevant(item, org) {
  const hay=asciiToken(`${item?.title||''} ${item?.url||''}`);
  const district=asciiToken(org?.district||'');
  const locationHit=!district || hay.includes(district);
  const topicTokens=['su','suvarma','meliorasiya','subartezian','artezian','drenaj','kanal','arx','fermer','ekin','su teminati','su problemi'];
  return locationHit && topicTokens.some(t=>hay.includes(t));
}

async function directWebsite(source, org) {
  const base=String(source?.url||'').trim(); if(!base) return [];
  const orgName=org?.short_name||org?.name||'Təşkilat';
  const out=[];
  try {
    const u=new URL(base); const origin=u.origin;

    // Sürətli 5 dəqiqəlik watch rejimində sitemap arxivlərini, 5 fərqli feed
    // ehtimalını və domen üzrə Bing axtarışını eyni run-da etmirik. Bu, əvvəlki
    // 10–15 dəqiqəlik run-ların növbəti cron tərəfindən ləğv olunmasının əsas səbəbi idi.
    // Fast watch yalnız ana səhifəni + bir RSS ehtimalını yoxlayır. Dərin arxiv scan
    // ayrıca saatlıq job-da qalır.
    if (DIRECT_ONLY) {
      let homepageHtml='';
      try {
        const {html}=await fetchPage(base,{timeoutMs:3000});
        homepageHtml=html;
        const links=linkItemsFromHtml(html,base);
        const relevant=links.filter(x=>configuredLinkIsRelevant(x,org));
        out.push(...relevant.slice(0,FAST_LINK_LIMIT));
      } catch {}

      // RSS ayrıca sources sətrində saxlanmasa da problem deyil: işlək saytların çoxu
      // ana səhifədə rel=alternate ilə real feed ünvanını elan edir. Sürətli watch onu
      // avtomatik tapıb oxuyur. Elan edilməyibsə yalnız bir ucuz /feed/ fallback sınanır.
      const feeds=homepageHtml ? advertisedFeedUrls(homepageHtml,base) : [];
      if(!feeds.length) feeds.push(`${origin}/feed/`);
      for(const feedUrl of feeds.slice(0,1)) {
        try {
          const xml=await fetchText(feedUrl,{timeoutMs:2500,retries:0,minGapMs:80});
          const items=parseFeed(xml,'configured_feed',orgName,source.name||source.platform||base);
          if(items.length){
            const relevant=items.filter(x=>configuredLinkIsRelevant(x,org));
            out.push(...relevant.slice(0,FAST_FEED_LIMIT));
          }
        } catch {}
      }
      return dedupe(out).slice(0,FAST_LINK_LIMIT + FAST_FEED_LIMIT);
    }

    const candidates=[`${origin}/sitemap.xml`,`${origin}/sitemap_index.xml`,`${origin}/sitemap-index.xml`];
    for (const sm of candidates) {
      try {
        const xml=await fetchText(sm,{timeoutMs:8000,retries:0,minGapMs:350});
        const parsed=parseSitemap(xml);
        let urls=[...parsed.urls];
        for(const idx of rotatingIndexes(parsed.indexes,6,`${org?.id||''}-${origin}`)){
          try{
            const nested=await fetchText(idx,{timeoutMs:6000,retries:0,minGapMs:300});
            urls.push(...parseSitemap(nested).urls);
          }catch{}
        }
        const relevant=urls.filter(row=>relevantSitemapUrl(row.url,org));
        const chosen=(relevant.length?relevant:urls)
          .sort((a,b)=>String(b.lastmod||'').localeCompare(String(a.lastmod||'')))
          .slice(0,relevant.length?80:24);
        for(const row of chosen) out.push({
          title:row.url.split('/').filter(Boolean).pop()?.replace(/[-_]+/g,' ')||row.url,
          text:'',url:row.url,published_at:row.lastmod||null,image:null,author:null,
          raw:{kind:'configured_site_sitemap',provider:source.name||'Configured Web'}
        });
        if(out.length) break;
      } catch {}
    }
    try {
      const {html}=await fetchPage(base,{timeoutMs:5500});
      const links=linkItemsFromHtml(html,base);
      const relevant=links.filter(x=>configuredLinkIsRelevant(x,org));
      out.push(...(relevant.length ? relevant.slice(0,20) : links.slice(0,8)));
    } catch {}
    for(const feedPath of ['/feed/','/rss/','/atom.xml']){
      try{
        const xml=await fetchText(`${origin}${feedPath}`,{timeoutMs:4500,retries:0,minGapMs:250});
        const items=parseFeed(xml,'configured_feed',orgName,source.name||source.platform||base);
        if(items.length){out.push(...items.slice(0,20));break;}
      }catch{}
    }
  } catch(e){ console.log(`[${orgName}] Birbaşa sayt discovery xəta: ${base} — ${e?.message||e}`); }
  return dedupe(out).slice(0,100);
}

async function directFeed(source, org) {
  if (!source?.url) return [];
  const orgName=org?.short_name||org?.name||'Təşkilat';
  if(!isFeedLikeUrl(source.url) && !/rss|atom/i.test(String(source.platform||''))) return directWebsite(source,org);
  try {
    const xml = await fetchText(source.url,{timeoutMs:15000,retries:1,minGapMs:1200});
    return parseFeed(xml,'configured_feed',orgName,source.name || source.platform || source.url);
  } catch (e) {
    console.log(`[${orgName}] Mənbə RSS xəta: ${source.url} — ${e?.message||e}`);
    return [];
  }
}

function shardQueryWindow(items, limit, shardIndex = 0, shardCount = 1) {
  const rows=[...new Set((Array.isArray(items)?items:[]).map(x=>String(x||'').trim()).filter(Boolean))];
  if (!rows.length || limit <= 0) return [];
  const count=Math.max(1,Number(shardCount)||1);
  const index=Math.max(0,Math.min(count-1,Number(shardIndex)||0));
  const bucket=Math.floor(Date.now()/(15*60*1000));
  const perCycle=Math.max(1,limit*count);
  const base=(bucket*perCycle + index*limit) % rows.length;
  const out=[];
  for(let i=0;i<Math.min(limit,rows.length);i++) out.push(rows[(base+i)%rows.length]);
  return out;
}

function logIngestSamples(orgName, label, result) {
  const samples = Array.isArray(result?.sample_results) ? result.sample_results : [];
  for (const sample of samples.slice(0,5)) {
    console.log(`[${orgName}] ${label} sample: ${sample.accepted?'ACCEPT':'REJECT'} | ${sample.reason||'-'} | ${String(sample.title||'').slice(0,120)}`);
  }
  const errs = Array.isArray(result?.errors) ? result.errors : [];
  for (const err of errs.slice(0,3)) console.log(`[${orgName}] ${label} ingest xəta: ${err?.message||JSON.stringify(err)}`);
}

let plan;
try {
  plan = await callMonitor({mode:'news_plan'}, 60000);
} catch (e) {
  if (e?.name === 'AbortError') {
    throw new Error('news_plan timeout: Supabase plan cavabı 60 saniyəni keçdi');
  }
  throw e;
}
if (!plan?.ok || !Array.isArray(plan.organizations)) throw new Error(`News plan alınmadı: ${JSON.stringify(plan).slice(0,800)}`);

let totalReceived=0, totalAccepted=0, totalRejected=0, totalInserted=0, totalFailures=0;
let gdeltUsedThisRun=false;

for (const org of plan.organizations) {
  // Yalnız 1-ci shard əvvəlki Web qeydlərini cari axtarılmamalı sözlərlə yenidən yoxlayır.
  // Beləliklə əvvəlki yumşaq filtrdən keçmiş uyğunsuz xəbərlər relevance_score=0 olur
  // və Monitorinq/Hesabat/Bildirişlər ekranından avtomatik çıxır.
  if (!DIRECT_ONLY && SOURCE_SHARD_INDEX === 0) {
    try {
      const cleaned = await callMonitor({mode:'news_refilter', organization_id:org.id}, 45000);
      if (cleaned?.ok) console.log(`[${org.short_name}] Web təmizləmə: checked=${cleaned.checked||0}, filtered_out=${cleaned.filtered_out||0}`);
      else console.log(`[${org.short_name}] Web təmizləmə buraxıldı: ${cleaned?.error||'naməlum xəta'}`);
    } catch (e) {
      console.log(`[${org.short_name}] Web təmizləmə xəta: ${e?.message||e}`);
    }
  }
  const allGoogle = Array.isArray(org.google_queries) ? org.google_queries.filter(Boolean) : [];
  const keywordBank = Array.isArray(org.keyword_queries) ? org.keyword_queries.filter(Boolean) : [];
  // Planın ilk 3 sorğusu həmişəlik əsas discovery sorğularıdır:
  // 1) rayonun özü (geniş discovery), 2) rayon + suvarma, 3) rayon + subartezian.
  // Qalan sorğulardan yalnız biri rotasiya olunur. Beləliklə hər manual run-da real
  // rayon xəbəri tapmaq şansı yüksəkdir və dar təşkilat adı nəticəni sıfırlamır.
  const broadDistrict = allGoogle[0] ? [allGoogle[0]] : [];
  const topicCore = allGoogle.slice(1,3);
  const rotatingQueries = allGoogle.slice(3);
  // Hər run-da daha çox mövzu dövr etdirilir. Bununla eyni 30-40 nəticənin içində
  // qalmırıq; 5 dəqiqəlik rotasiya ilə 28 sorğulu bank mərhələli şəkildə taranır.
  const azDomainQueries = org.district ? [`site:.az \"${org.district}\" suvarma`,`site:.az \"${org.district}\" meliorasiya`,`site:.az \"${org.district}\" kanal`] : [];
  const directDomainQueries=inferredOrgDomains(org).flatMap(domain=>[`site:${domain} suvarma`,`site:${domain} meliorasiya`,`site:${domain} ${org.district||''}`]).filter(Boolean);
  const districtName=String(org.district||'').trim();
  const discoveryCore=districtName ? [
    `\"${districtName}\" su`, `\"${districtName}\" suvarma`, `\"${districtName}\" meliorasiya`,
    `\"${districtName}\" kanal`, `\"${districtName}\" subartezian`, `\"${districtName}\" artezian`,
    `\"${districtName}\" fermer su`, `\"${districtName}\" əkin su`, `\"${districtName}\" su təchizatı`
  ] : [];
  const keywordQueries = shardQueryWindow(keywordBank, Math.max(BROAD_QUERY_LIMIT, 8), SOURCE_SHARD_INDEX, SOURCE_SHARD_COUNT);
  // Əvvəlki variantda bütün 5 shard faktiki olaraq eyni 1-2 geniş sorğunu işlədirdi.
  // Buna görə eyni köhnə 5 xəbər təkrar tapılır, yeni material tapılsa belə çox vaxt
  // dublikat kimi insert olunmurdu. İndi hər shard rayon+mövzu və açar-söz bankının
  // fərqli hissəsini işləyir. Beləliklə 5 paralel job real olaraq 5 ayrı discovery
  // pəncərəsi olur və arxiv mərhələli şəkildə genişlənir.
  const shardDiscoveryPool = [...new Set([
    ...discoveryCore,
    ...topicCore,
    ...rotatingQueries,
    ...keywordQueries,
    ...azDomainQueries,
    ...directDomainQueries
  ].filter(Boolean))];
  const webQueries = DIRECT_ONLY ? [] : shardQueryWindow(
    shardDiscoveryPool,
    Math.max(1,BROAD_QUERY_LIMIT),
    SOURCE_SHARD_INDEX,
    SOURCE_SHARD_COUNT
  ).slice(0,Math.max(1,BROAD_QUERY_LIMIT));
  // Google News də shard üzrə fərqli sorğular görür. Əsas rayon sorğusu qorunur,
  // ikinci/üçüncü sorğular isə həmin shard-ın açar söz pəncərəsindən seçilir.
  const googleQueries = DIRECT_ONLY ? [] : [...new Set([
    ...(broadDistrict.length ? broadDistrict : topicCore.slice(0,1)),
    ...shardQueryWindow([...rotatingQueries,...keywordQueries], 3, SOURCE_SHARD_INDEX, SOURCE_SHARD_COUNT)
  ].filter(Boolean))].slice(0,4);
  console.log(`[${org.short_name}] Açar söz bankı: ${Number(org.keyword_count||keywordBank.length)} aktiv | bu shard: ${keywordQueries.length} sorğu`);
  console.log(`[${org.short_name}] Web discovery sorğuları: ${webQueries.join(' || ')}`);
  console.log(`[${org.short_name}] Google News sorğuları: ${googleQueries.join(' || ')}`);

  const googleItems=[];
  const broadWebItems=[];
  const domainWebItems=[];
  const directWebItems=[];
  const configuredSources=[...(Array.isArray(org.rss_sources)?org.rss_sources:[])];
  for(const domain of inferredOrgDomains(org)){
    if(!configuredSources.some(x=>domainFromUrl(x?.url||'')===domain)) configuredSources.push({platform:'Web',url:`https://${domain}/`,name:`${domain} birbaşa sayt`});
  }
  const allowedDomains=[...new Set(configuredSources.map(x=>domainFromUrl(x?.url||'')).filter(Boolean))];
  const itemDomain=(item={})=>{
    const direct=domainFromUrl(item?.url||'');
    if(direct && !/^(?:news\.)?google\./i.test(direct)) return direct;
    return domainFromUrl(item?.raw?.source_url||'');
  };
  const keepConfiguredDomainItems=(items=[])=>dedupe((Array.isArray(items)?items:[]).filter(item=>{
    const host=itemDomain(item);
    return host && allowedDomains.some(domain=>host===domain || host.endsWith(`.${domain}`));
  }));

  // Arxiv discovery yalnız 140 əl ilə konfiqurasiya olunmuş domenlə məhdudlaşmır.
  // Azərbaycan media nəticələri (.az) və ayrıca konfiqurasiya olunmuş domenlər qəbul
  // hovuzuna düşür; real aidiyyət qərarını Supabase-dəki rayon/kənd + mövzu filtri verir.
  // Bu, axtarış mühərrikində tapılan düzgün Bərdə xəbərlərinin sırf sources cədvəlində
  // həmin domen olmadığı üçün itirilməsinin qarşısını alır.
  const keepDiscoveryItems=(items=[])=>dedupe((Array.isArray(items)?items:[]).filter(item=>{
    const host=itemDomain(item);
    if(!host) return false;
    if(allowedDomains.some(domain=>host===domain || host.endsWith(`.${domain}`))) return true;
    return host.endsWith('.az') || host==='az';
  }));

  // Arxiv discovery aktiv açar söz bankının shard-a düşən frazalarını da Google News-də yoxlayır.
  // Discovery genişdir; qəbul mərhələsi isə sərt rayon/kənd + mövzu filtri ilə qorunur.
  const keywordGoogleQueries = DIRECT_ONLY ? [] : keywordQueries.slice(0,8);
  const allGoogleQueries=[...new Set([...googleQueries,...keywordGoogleQueries])].slice(0,10);
  if(!DIRECT_ONLY) for (const q of allGoogleQueries) {
    try {
      const g = await googleNews(q);
      googleItems.push(...keepDiscoveryItems(g.items));
      if (g.errors.length) console.log(`[${org.short_name}] Google locale xətaları (${q}): ${g.errors.join(' | ')}`);
    } catch (e) {
      totalFailures++; console.log(`[${org.short_name}] Google News xəta (${q}):`, e?.message||e);
    }
  }
  if(!DIRECT_ONLY) for (const q of webQueries) {
    try {
      // Arxiv run-da ilk səhifə ilə kifayətlənmək eyni populyar nəticələrin təkrar
      // düşməsinə səbəb olurdu. Hər shard fərqli sorğu işlədiyi üçün 3 səhifəyə qədər
      // oxumaq artıq həm təhlükəsizdir, həm də köhnə materialları tapma şansını artırır.
      for (let page=0; page<3; page++) {
        broadWebItems.push(...keepDiscoveryItems(await bingNews(q,page)));
        broadWebItems.push(...keepDiscoveryItems(await bingWeb(q,page)));
      }
    } catch (e) { totalFailures++; console.log(`[${org.short_name}] Bing discovery xəta (${q}):`, e?.message||e); }
  }

  const shardPool=sourceShard(configuredSources);
  const sourceBatch = shardPool.length <= SOURCE_BATCH_SIZE
    ? shardPool
    : rotateSources(shardPool, SOURCE_BATCH_SIZE, `sources-${org.id}-shard-${SOURCE_SHARD_INDEX}`);
  console.log(`[${org.short_name}] Birbaşa mənbə paketi: ${sourceBatch.length}/${configuredSources.length} | shard ${SOURCE_SHARD_INDEX+1}/${SOURCE_SHARD_COUNT} (${shardPool.length} mənbə)`);
  // Fast-watch ana səhifə + avtomatik RSS ilə canlı dəyişiklikləri tutur. Orada
  // ayrıca Bing site:domain axtarışı həm vaxt aparır, həm də çox vaxt exact=0 qaytarır.
  // Domen axtarışı yalnız arxiv job-da işləyir.
  const targetedSources=!DIRECT_ONLY && DOMAIN_SEARCH_BATCH > 0
    ? (sourceBatch.length <= DOMAIN_SEARCH_BATCH ? sourceBatch : rotateSources(sourceBatch, DOMAIN_SEARCH_BATCH, `domain-search-${org.id}-shard-${SOURCE_SHARD_INDEX}`))
    : [];
  for (const source of targetedSources) {
    const domain=domainFromUrl(source?.url||'');
    if(!domain || !org.district) continue;
    const sourceIndex = targetedSources.indexOf(source);
    const keywordOffset = Math.floor(Date.now()/(15*60*1000)) * Math.max(1, targetedSources.length * SOURCE_SHARD_COUNT)
      + SOURCE_SHARD_INDEX * Math.max(1, targetedSources.length) + Math.max(0, sourceIndex);
    const scopedKeyword = keywordBank.length ? keywordBank[keywordOffset % keywordBank.length] : '';
    const queries=buildDomainQueries(org,domain,scopedKeyword);
    let found=[];
    for (let qi=0; qi<queries.length; qi++) {
      try {
        // Bing Web RSS bir sıra Azərbaycan media domenlərində site: filtrini zəif
        // tətbiq edir və raw=10 olsa da exact=0 qalır. Eyni sorğunu Bing News RSS-də
        // də yoxlayırıq; news nəticələri publisher URL-ni verdiyi üçün real xəbər
        // arxivini tapmaq ehtimalı xeyli artır.
        const [newsRaw,webRaw]=await Promise.all([
          bingNews(queries[qi],0).catch(()=>[]),
          bingWeb(queries[qi],0).catch(()=>[])
        ]);
        const raw=dedupe([...(newsRaw||[]),...(webRaw||[])]);
        const exact=keepDomain(raw,domain);
        found.push(...exact);
        console.log(`[${org.short_name}] Domen axtarışı: ${domain} | ${qi+1}/${queries.length} | news=${newsRaw.length} web=${webRaw.length} exact=${exact.length} | ${queries[qi]}`);
        if(dedupe(found).length >= 4) break;
      } catch(e) {
        console.log(`[${org.short_name}] Domen axtarışı xəta (${domain}): ${e?.message||e}`);
      }
    }
    domainWebItems.push(...dedupe(found));
  }
  for (const source of sourceBatch) {
    const domain=domainFromUrl(source?.url||'');
    const items = keepDomain(await directFeed(source,org),domain);
    if (/google/i.test(`${source.platform||''} ${source.name||''} ${source.url||''}`)) googleItems.push(...items);
    else directWebItems.push(...items);
  }

  // Birbaşa sayt/RSS/sitemap nəticələri əvvəl gəlir ki, geniş axtarış nəticələri ingest limitini doldurmasın.
  const unifiedWebItems=dedupe([
    ...directWebItems,
    ...domainWebItems,
    ...googleItems,
    ...broadWebItems
  ]).slice(0,MAX_INGEST_ITEMS);
  console.log(`[${org.short_name}] Web namizədlər: direct=${directWebItems.length} domain=${domainWebItems.length} google=${googleItems.length} broad=${broadWebItems.length} unified=${unifiedWebItems.length}`);

  const batches = [
    {platform:'Web',label:'Web / Xəbər — Google News + Bing + RSS / GitHub Gateway',items:unifiedWebItems}
  ];

  for (const batch of batches) {
    if (!batch.items.length) {
      console.log(`[${org.short_name}] ${batch.label}: 0 material`);
      continue;
    }
    // 5-10 min açar söz bankı ilə yüzlərlə materialı bir Edge Function çağırışına
    // vermək Supabase WORKER_RESOURCE_LIMIT yaradır. Materialları kiçik paketlərlə
    // göndəririk; bütün namizədlər yenə yoxlanılır, sadəcə hər invocation yüngülləşir.
    const result = await ingestInChunks({org,platform:batch.platform,label:batch.label,items:batch.items});
    totalReceived += Number(result?.received||0);
    totalAccepted += Number(result?.accepted||0);
    totalRejected += Number(result?.rejected||0);
    totalInserted += Number(result?.inserted||0);
    console.log(`[${org.short_name}] ${batch.label}: received=${result?.received||0}, accepted=${result?.accepted||0}, rejected=${result?.rejected||0}, inserted=${result?.inserted||0}`);
    logIngestSamples(org.short_name,batch.label,result);

    // Yalnız filtrdən keçmiş materialların öz səhifəsini açıb tam mətni, tarix/müəllif
    // və əsas xəbər şəklini dəqiqləşdiririk. Beləliklə axtarış snippet-i orijinal mətn kimi saxlanmır.
    const acceptedTargets=Array.isArray(result?.accepted_targets)?result.accepted_targets:[];
    const screenshotFallback=[];
    for (const target of acceptedTargets.slice(0,MAX_ENRICH_ITEMS)) {
      const enriched=await enrichPage({title:target.title||'',text:target.text||'',url:target.url,published_at:target.published_at||null,image:target.image||null,author:target.author||null,raw:target.raw||{}});
      try {
        const refreshed=await callMonitor({
          mode:'news_enrich', organization_id:org.id, source_url:target.url,
          title:enriched.title||target.title||'', text:enriched.text||target.text||'',
          image_url:enriched.image||'', published_at:enriched.published_at||target.published_at||null,
          author:enriched.author||null, canonical_url:enriched.raw?.canonical_url||target.url
        });
        if(!refreshed?.ok) console.log(`[${org.short_name}] Tam mətn yenilənmədi: ${refreshed?.error||target.url}`);
      } catch(e) { console.log(`[${org.short_name}] Tam mətn yeniləmə xətası: ${e?.message||e}`); }

      let archivedImage=false;
      if(enriched.image){
        const media=await fetchBinaryBase64(enriched.image);
        if(media){
          try{
            const saved=await callMonitor({mode:'news_media',organization_id:org.id,source_url:target.url,image_base64:media.base64,mime_type:media.mime_type,media_type:'preview'});
            archivedImage=Boolean(saved?.ok && (saved?.saved || saved?.skipped==='already-exists'));
            console.log(`[${org.short_name}] Xəbər şəkli: ${archivedImage?'SAXLANDI':'buraxıldı'} | ${String(enriched.title||target.title||'').slice(0,100)}`);
          }catch(e){console.log(`[${org.short_name}] Xəbər şəkli upload xətası: ${e?.message||e}`);}
        }
      }
      if(!archivedImage) screenshotFallback.push({...target,title:enriched.title||target.title||'',original_url:target.url,capture_url:enriched.raw?.canonical_url||target.url,url:target.url});
    }

    // Xəbər şəkli yoxdursa arxiv screenshot saxlanılır. Hər run-da limit var; növbəti run
    // screenshot-u olmayan növbəti materialları tamamlayacaq.
    for (const target of screenshotFallback.slice(0,MAX_SCREENSHOTS)) {
      const shot=await captureScreenshot({...target,url:target.capture_url||target.url});
      if (!shot) { console.log(`[${org.short_name}] Screenshot alınmadı: ${String(target?.url||'').slice(0,120)}`); continue; }
      try {
        const saved=await callMonitor({mode:'news_media',organization_id:org.id,source_url:target.original_url||target.url,image_base64:shot.base64,mime_type:shot.mime_type,media_type:'screenshot'});
        console.log(`[${org.short_name}] Screenshot: ${saved?.ok && saved?.saved ? 'SAXLANDI' : (saved?.skipped||saved?.error||'buraxıldı')} | ${String(target?.title||target?.url||'').slice(0,100)}`);
      } catch(e) { console.log(`[${org.short_name}] Screenshot upload xəta: ${e?.message||e}`); }
    }
  }
}

console.log(`NEWS_GATEWAY_SUMMARY received=${totalReceived} accepted=${totalAccepted} rejected=${totalRejected} inserted=${totalInserted} fetch_failures=${totalFailures}`);
