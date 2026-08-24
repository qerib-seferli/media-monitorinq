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

async function callMonitor(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
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
function parseFeed(xml, rawKind, discoveryQuery, provider) {
  const rssBlocks = [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
  const atomBlocks = rssBlocks.length ? [] : [...String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(m=>m[1]);
  const blocks = rssBlocks.length ? rssBlocks : atomBlocks;
  const atom = !rssBlocks.length && atomBlocks.length > 0;
  return blocks.map(block=>{
    const title = stripHtml(tag(block,'title'));
    let url = atom ? (attr(block,'link','href') || stripHtml(tag(block,'link'))) : stripHtml(tag(block,'link'));
    if (!url) url = stripHtml(tag(block,'guid')) || stripHtml(tag(block,'id'));
    const description = stripHtml(tag(block, atom ? 'summary' : 'description') || tag(block,'content'));
    const pub = stripHtml(tag(block,'pubDate') || tag(block,'published') || tag(block,'updated'));
    const source = stripHtml(tag(block,'source') || tag(block,'author'));
    const enclosure = attr(block,'enclosure','url') || attr(block,'media:content','url') || attr(block,'media:thumbnail','url') || (tag(block, atom ? 'summary' : 'description').match(/<img[^>]+src=[\"']([^\"']+)[\"']/i)?.[1] || null);
    return {
      title,
      text: description,
      url,
      published_at: normalizeDate(pub),
      image: enclosure,
      author: source || null,
      raw: {kind:rawKind,provider,discovery_query:discoveryQuery}
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
  if(!candidates.length){
    const paras=[...raw.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(x=>cleanArticleText(x[1])).filter(x=>x.length>=45 && !/cookie|reklam|advert|abunə|subscribe/i.test(x));
    if(paras.length) candidates.push(paras.join('\n\n'));
  }
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
  const args=['--headless=new','--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1200,760',`--screenshot=${file}`,target.url];
  const r=spawnSync(chrome,args,{encoding:'utf8',timeout:25000});
  if (r.status!==0 || !existsSync(file)) return null;
  try {
    const base64=readFileSync(file).toString('base64');
    if (base64.length > 1_600_000) return null;
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

async function directFeed(source, orgName) {
  if (!source?.url) return [];
  try {
    const xml = await fetchText(source.url,{timeoutMs:15000,retries:1,minGapMs:1200});
    return parseFeed(xml,'configured_feed',orgName,source.name || source.platform || source.url);
  } catch (e) {
    console.log(`[${orgName}] Mənbə RSS xəta: ${source.url} — ${e?.message||e}`);
    return [];
  }
}

function logIngestSamples(orgName, label, result) {
  const samples = Array.isArray(result?.sample_results) ? result.sample_results : [];
  for (const sample of samples.slice(0,5)) {
    console.log(`[${orgName}] ${label} sample: ${sample.accepted?'ACCEPT':'REJECT'} | ${sample.reason||'-'} | ${String(sample.title||'').slice(0,120)}`);
  }
  const errs = Array.isArray(result?.errors) ? result.errors : [];
  for (const err of errs.slice(0,3)) console.log(`[${orgName}] ${label} ingest xəta: ${err?.message||JSON.stringify(err)}`);
}

const plan = await callMonitor({mode:'news_plan'});
if (!plan?.ok || !Array.isArray(plan.organizations)) throw new Error(`News plan alınmadı: ${JSON.stringify(plan).slice(0,800)}`);

let totalReceived=0, totalAccepted=0, totalRejected=0, totalInserted=0, totalFailures=0;
let gdeltUsedThisRun=false;

for (const org of plan.organizations) {
  const allGoogle = Array.isArray(org.google_queries) ? org.google_queries.filter(Boolean) : [];
  // Planın ilk 3 sorğusu həmişəlik əsas discovery sorğularıdır:
  // 1) rayonun özü (geniş discovery), 2) rayon + suvarma, 3) rayon + subartezian.
  // Qalan sorğulardan yalnız biri rotasiya olunur. Beləliklə hər manual run-da real
  // rayon xəbəri tapmaq şansı yüksəkdir və dar təşkilat adı nəticəni sıfırlamır.
  const broadDistrict = allGoogle[0] ? [allGoogle[0]] : [];
  const topicCore = allGoogle.slice(1,3);
  const rotatingQueries = allGoogle.slice(3);
  // Hər run-da daha çox mövzu dövr etdirilir. Bununla eyni 30-40 nəticənin içində
  // qalmırıq; 5 dəqiqəlik rotasiya ilə 28 sorğulu bank mərhələli şəkildə taranır.
  const webQueries = [...new Set([...broadDistrict,...topicCore,...rotate(rotatingQueries,7,org.id)])].slice(0,10);
  // Google News ayrıca istifadəçi platforması deyil, discovery provider-dir. Burada
  // yalnız iki yüksək siqnallı sorğu saxlayırıq və tapılan nəticələri Web axınına qatırıq.
  const googleQueries=[...new Set([...topicCore.slice(0,1),...rotate(rotatingQueries,1,`google-${org.id}`)])].slice(0,2);
  console.log(`[${org.short_name}] Web discovery sorğuları: ${webQueries.join(' || ')}`);
  console.log(`[${org.short_name}] Google News sorğuları: ${googleQueries.join(' || ')}`);

  const googleItems=[];
  const webItems=[];

  for (const q of googleQueries) {
    try {
      const g = await googleNews(q);
      googleItems.push(...g.items);
      if (g.errors.length) console.log(`[${org.short_name}] Google locale xətaları (${q}): ${g.errors.join(' | ')}`);
    } catch (e) {
      totalFailures++; console.log(`[${org.short_name}] Google News xəta (${q}):`, e?.message||e);
    }
  }
  for (const q of webQueries) {
    try {
      const qi=webQueries.indexOf(q);
      webItems.push(...await bingNews(q,0));
      webItems.push(...await bingWeb(q,0));
      if (qi < 4) {
        webItems.push(...await bingNews(q,1));
        webItems.push(...await bingWeb(q,1));
      }
      if (qi < 2) {
        webItems.push(...await bingNews(q,2));
        webItems.push(...await bingWeb(q,2));
      }
    } catch (e) { totalFailures++; console.log(`[${org.short_name}] Bing discovery xəta (${q}):`, e?.message||e); }
  }

  // Admin paneldə əl ilə əlavə olunan normal RSS/Atom feed-ləri birbaşa oxu.
  for (const source of (Array.isArray(org.rss_sources)?org.rss_sources:[]).slice(0,12)) {
    const items = await directFeed(source,org.short_name);
    if (/google/i.test(`${source.platform||''} ${source.name||''} ${source.url||''}`)) googleItems.push(...items);
    else webItems.push(...items);
  }

  // GDELT shared public endpoint-i GitHub runner-lərdə 429 verə bilir. Bir run-da
  // yalnız bir təşkilat üçün, başqa lane-lər az material verəndə ehtiyat kimi sınanır.
  if (false && !gdeltUsedThisRun && (googleItems.length + webItems.length) < 12) {
    const q = rotate(org.gdelt_queries || [],1,`gdelt-${org.id}`)[0];
    if (q) {
      gdeltUsedThisRun=true;
      try {
        const gd = await gdeltNews(q);
        webItems.push(...(gd.items||[]));
        if (gd.skipped) console.log(`[${org.short_name}] GDELT buraxıldı: ${gd.skipped}`);
      } catch (e) {
        totalFailures++; console.log(`[${org.short_name}] GDELT xəta:`, e?.message||e);
      }
    }
  }

  // Search nəticələrinin öz snippet-i bəzən çox zəif olur. İlk namizədlərin səhifə
  // metadata-sını (og:title/description/image/datePublished) götürərək tarix və preview-ni dəqiqləşdiririk.
  // Google News burada yalnız kəşf mənbəyidir. Eyni xəbər Google News, Bing News,
  // Bing Web və birbaşa RSS-dən eyni anda gələ bildiyi üçün bütün discovery nəticələri
  // ingest-dən ƏVVƏL bir Web axınında birləşdirilir və başlıq+tarix/URL ilə təkrarsızlaşdırılır.
  const unifiedWebItems=dedupe([...googleItems,...webItems]).slice(0,420);

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
    for (const target of acceptedTargets.slice(0,32)) {
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
    for (const target of screenshotFallback.slice(0,6)) {
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
