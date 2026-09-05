const MONITOR_URL = process.env.MONITOR_URL || 'https://xsmahlsqdszxqordgcvt.supabase.co/functions/v1/monitor-worker';
const MONITOR_SECRET = process.env.MONITOR_SECRET || '';
const RADAR_SCAN_ID = String(process.env.RADAR_SCAN_ID || '').trim();
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
const DEEP_BACKFILL = ['1','true','yes'].includes(String(process.env.NEWS_DEEP_BACKFILL || '').toLowerCase());
const RECENT_PRIORITY = ['1','true','yes'].includes(String(process.env.NEWS_RECENT_PRIORITY || '').toLowerCase());
const REFILTER_EXISTING = ['1','true','yes'].includes(String(process.env.NEWS_REFILTER_EXISTING || '').toLowerCase());
const FULL_RADAR = ['1','true','yes'].includes(String(process.env.NEWS_FULL_RADAR || '').toLowerCase());
const QUERY_PASS_COUNT = Math.max(1, Math.min(12, Number(process.env.NEWS_QUERY_PASS_COUNT || 1)));
const QUERY_PASS = Math.max(0, Math.min(QUERY_PASS_COUNT - 1, Number(process.env.NEWS_QUERY_PASS || 0)));
const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_RECENT_YEAR_START = Math.max(2000, CURRENT_YEAR - 2);
const ARCHIVE_YEAR_START = Math.max(2000, Math.min(CURRENT_YEAR, Number(process.env.NEWS_ARCHIVE_YEAR_START || (RECENT_PRIORITY ? DEFAULT_RECENT_YEAR_START : 2000))));
const ARCHIVE_YEAR_END = Math.max(ARCHIVE_YEAR_START, Math.min(CURRENT_YEAR, Number(process.env.NEWS_ARCHIVE_YEAR_END || (RECENT_PRIORITY ? CURRENT_YEAR : CURRENT_YEAR))));
const BING_PAGE_LIMIT = Math.max(1, Math.min(10, Number(process.env.NEWS_BING_PAGE_LIMIT || (DEEP_BACKFILL ? 6 : 3))));
const SOURCE_BATCH_SIZE = Math.max(4, Math.min(40, Number(process.env.NEWS_SOURCE_BATCH || (DIRECT_ONLY ? 24 : 8))));
const DOMAIN_SEARCH_BATCH = Math.max(0, Math.min(SOURCE_BATCH_SIZE, Number(process.env.NEWS_DOMAIN_SEARCH_BATCH ?? (DIRECT_ONLY ? 0 : 6))));
const BROAD_QUERY_LIMIT = Math.max(0, Math.min(FULL_RADAR ? 24 : 12, Number(process.env.NEWS_BROAD_QUERY_LIMIT ?? (DIRECT_ONLY ? 0 : FULL_RADAR ? 18 : 2))));
const FAST_LINK_LIMIT = Math.max(4, Math.min(20, Number(process.env.NEWS_FAST_LINK_LIMIT || 8)));
const FAST_FEED_LIMIT = Math.max(4, Math.min(20, Number(process.env.NEWS_FAST_FEED_LIMIT || 10)));
const MAX_INGEST_ITEMS = Math.max(20, Math.min(400, Number(process.env.NEWS_MAX_INGEST_ITEMS || (DIRECT_ONLY ? 90 : 160))));
const MAX_ENRICH_ITEMS = Math.max(4, Math.min(80, Number(process.env.NEWS_MAX_ENRICH_ITEMS || 80)));
const MAX_SCREENSHOTS = Math.max(0, Math.min(24, Number(process.env.NEWS_MAX_SCREENSHOTS ?? 24)));
const SITEMAP_FOCUS = ['1','true','yes'].includes(String(process.env.NEWS_SITEMAP_FOCUS || '').toLowerCase());
const SITEMAP_INDEX_LIMIT = Math.max(2, Math.min(20, Number(process.env.NEWS_SITEMAP_INDEX_LIMIT || (RECENT_PRIORITY ? 10 : DEEP_BACKFILL ? 8 : 5))));
const SITEMAP_URL_LIMIT = Math.max(40, Math.min(1200, Number(process.env.NEWS_SITEMAP_URL_LIMIT || (RECENT_PRIORITY ? 700 : DEEP_BACKFILL ? 450 : 140))));
const SITEMAP_PROBE_LIMIT = Math.max(0, Math.min(120, Number(process.env.NEWS_SITEMAP_PROBE_LIMIT || (RECENT_PRIORITY ? 50 : DEEP_BACKFILL ? 30 : 0))));
const SOURCE_SHARD_COUNT = Math.max(1, Math.min(20, Number(process.env.NEWS_SOURCE_SHARD_COUNT || 1)));
const SOURCE_SHARD_INDEX = Math.max(0, Math.min(SOURCE_SHARD_COUNT - 1, Number(process.env.NEWS_SOURCE_SHARD_INDEX || 0)));
const GLOBAL_ORGS = ['1','true','yes'].includes(String(process.env.NEWS_GLOBAL_ORGS || '').toLowerCase());
const ORG_SHARD_COUNT = Math.max(1, Math.min(20, Number(process.env.NEWS_ORG_SHARD_COUNT || SOURCE_SHARD_COUNT || 1)));
const ORG_SHARD_INDEX = Math.max(0, Math.min(ORG_SHARD_COUNT - 1, Number(process.env.NEWS_ORG_SHARD_INDEX ?? SOURCE_SHARD_INDEX ?? 0)));
const ORG_BATCH = Math.max(0, Math.min(20, Number(process.env.NEWS_ORG_BATCH || 0)));
const ROTATION_MINUTES = Math.max(5, Math.min(360, Number(process.env.NEWS_ORG_ROTATION_MINUTES || 15)));
const ORG_ROTATION_BUCKET = process.env.NEWS_ORG_ROTATION_BUCKET !== undefined ? Math.max(0,Number(process.env.NEWS_ORG_ROTATION_BUCKET||0)) : Math.floor(Date.now() / (ROTATION_MINUTES * 60 * 1000));
const GATEWAY_STARTED_AT = Date.now();
const GATEWAY_BUDGET_MS = Math.max(60_000, Math.min(1_800_000, Number(process.env.NEWS_GATEWAY_BUDGET_MS || 0))) || 0;
const GATEWAY_SAFETY_MS = 20_000;
function gatewayBudgetLow() {
  return GATEWAY_BUDGET_MS > 0 && (Date.now() - GATEWAY_STARTED_AT) >= Math.max(1_000, GATEWAY_BUDGET_MS - GATEWAY_SAFETY_MS);
}

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

async function callMonitor(body, timeoutMs = 35000, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
      if (!res.ok) {
        const err = new Error(`monitor-worker HTTP ${res.status}: ${text.slice(0,500)}`);
        err.status = res.status;
        err.retryAfter = Number(res.headers.get('retry-after') || 0);
        throw err;
      }
      return data;
    } catch (e) {
      lastError = e;
      const status = Number(e?.status || 0);
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 546 || e?.name === 'AbortError';
      if (!retryable || attempt >= retries) throw e;
      const retryAfterMs = Number(e?.retryAfter || 0) * 1000;
      // Supabase 546 / WORKER_RESOURCE_LIMIT qısa müddətli compute sıxlığıdır.
      // Dərhal job-u qırmızı etməzdən əvvəl bir az daha uzun fasilə verib eyni kiçik paketi təkrar yoxlayırıq.
      const resourceDelay = status === 546 ? 5000 * (attempt + 1) : 0;
      const delay = Math.max(retryAfterMs, resourceDelay, 1800 * (attempt + 1));
      console.log(`monitor-worker müvəqqəti xəta (${status || e?.name || 'network'}), təkrar cəhd ${attempt+2}/${retries+1}...`);
      await sleep(Math.min(delay, 6500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('monitor-worker çağırışı uğursuz oldu');
}

function chunks(items, size = 10) {
  const rows = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function ingestInChunks({org, platform, label, items}) {
  const pieces = chunks(items, 6);
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
  const named={nbsp:' ',ouml:'ö',Ouml:'Ö',uuml:'ü',Uuml:'Ü',auml:'ä',Auml:'Ä',ccedil:'ç',Ccedil:'Ç',szlig:'ß',ldquo:'“',rdquo:'”',lsquo:'‘',rsquo:'’',ndash:'–',mdash:'—',hellip:'…'};
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&([A-Za-z]+);/g,(m,n)=>Object.prototype.hasOwnProperty.call(named,n)?named[n]:m)
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
  const raw=String(value).trim();
  const months={yanvar:1,fevral:2,mart:3,aprel:4,may:5,iyun:6,iyul:7,avqust:8,sentyabr:9,oktyabr:10,noyabr:11,dekabr:12,january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const folded=raw.toLocaleLowerCase('az-AZ').normalize('NFKD').replace(/[əƏ]/g,'e').replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[çÇ]/g,'c').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ğĞ]/g,'g').replace(/[\u0300-\u036f]/g,'');
  const named=folded.match(/(?:^|\D)(\d{1,2})\s+([a-z]+)[,\s]+(20\d{2}|19\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i);
  if(named && months[named[2]]){const d=new Date(Date.UTC(Number(named[3]),months[named[2]]-1,Number(named[1]),Number(named[4]||9),Number(named[5]||0),Number(named[6]||0)));return d.toISOString();}
  const dotted=folded.match(/(?:^|\D)(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2}|19\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(dotted){const d=new Date(Date.UTC(Number(dotted[3]),Number(dotted[2])-1,Number(dotted[1]),Number(dotted[4]||9),Number(dotted[5]||0),Number(dotted[6]||0)));if(!Number.isNaN(d.getTime()))return d.toISOString();}
  const d = new Date(raw);
  if(Number.isNaN(d.getTime())) return null;
  const ms=d.getTime(), now=Date.now();
  if(ms>now+3*86400000) return null;
  const year=d.getUTCFullYear(); if(year<1995||year>new Date().getUTCFullYear()+1)return null;
  return d.toISOString();
}
function datePatterns(){
  return [
    /(?:tarix|date|paylasim|paylaşım)?\s*[:\-]?\s*(\d{1,2}\s+(?:yanvar|fevral|mart|aprel|may|iyun|iyul|avqust|sentyabr|oktyabr|noyabr|dekabr|january|february|march|april|june|july|august|september|october|november|december)[,\s]+(?:19|20)\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/gi,
    /((?:19|20)\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?)?)/g,
    /(\d{1,2}[.\/-]\d{1,2}[.\/-](?:19|20)\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/g
  ];
}
function extractDateFromScopedText(scope=''){
  const page=cleanArticleText(String(scope||'')
    .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi,' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi,' '));
  if(!page) return null;
  const candidates=[];
  for(const re of datePatterns()){
    re.lastIndex=0; let m;
    while((m=re.exec(page))){
      const iso=normalizeDate(m[1]||''); if(!iso) continue;
      const pos=m.index;
      const context=page.slice(Math.max(0,pos-90),Math.min(page.length,pos+100));
      let score=0;
      if(/tarix|date|paylaş|saat|vaxt/i.test(context)) score+=40;
      if(/son xəbərlər|digər xəbərlər|related|xəbər lenti|gündəm/i.test(context)) score-=120;
      candidates.push({iso,score,pos});
      if(candidates.length>=40) break;
    }
  }
  candidates.sort((a,b)=>b.score-a.score || a.pos-b.pos);
  return candidates[0]?.iso||null;
}
function extractVisiblePublishedDate(html='', title='') {
  const raw=String(html||'');
  const wanted=cleanArticleText(title||'').toLocaleLowerCase('az-AZ');
  const scopes=[];
  // 1) Ən güclü qayda: xəbərin H1/H2 başlığını tap və yalnız onun yaxın HTML hissəsində tarix axtar.
  if(wanted){
    for(const m of raw.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)){
      const heading=cleanArticleText(m[2]||'').toLocaleLowerCase('az-AZ');
      if(!heading) continue;
      const tokens=wanted.split(/\s+/).filter(x=>x.length>=5);
      const hit=tokens.filter(x=>heading.includes(x)).length;
      if(hit<Math.min(3,Math.max(1,tokens.length))) continue;
      const start=Math.max(0,(m.index||0)-2600), end=Math.min(raw.length,(m.index||0)+String(m[0]||'').length+3200);
      scopes.push(raw.slice(start,end));
    }
  }
  // 2) article/main daxilində başlıq varsa həmin blok. Sidebar/son xəbərlər bu scope-a düşmür.
  for(const m of raw.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)){
    const block=m[2]||'';
    if(!wanted || cleanArticleText(block).toLocaleLowerCase('az-AZ').includes(wanted.slice(0,Math.min(70,wanted.length)))) scopes.push(block);
  }
  for(const scope of scopes){const iso=extractDateFromScopedText(scope); if(iso) return iso;}
  // Başlıq məlumdursa bütün səhifədən tarix götürmürük: sağ paneldəki cari tarix köhnə xəbəri korlaya bilər.
  if(wanted) return null;
  return extractDateFromScopedText(raw);
}
function archiveWindowFromRaw(raw={}){
  const slice=String(raw?.archive_slice||'').trim();
  let start=null,end=null;
  if(/^\d{4}-\d{2}$/.test(slice)){
    const [y,m]=slice.split('-').map(Number); start=new Date(Date.UTC(y,m-1,1)); end=new Date(Date.UTC(m===12?y+1:y,m===12?0:m,1));
  }else if(/^\d{4}$/.test(slice)){
    const y=Number(slice); start=new Date(Date.UTC(y,0,1)); end=new Date(Date.UTC(y+1,0,1));
  }else if(Number(raw?.archive_year_start)&&Number(raw?.archive_year_end)){
    start=new Date(Date.UTC(Number(raw.archive_year_start),0,1)); end=new Date(Date.UTC(Number(raw.archive_year_end)+1,0,1));
  }
  return start&&end?{start,end}:null;
}
function validatePublishedForTarget(iso,target={}){
  const normalized=normalizeDate(iso||''); if(!normalized) return null;
  const raw=target?.raw||{};
  if(raw?.historical_backfill===true){
    const w=archiveWindowFromRaw(raw); const ts=new Date(normalized).getTime();
    if(w && (ts<w.start.getTime() || ts>=w.end.getTime())) return null;
  }
  return normalized;
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
  const bucket = Math.floor(Date.now()/(DIRECT_ONLY ? 45000 : (DEEP_BACKFILL ? 3600000 : 300000)));
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
function authorFromStructuredValue(value) {
  if(!value) return '';
  if(typeof value==='string') return cleanArticleText(value);
  if(Array.isArray(value)) return value.map(authorFromStructuredValue).filter(Boolean).join(', ');
  if(typeof value==='object') return cleanArticleText(value.name || value.author || value.creator || '');
  return '';
}
function extractAuthorFromHtml(html, articleLd={}, fallback='') {
  const structured=authorFromStructuredValue(articleLd?.author || articleLd?.creator);
  if(structured) return structured.slice(0,500);
  const raw=String(html||'');
  const meta=firstMatch(raw,[
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']byl["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+(?:name|property)=["'](?:parsely-author|sailthru\.author)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']author["'][^>]+content=["']([^"']+)["']/i,
    /"author"\s*:\s*\{[^{}]{0,700}?"name"\s*:\s*"([^"]+)"/i,
    /"author"\s*:\s*"([^"]+)"/i,
    /"creator"\s*:\s*"([^"]+)"/i
  ]);
  if(meta) return cleanArticleText(meta).slice(0,500);
  const visiblePatterns=[
    /<(?:span|div|p|a)[^>]*(?:class|id)=["'][^"']*(?:author|byline|writer|reporter|journalist|müəllif|muellif)[^"']*["'][^>]*>([\s\S]{1,400}?)<\/(?:span|div|p|a)>/i,
    /(?:Müəllif|Muellif|Author|By)\s*[:\-–]\s*<[^>]*>([^<]{2,120})</i,
    /(?:Müəllif|Muellif|Author|By)\s*[:\-–]\s*([^<\n]{2,120})/i
  ];
  for(const re of visiblePatterns){
    const m=raw.match(re); if(!m?.[1]) continue;
    const value=cleanArticleText(m[1]).replace(/^(?:müəllif|muellif|author|by)\s*[:\-–]?\s*/i,'').trim();
    if(value && value.length<=180 && !/facebook|instagram|telegram|twitter|x\.com|reklam|editorial/i.test(value)) return value.slice(0,500);
  }
  return cleanArticleText(fallback||'').slice(0,500) || '';
}
function absoluteUrl(base, value='') {
  if (!value) return '';
  try { return new URL(decodeXml(value),base).toString(); } catch { return decodeXml(value); }
}
function extractArticleImages(html='', base='', primary='', articleTitle='') {
  const raw=String(html||'');
  const genericRe=/(?:logo|icon|avatar|sprite|banner|emoji|tracking|pixel|favicon|heyder|heydar|president|prezident|gerb|emblem|facebook|instagram|linkedin|telegram|twitter|youtube)/i;
  const candidates=[];
  const genericContextUrls=new Set();
  for(const m of raw.matchAll(/<a\b[^>]*>[\s\S]{0,900}?<\/a>/gi)){
    const block=m[0];
    if(!/(?:ulu\s+onder|ulu\s+öndər|heyder|heydar|prezident|president|vitse-prezident|fond|dovlet\s+qurumlari|dövlət\s+qurumları)/i.test(cleanArticleText(block))) continue;
    for(const im of block.matchAll(/<img\b[^>]+(?:src|data-src|data-original)=['\"]([^'\"]+)['\"]/gi)){
      const u=absoluteUrl(base,im[1]); if(u) genericContextUrls.add(u.split('?')[0]);
    }
  }
  const add=(value,score=0,source='')=>{
    const url=absoluteUrl(base,String(value||'').trim());
    if(!/^https?:\/\//i.test(url) || genericRe.test(url) || genericContextUrls.has(url.split('?')[0])) return;
    const key=url.split('?')[0];
    const existing=candidates.find(x=>x.key===key);
    if(existing){existing.score=Math.max(existing.score,score);return;}
    candidates.push({url,key,score,source});
  };
  // JSON-LD/real article image is strongest. Generic site-wide OG images are deliberately weak.
  add(primary,90,'primary');
  const title=cleanArticleText(articleTitle||'').toLocaleLowerCase('az-AZ');
  const articleBlocks=[...raw.matchAll(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/gi)].map(m=>m[1]);
  const scope=(articleBlocks.join('\n')||raw);
  for(const m of scope.matchAll(/<img\b[^>]+(?:src|data-src|data-original)=['\"]([^'\"]+)['\"][^>]*>/gi)) add(m[1],75,'article-img');
  // OG/Twitter şəkli yalnız URL generic görünmürsə və səhifə başlığı real məqalə başlığına uyğundursa saxlanır.
  const pageTitle=cleanArticleText(firstMatch(raw,[/<meta[^>]+property=['\"]og:title['\"][^>]+content=['\"]([^'\"]+)['\"]/i,/<title[^>]*>([\s\S]*?)<\/title>/i])).toLocaleLowerCase('az-AZ');
  const titleOk=!title || !pageTitle || title.split(/\s+/).filter(x=>x.length>=5).some(x=>pageTitle.includes(x));
  if(titleOk){
    for(const m of raw.matchAll(/<meta[^>]+(?:property|name)=['\"](?:og:image(?::secure_url)?|twitter:image(?::src)?)['\"][^>]+content=['\"]([^'\"]+)['\"]/gi)) add(m[1],50,'meta');
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates.slice(0,1).map(x=>x.url);
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
function titleAnchoredArticleText(html='', title='') {
  const cleanedTitle=cleanArticleText(title||'');
  if(cleanedTitle.length<6) return '';
  const raw=String(html||'')
    .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi,' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi,' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi,' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi,' ');
  const text=cleanArticleText(raw);
  const hay=text.toLocaleLowerCase('az-AZ');
  const needle=cleanedTitle.toLocaleLowerCase('az-AZ');
  let pos=hay.lastIndexOf(needle);
  if(pos<0) pos=hay.indexOf(needle);
  if(pos<0) return '';
  let chunk=text.slice(pos+cleanedTitle.length,pos+cleanedTitle.length+90000).trim();
  const endMarkers=['oxşar xəbərlər','digər xəbərlər','son xəbərlər','ən çox oxunan','bizi izləyin','şərhlər','comments','related news','read also'];
  const low=chunk.toLocaleLowerCase('az-AZ');
  let end=chunk.length;
  for(const marker of endMarkers){const i=low.indexOf(marker,350); if(i>=350) end=Math.min(end,i);}
  chunk=chunk.slice(0,end)
    .replace(/^(?:sosial\s+)?\d{1,2}[.\/-]\d{1,2}[.\/-](?:19|20)\d{2}(?:\s+\d{1,2}:\d{2})?\s*/i,'')
    .replace(/^oxunma sayı\s*:?\s*\d+\s*/i,'')
    .trim();
  const lines=chunk.split(/\n+/).map(x=>x.trim()).filter(x=>x.length>=25 && !/facebook|instagram|telegram|twitter|x\.com|reklam|cookie|abunə|subscribe/i.test(x));
  return [...new Set(lines)].join('\n\n').slice(0,120000);
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
    let html='', finalUrl=item.url;
    try { const fetched=await fetchPage(item.url,{timeoutMs:10000}); html=fetched.html; finalUrl=fetched.finalUrl||item.url; } catch {}
    // Bəzi dövlət/media saytları məzmunu yalnız JavaScript-dən sonra verir. GitHub runner-də
    // Chrome varsa DOM-u render edib ikinci mənbə kimi götürürük; bir məlumat qəbul edilirsə
    // həmin run-da tarix + tam mətn + düzgün qapaq şəkli birlikdə tamamlanır.
    let rendered='';
    const firstText=cleanArticleText(html);
    if(!html || firstText.length<500 || !extractVisiblePublishedDate(html,item.title||'')) rendered=fetchRenderedHtml(finalUrl||item.url,18000);
    if(rendered && cleanArticleText(rendered).length>firstText.length) html=rendered;
    if(!html) return item;
    const ld=jsonLdObjects(html);
    const articleLd=ld.find(x=>String(x?.['@type']||'').toLowerCase().includes('article')) || ld.find(x=>x?.articleBody) || {};
    const title = articleLd?.headline || firstMatch(html,[/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,/<title[^>]*>([\s\S]*?)<\/title>/i]);
    const desc = articleLd?.description || firstMatch(html,[/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i]);
    const structuredBody=cleanArticleText(articleLd?.articleBody || '');
    const paragraphBody=paragraphText(html);
    const anchoredBody=titleAnchoredArticleText(html, stripHtml(title)||item.title||'');
    // Bəzi saytların JSON-LD articleBody sahəsi yalnız 1-2 cümlə olur, amma səhifədə
    // tam məqalə var. Ən uzun etibarlı mətn namizədini götürürük.
    const bodyCandidates=[structuredBody,anchoredBody,paragraphBody].filter(x=>String(x||'').length>=80).sort((a,b)=>b.length-a.length);
    const body = bodyCandidates[0] || stripHtml(desc) || item.text || '';
    let structuredImage = '';
    if(typeof articleLd?.image==='string') structuredImage=articleLd.image;
    else if(Array.isArray(articleLd?.image)) structuredImage=typeof articleLd.image[0]==='string'?articleLd.image[0]:(articleLd.image[0]?.url||'');
    else if(articleLd?.image?.url) structuredImage=articleLd.image.url;
    const metaImage=firstMatch(html,[/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i]);
    const structuredRaw = articleLd?.datePublished || firstMatch(html,[/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+(?:name|itemprop)=["']datePublished["'][^>]+content=["']([^"']+)["']/i,/"datePublished"\s*:\s*"([^"]+)"/i]);
    const structuredPublished=validatePublishedForTarget(normalizeDate(structuredRaw),item);
    const visiblePublished=structuredPublished?null:validatePublishedForTarget(extractVisiblePublishedDate(html,stripHtml(title)||item.title||''),item);
    const pagePublished=structuredPublished||visiblePublished||null;
    const publishedDateSource=structuredPublished?'structured:datePublished':visiblePublished?'visible:article-heading':null;
    const author = extractAuthorFromHtml(html, articleLd, item.author||'');
    const articleScope=[...html.matchAll(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/gi)].map(m=>m[1]).join('\n');
    const hasArticleImage=/<img\b/i.test(articleScope);
    const primaryCandidate=structuredImage || (hasArticleImage?metaImage:'') || '';
    const primaryImage=absoluteUrl(finalUrl,primaryCandidate)||null;
    const imageUrls=extractArticleImages(html,finalUrl,primaryImage||'',stripHtml(title)||item.title||'');
    return {
      ...item,
      title:stripHtml(title)||item.title,
      text:String(body||item.text||'').slice(0,120000),
      image:imageUrls[0]||null,
      published_at:pagePublished||(String(item?.raw?.kind||'').includes('configured_site_sitemap')?null:item.published_at),
      author:author||item.author||null,
      raw:{...(item.raw||{}),enriched:true,canonical_url:finalUrl||item.url,image_urls:imageUrls,published_from_page:Boolean(pagePublished),published_date_status:pagePublished?'verified':'not-found',published_date_source:publishedDateSource,date_parser_version:2}
    };
  } catch { return item; }
}

function reliablePublishedAt(enriched,target){
  // Yalnız v2 parserin məqalənin öz scope-undan təsdiqlədiyi tarix bazaya yazılır.
  if(enriched?.raw?.published_from_page!==true || Number(enriched?.raw?.date_parser_version||0)<2) return null;
  return validatePublishedForTarget(enriched?.published_at,target||enriched);
}

async function probeSitemapCandidates(items, org, limit=SITEMAP_PROBE_LIMIT) {
  if(!DEEP_BACKFILL || limit<=0) return [];
  const rows=dedupe((Array.isArray(items)?items:[]).filter(item=>String(item?.raw?.kind||'').includes('configured_site_sitemap')));
  if(!rows.length) return [];
  const window=archiveWindowForShard(`${org?.id||''}-probe`);
  const preferred=rows.filter(item=>sitemapRowInArchiveWindow({url:item.url,lastmod:item?.raw?.sitemap_lastmod||item.published_at},org));
  const pool=preferred.length?preferred:rows;
  const chosen=rotate(pool,Math.min(limit,pool.length),`sitemap-probe-${org?.id||''}-${window.label}-${SOURCE_SHARD_INDEX}`);
  const enriched=[];
  for(let i=0;i<chosen.length;i++){
    const full=await enrichPage(chosen[i]);
    if(full?.raw?.enriched){
      enriched.push({...full,raw:{...(full.raw||{}),sitemap_probe:true,historical_backfill:true,recent_priority:RECENT_PRIORITY,archive_slice:window.label}});
    }
    if((i+1)%10===0) console.log(`[${org.short_name}] Sitemap məqalə probe: ${i+1}/${chosen.length}, açılan=${enriched.length}`);
  }
  return enriched;
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

function findBinary(candidates=[]) {
  for (const bin of candidates) {
    const r=spawnSync('which',[bin],{encoding:'utf8'});
    if (r.status===0 && r.stdout.trim()) return r.stdout.trim();
  }
  return '';
}

function findChrome() {
  return findBinary(['google-chrome','google-chrome-stable','chromium','chromium-browser']);
}

function fetchRenderedHtml(url, timeoutMs=18000) {
  const chrome=findChrome();
  if(!chrome || !url) return '';
  try{
    const r=spawnSync(chrome,[
      '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
      '--run-all-compositor-stages-before-draw','--virtual-time-budget=4500',
      '--dump-dom',url
    ],{encoding:'utf8',timeout:timeoutMs,maxBuffer:12*1024*1024});
    return r.status===0?String(r.stdout||''):'';
  }catch{return '';}
}

function optimizeScreenshot(inputFile) {
  const tool=findBinary(['magick','convert']);
  if(!tool) return null;
  const output=join(tmpdir(),`media-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
  const args=tool.endsWith('/magick')
    ? [inputFile,'-auto-orient','-strip','-fuzz','4%','-trim','+repage','-resize','1800x5200>','-quality','88',output]
    : [inputFile,'-auto-orient','-strip','-fuzz','4%','-trim','+repage','-resize','1800x5200>','-quality','88',output];
  const r=spawnSync(tool,args,{encoding:'utf8',timeout:15000});
  if(r.status!==0 || !existsSync(output)) { try{unlinkSync(output)}catch{} return null; }
  try {
    const buf=readFileSync(output);
    if(!buf.length || buf.length>2_650_000) return null;
    return {base64:buf.toString('base64'),mime_type:'image/jpeg',bytes:buf.length};
  } finally { try{unlinkSync(output)}catch{} }
}

async function captureScreenshot(target) {
  const chrome=findChrome();
  if (!chrome || !target?.url) return null;
  const profiles=[
    {width:1440,height:5000,scale:'0.9',budget:'6500'},
    {width:1280,height:4000,scale:'0.8',budget:'5200'}
  ];
  for(const profile of profiles){
    const file=join(tmpdir(),`media-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    const args=[
      '--headless=new','--no-sandbox','--disable-gpu','--hide-scrollbars',
      '--disable-dev-shm-usage','--run-all-compositor-stages-before-draw',
      `--virtual-time-budget=${profile.budget}`,
      `--window-size=${profile.width},${profile.height}`,
      `--force-device-scale-factor=${profile.scale}`,
      `--screenshot=${file}`,target.url
    ];
    const r=spawnSync(chrome,args,{encoding:'utf8',timeout:30000});
    if (r.status!==0 || !existsSync(file)) { try{unlinkSync(file)}catch{} continue; }
    try {
      // GitHub runner-də ImageMagick varsa PNG-ni JPEG-ə sıxırıq. Bu, Supabase
      // Storage/egress xərclərini ciddi azaldır. Yoxdursa kiçik PNG təhlükəsiz fallback-dır.
      const optimized=optimizeScreenshot(file);
      if(optimized) return optimized;
      const buf=readFileSync(file);
      if(buf.length && buf.length<=2_400_000) return {base64:buf.toString('base64'),mime_type:'image/png',bytes:buf.length};
    } finally { try{unlinkSync(file)}catch{} }
  }
  return null;
}

function isSecurityChallengeHtml(html='') {
  return /performing security verification|verify you are not a bot|checking your browser|cloudflare|cf-chl|attention required/i.test(String(html||''));
}

async function saveScreenshotForTarget(org,target) {
  const sourceUrl=String(target?.source_url||target?.original_url||target?.url||'').trim();
  const captureUrl=String(target?.capture_url||target?.url||sourceUrl).trim();
  if(!sourceUrl || !captureUrl) return {saved:false,skipped:'url-yoxdur'};
  const probeHtml=fetchRenderedHtml(captureUrl,12000);
  if(isSecurityChallengeHtml(probeHtml)){
    console.log(`[${org.short_name}] Screenshot buraxıldı: anti-bot/security challenge | ${captureUrl.slice(0,140)}`);
    return {saved:false,skipped:'security-challenge'};
  }
  const shot=await captureScreenshot({...target,url:captureUrl});
  if(!shot) {
    console.log(`[${org.short_name}] Screenshot alınmadı: ${captureUrl.slice(0,140)}`);
    return {saved:false,skipped:'capture-failed'};
  }
  try {
    const saved=await callMonitor({mode:'news_media',organization_id:org.id,source_url:sourceUrl,image_base64:shot.base64,mime_type:shot.mime_type,media_type:'screenshot'});
    console.log(`[${org.short_name}] Screenshot: ${saved?.ok && saved?.saved ? 'SAXLANDI' : (saved?.skipped||saved?.error||'buraxıldı')} | ${Math.round(Number(shot.bytes||0)/1024)} KB | ${String(target?.title||sourceUrl).slice(0,100)}`);
    return saved||{saved:false};
  } catch(e) {
    console.log(`[${org.short_name}] Screenshot upload xəta: ${e?.message||e}`);
    return {saved:false,error:e?.message||String(e)};
  }
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
function archiveWindows() {
  const rows=[];
  const now=new Date();
  for(let year=ARCHIVE_YEAR_END; year>=ARCHIVE_YEAR_START; year--){
    const maxMonth=year===now.getFullYear()?now.getMonth()+1:12;
    for(let month=maxMonth; month>=1; month--) rows.push({year,month});
  }
  return rows;
}
function archiveWindowForShard(salt='') {
  if(!RECENT_PRIORITY) {
    const year=archiveYearForShardLegacy(salt);
    return {year,month:null,start:`${year}-01-01`,end:`${year+1}-01-01`,label:String(year)};
  }
  const windows=archiveWindows();
  if(!windows.length){
    const year=CURRENT_YEAR;
    return {year,month:new Date().getMonth()+1,start:`${year}-01-01`,end:`${year+1}-01-01`,label:String(year)};
  }
  let hash=0;
  for(const c of String(salt)) hash=((hash<<5)-hash+c.charCodeAt(0))|0;
  // 30 dəqiqəlik pəncərə: 5 shard + müxtəlif sorğular eyni run-da ayrı ayları qazır.
  // 2024–2026 arxivi bir neçə run ərzində aylıq dilimlərlə tam dövr edir.
  const cycle=Math.floor(Date.now()/(30*60*1000));
  const idx=Math.abs(cycle*SOURCE_SHARD_COUNT + SOURCE_SHARD_INDEX + hash)%windows.length;
  const {year,month}=windows[idx];
  const next=month===12?{year:year+1,month:1}:{year,month:month+1};
  const mm=String(month).padStart(2,'0');
  const nm=String(next.month).padStart(2,'0');
  return {year,month,start:`${year}-${mm}-01`,end:`${next.year}-${nm}-01`,label:`${year}-${mm}`};
}
function archiveYearForShardLegacy(salt='') {
  const years=[];
  for(let y=ARCHIVE_YEAR_END;y>=ARCHIVE_YEAR_START;y--) years.push(y);
  if(!years.length) return new Date().getFullYear();
  let hash=0;
  for(const c of String(salt)) hash=((hash<<5)-hash+c.charCodeAt(0))|0;
  const cycle=Math.floor(Date.now()/(10*60*1000));
  const idx=Math.abs(cycle*SOURCE_SHARD_COUNT + SOURCE_SHARD_INDEX + hash)%years.length;
  return years[idx];
}
function sitemapIndexScore(value='',org={}) {
  const url=asciiToken(value);
  const w=archiveWindowForShard(`${org?.id||''}-sitemap`);
  let score=0;
  if(/news|xeber|post|article|story/.test(url)) score+=30;
  if(url.includes(String(w.year))) score+=45;
  if(w.month && (url.includes(`${w.year} ${String(w.month).padStart(2,'0')}`) || url.includes(`${w.year}${String(w.month).padStart(2,'0')}`))) score+=55;
  if(/sitemap index|sitemapindex/.test(url)) score+=4;
  return score;
}
function rotatingIndexes(indexes=[], count=8, salt='', org={}) {
  const sorted=[...new Set(indexes)].map((url,index)=>({url,index,score:sitemapIndexScore(url,org)}))
    .sort((a,b)=>b.score-a.score || a.index-b.index).map(x=>x.url);
  const high=sorted.filter(x=>sitemapIndexScore(x,org)>0);
  const base=high.length>=Math.min(count,3) ? [...high,...sorted.filter(x=>!high.includes(x))] : sorted;
  return rotate(base,Math.min(count,base.length),`sitemap-${salt}`);
}
function sitemapRowInArchiveWindow(row={},org={}) {
  if(!DEEP_BACKFILL) return true;
  const w=archiveWindowForShard(`${org?.id||''}-sitemap`);
  if(row?.lastmod){
    const ts=new Date(row.lastmod).getTime();
    const start=new Date(`${w.start}T00:00:00Z`).getTime();
    const end=new Date(`${w.end}T00:00:00Z`).getTime();
    if(Number.isFinite(ts) && Number.isFinite(start) && Number.isFinite(end)) return ts>=start && ts<end;
  }
  const raw=String(row?.url||'');
  const yearMatches=[...raw.matchAll(/(?:^|\D)(20\d{2})(?:\D|$)/g)].map(m=>Number(m[1]));
  if(yearMatches.length && !yearMatches.includes(w.year)) return false;
  if(RECENT_PRIORITY && w.month && yearMatches.includes(w.year)){
    const mm=String(w.month).padStart(2,'0');
    const monthHint=new RegExp(`(?:${w.year})[-_/]?(?:${mm})(?:[-_/]|\\D|$)`);
    const anyMonthHint=new RegExp(`(?:${w.year})[-_/]?(?:0[1-9]|1[0-2])(?:[-_/]|\\D|$)`);
    if(anyMonthHint.test(raw) && !monthHint.test(raw)) return false;
  }
  return true;
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
        let links=linkItemsFromHtml(html,base);
        // berdesmsii.az kimi xəbərləri JS ilə yükləyən saytlarda ilkin HTML-də real xəbər
        // linkləri olmaya bilər. Bu halda Chrome render edilmiş DOM-dan linkləri bir dəfə götürürük.
        if(links.length<3){const rendered=fetchRenderedHtml(base,15000);if(rendered){homepageHtml=rendered;links=linkItemsFromHtml(rendered,base);}}
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
        for(const idx of rotatingIndexes(parsed.indexes,SITEMAP_INDEX_LIMIT,`${org?.id||''}-${origin}-${archiveWindowForShard(org?.id||origin).label}`,org)){
          try{
            const nested=await fetchText(idx,{timeoutMs:5500,retries:0,minGapMs:180});
            const nestedParsed=parseSitemap(nested);
            urls.push(...nestedParsed.urls);
            // Bəzi saytlar sitemap -> sitemap-index -> aylıq sitemap quruluşundadır.
            // Yalnız ən uyğun alt indekslərdən kiçik ikinci qat götürülür; bütün ağacı
            // kor-koranə gəzmədiyimiz üçün job vaxt limiti qorunur.
            for(const idx2 of rotatingIndexes(nestedParsed.indexes,Math.min(4,SITEMAP_INDEX_LIMIT),`${org?.id||''}-${idx}`,org)){
              try{
                const nested2=await fetchText(idx2,{timeoutMs:4500,retries:0,minGapMs:150});
                urls.push(...parseSitemap(nested2).urls);
              }catch{}
            }
          }catch{}
        }
        const windowed=DEEP_BACKFILL ? urls.filter(row=>sitemapRowInArchiveWindow(row,org)) : urls;
        const pool=windowed.length ? windowed : urls;
        const relevant=pool.filter(row=>relevantSitemapUrl(row.url,org));
        const chosen=(relevant.length?relevant:pool)
          .sort((a,b)=>String(b.lastmod||'').localeCompare(String(a.lastmod||'')))
          .slice(0,relevant.length?SITEMAP_URL_LIMIT:Math.min(SITEMAP_URL_LIMIT,RECENT_PRIORITY?420:DEEP_BACKFILL?260:80));
        for(const row of chosen) out.push({
          title:row.url.split('/').filter(Boolean).pop()?.replace(/[-_]+/g,' ')||row.url,
          text:'',url:row.url,published_at:null,image:null,author:null,
          raw:{kind:'configured_site_sitemap',provider:source.name||'Configured Web',sitemap_lastmod:row.lastmod||null}
        });
        if(out.length) break;
      } catch {}
    }
    if(!SITEMAP_FOCUS){
      try {
        const {html}=await fetchPage(base,{timeoutMs:5500});
        let links=linkItemsFromHtml(html,base);
        if(links.length<3){const rendered=fetchRenderedHtml(base,16000);if(rendered)links=linkItemsFromHtml(rendered,base);}
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
    }
  } catch(e){ console.log(`[${orgName}] Birbaşa sayt discovery xəta: ${base} — ${e?.message||e}`); }
  return dedupe(out).slice(0,SITEMAP_FOCUS?SITEMAP_URL_LIMIT:DEEP_BACKFILL?Math.max(320,SITEMAP_URL_LIMIT):100);
}

async function directFeed(source, org) {
  if (!source?.url) return [];
  const orgName=org?.short_name||org?.name||'Təşkilat';
  // Sitemap fokus job-u üçün mənbə cədvəlində URL birbaşa /feed/, /rss/ və ya
  // atom ünvanı olsa belə həmin domenin kökünə keçib sitemap arxivini qazırıq.
  // Normal fast-watch/RSS davranışı dəyişmir.
  if(SITEMAP_FOCUS){
    try{
      const origin=new URL(source.url).origin;
      return directWebsite({...source,url:`${origin}/`},org);
    }catch{}
  }
  if(!isFeedLikeUrl(source.url) && !/rss|atom/i.test(String(source.platform||''))) return directWebsite(source,org);
  try {
    const xml = await fetchText(source.url,{timeoutMs:15000,retries:1,minGapMs:1200});
    return parseFeed(xml,'configured_feed',orgName,source.name || source.platform || source.url);
  } catch (e) {
    console.log(`[${orgName}] Mənbə RSS xəta: ${source.url} — ${e?.message||e}`);
    return [];
  }
}

function archiveYearForShard(salt='') {
  return archiveWindowForShard(salt).year;
}
function withArchiveWindow(query, org) {
  if(!DEEP_BACKFILL) return query;
  const w=archiveWindowForShard(`${org?.id||''}-${query}`);
  const monthNames=['','yanvar','fevral','mart','aprel','may','iyun','iyul','avqust','sentyabr','oktyabr','noyabr','dekabr'];
  // 2024–2026 prioritet qatında hər sorğu ayrıca AY pəncərəsi alır. Bu, axtarış
  // mühərriklərinin eyni populyar 10–20 nəticəni təkrar qaytarmasını xeyli azaldır.
  // Tarixi 2000–2023 qatında əvvəlki il pəncərəsi saxlanılır.
  const humanMonth=w.month ? ` ${monthNames[w.month]||''}` : '';
  return `${query} after:${w.start} before:${w.end} ${w.year}${humanMonth}`.trim();
}
function deepArchiveQueries(org, baseQueries=[]) {
  if(!DEEP_BACKFILL) return baseQueries;
  const district=String(org?.district||'').trim();
  const year=archiveYearForShard(org?.id||district);
  const core=district ? [
    `\"${district}\" (suvarma OR meliorasiya OR subartezian OR artezian)`,
    `\"${district}\" (kanal OR arx OR drenaj OR kollektor OR nasos OR quyu)`,
    `\"${district}\" (\"su təchizatı\" OR \"içməli su\" OR \"su problemi\" OR fermer OR əkin)`,
    `\"${district}\" (\"Su İdarəsi\" OR SMSİİ OR sukanal OR \"Suvarma Sistemləri\")`
  ] : [];
  return [...new Set([...baseQueries,...core].map(q=>withArchiveWindow(q,org)))];
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
  plan = await callMonitor({mode:'news_plan', include_archived:GLOBAL_ORGS, organization_shard_count:ORG_SHARD_COUNT, organization_shard_index:ORG_SHARD_INDEX, organization_batch:ORG_BATCH, organization_rotation_bucket:ORG_ROTATION_BUCKET}, 60000);
} catch (e) {
  if (e?.name === 'AbortError') {
    throw new Error('news_plan timeout: Supabase plan cavabı 60 saniyəni keçdi');
  }
  throw e;
}
if (!plan?.ok || !Array.isArray(plan.organizations)) throw new Error(`News plan alınmadı: ${JSON.stringify(plan).slice(0,800)}`);
console.log(`NEWS_GATEWAY_MODE ${FULL_RADAR?'FULL_RADAR:':''}${SITEMAP_FOCUS?'SITEMAP_ARCHIVE':DIRECT_ONLY?'FAST_WATCH':RECENT_PRIORITY?'RECENT_PRIORITY':DEEP_BACKFILL?'HISTORICAL_BACKFILL':'ARCHIVE_DISCOVERY'} | org_shard ${ORG_SHARD_INDEX+1}/${ORG_SHARD_COUNT} | source_shard ${SOURCE_SHARD_INDEX+1}/${SOURCE_SHARD_COUNT} | query_pass=${QUERY_PASS+1}/${QUERY_PASS_COUNT} | bing_pages=${BING_PAGE_LIMIT}${DEEP_BACKFILL?` | year_window=${ARCHIVE_YEAR_START}-${ARCHIVE_YEAR_END} | archive_slice=${archiveWindowForShard('run').label}`:''}${SITEMAP_FOCUS?` | sitemap_indexes=${SITEMAP_INDEX_LIMIT} sitemap_urls=${SITEMAP_URL_LIMIT} probes=${SITEMAP_PROBE_LIMIT}`:''}`);

let totalReceived=0, totalAccepted=0, totalRejected=0, totalInserted=0, totalFailures=0, totalChunkFailures=0;
let gdeltUsedThisRun=false;

for (const org of plan.organizations) {
  if (gatewayBudgetLow()) {
    console.log(`NEWS_GATEWAY_BUDGET_STOP elapsed_ms=${Date.now()-GATEWAY_STARTED_AT} budget_ms=${GATEWAY_BUDGET_MS}`);
    break;
  }
  if (RADAR_SCAN_ID) {
    const radarStage = RECENT_PRIORITY ? 'web_recent' : 'web_archive';
    try { await callMonitor({mode:'radar_event',scan_id:RADAR_SCAN_ID,organization_id:org.id,radar_stage:radarStage},20000); }
    catch(e) { console.log(`[${org.short_name}] Radar telemetriya yazılmadı: ${e?.message||e}`); }
  }
  // Yalnız 1-ci shard əvvəlki Web qeydlərini cari axtarılmamalı sözlərlə yenidən yoxlayır.
  // Beləliklə əvvəlki yumşaq filtrdən keçmiş uyğunsuz xəbərlər relevance_score=0 olur
  // və Monitorinq/Hesabat/Bildirişlər ekranından avtomatik çıxır.
  if (REFILTER_EXISTING) {
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
  const villageQueryBank = Array.isArray(org.village_queries) ? org.village_queries.filter(Boolean) : [];
  const aliasQueryBank = Array.isArray(org.alias_queries) ? org.alias_queries.filter(Boolean) : [];
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
  const keywordQueries = FULL_RADAR
    ? shardQueryWindow(keywordBank, Math.max(BROAD_QUERY_LIMIT, 18), QUERY_PASS, QUERY_PASS_COUNT)
    : shardQueryWindow(keywordBank, Math.max(BROAD_QUERY_LIMIT, 8), SOURCE_SHARD_INDEX, SOURCE_SHARD_COUNT);
  const villageQueries = FULL_RADAR
    ? shardQueryWindow(villageQueryBank, Math.max(8,Math.min(18,BROAD_QUERY_LIMIT)), QUERY_PASS, QUERY_PASS_COUNT)
    : shardQueryWindow(villageQueryBank, Math.max(2,Math.min(5,BROAD_QUERY_LIMIT)), SOURCE_SHARD_INDEX, SOURCE_SHARD_COUNT);
  const aliasQueries = FULL_RADAR
    ? shardQueryWindow(aliasQueryBank, Math.max(6,Math.min(12,BROAD_QUERY_LIMIT)), QUERY_PASS, QUERY_PASS_COUNT)
    : shardQueryWindow(aliasQueryBank, Math.max(2,Math.min(4,BROAD_QUERY_LIMIT)), SOURCE_SHARD_INDEX, SOURCE_SHARD_COUNT);
  // Əvvəlki variantda bütün 5 shard faktiki olaraq eyni 1-2 geniş sorğunu işlədirdi.
  // Buna görə eyni köhnə 5 xəbər təkrar tapılır, yeni material tapılsa belə çox vaxt
  // dublikat kimi insert olunmurdu. İndi hər shard rayon+mövzu və açar-söz bankının
  // fərqli hissəsini işləyir. Beləliklə 5 paralel job real olaraq 5 ayrı discovery
  // pəncərəsi olur və arxiv mərhələli şəkildə genişlənir.
  const shardDiscoveryPool = [...new Set([
    ...discoveryCore,
    ...topicCore,
    ...rotatingQueries,
    ...aliasQueries,
    ...villageQueries,
    ...keywordQueries,
    ...azDomainQueries,
    ...directDomainQueries
  ].filter(Boolean))];
  const selectedDiscoveryQueries = DIRECT_ONLY ? [] : shardQueryWindow(
    shardDiscoveryPool,
    Math.max(1,BROAD_QUERY_LIMIT),
    FULL_RADAR ? QUERY_PASS : SOURCE_SHARD_INDEX,
    FULL_RADAR ? QUERY_PASS_COUNT : SOURCE_SHARD_COUNT
  ).slice(0,Math.max(1,BROAD_QUERY_LIMIT));
  const webQueries = DEEP_BACKFILL
    ? deepArchiveQueries(org, selectedDiscoveryQueries).slice(0,Math.max(4,BROAD_QUERY_LIMIT+4))
    : selectedDiscoveryQueries;
  // Google News də shard üzrə fərqli sorğular görür. Əsas rayon sorğusu qorunur,
  // ikinci/üçüncü sorğular isə həmin shard-ın açar söz pəncərəsindən seçilir.
  const googleBaseQueries = DIRECT_ONLY ? [] : [...new Set([
    ...(broadDistrict.length ? broadDistrict : topicCore.slice(0,1)),
    ...aliasQueries.slice(0,FULL_RADAR?4:1),
    ...villageQueries.slice(0,FULL_RADAR?5:1),
    ...shardQueryWindow([...rotatingQueries,...keywordQueries], FULL_RADAR?6:3, FULL_RADAR?QUERY_PASS:SOURCE_SHARD_INDEX, FULL_RADAR?QUERY_PASS_COUNT:SOURCE_SHARD_COUNT)
  ].filter(Boolean))].slice(0,FULL_RADAR?14:4);
  const googleQueries = DEEP_BACKFILL
    ? deepArchiveQueries(org, googleBaseQueries).slice(0,8)
    : googleBaseQueries;
  console.log(`[${org.short_name}] Discovery bankı: ${Number(org.keyword_count||keywordBank.length)} açar söz + ${Number(org.village_count||0)} kənd + ${Number(org.alias_count||0)} alias | bu keçid: keyword=${keywordQueries.length}, village=${villageQueries.length}, alias=${aliasQueries.length}`);
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
    // Manual Tam Radar rejimində discovery yalnız .az domenləri ilə məhdudlaşmır.
    // Xarici TLD-də yerləşən Azərbaycan mediası da namizəd hovuzuna daxil olur;
    // yekun qəbul qərarını Supabase-dəki təşkilat/rayon/kənd + mövzu filtri verir.
    if(FULL_RADAR) return !/(^|\.)google\.|(^|\.)bing\.|youtube\.com$|youtu\.be$/i.test(host);
    return host.endsWith('.az') || host==='az';
  }));

  // Arxiv discovery aktiv açar söz bankının shard-a düşən frazalarını da Google News-də yoxlayır.
  // Discovery genişdir; qəbul mərhələsi isə sərt rayon/kənd + mövzu filtri ilə qorunur.
  const keywordGoogleQueries = DIRECT_ONLY ? [] : keywordQueries.slice(0,FULL_RADAR?12:DEEP_BACKFILL?12:8).map(q=>DEEP_BACKFILL?withArchiveWindow(q,org):q);
  const villageGoogleQueries = DIRECT_ONLY ? [] : villageQueries.slice(0,FULL_RADAR?8:2).map(q=>DEEP_BACKFILL?withArchiveWindow(q,org):q);
  const aliasGoogleQueries = DIRECT_ONLY ? [] : aliasQueries.slice(0,FULL_RADAR?6:2).map(q=>DEEP_BACKFILL?withArchiveWindow(q,org):q);
  const allGoogleQueries=[...new Set([...googleQueries,...aliasGoogleQueries,...villageGoogleQueries,...keywordGoogleQueries])].slice(0,FULL_RADAR?24:DEEP_BACKFILL?16:10);
  if(!DIRECT_ONLY && !SITEMAP_FOCUS) for (const q of allGoogleQueries) {
    if (gatewayBudgetLow()) break;
    try {
      const g = await googleNews(q);
      googleItems.push(...keepDiscoveryItems(g.items));
      if (g.errors.length) console.log(`[${org.short_name}] Google locale xətaları (${q}): ${g.errors.join(' | ')}`);
    } catch (e) {
      totalFailures++; console.log(`[${org.short_name}] Google News xəta (${q}):`, e?.message||e);
    }
  }
  if(!DIRECT_ONLY && !SITEMAP_FOCUS) for (const q of webQueries) {
    if (gatewayBudgetLow()) break;
    try {
      // Arxiv run-da ilk səhifə ilə kifayətlənmək eyni populyar nəticələrin təkrar
      // düşməsinə səbəb olurdu. Hər shard fərqli sorğu işlədiyi üçün 3 səhifəyə qədər
      // oxumaq artıq həm təhlükəsizdir, həm də köhnə materialları tapma şansını artırır.
      for (let page=0; page<BING_PAGE_LIMIT; page++) {
        if (gatewayBudgetLow()) break;
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
  // Fast-watch ana səhifə/RSS ilə yanaşı kiçik bir domen axtarışı pəncərəsi də işlədə bilər.
  // Əvvəl DIRECT_ONLY rejimində bu hissə tam söndürülürdü və bir çox xəbər saytı RSS/link
  // vermədiyi üçün fast-watch həmişə 0 material görürdü. Batch workflow-da kiçik saxlanılır.
  const targetedSources=!SITEMAP_FOCUS && DOMAIN_SEARCH_BATCH > 0
    ? (sourceBatch.length <= DOMAIN_SEARCH_BATCH ? sourceBatch : rotateSources(sourceBatch, DOMAIN_SEARCH_BATCH, `domain-search-${org.id}-shard-${SOURCE_SHARD_INDEX}`))
    : [];
  for (const source of targetedSources) {
    if (gatewayBudgetLow()) break;
    const domain=domainFromUrl(source?.url||'');
    if(!domain || !org.district) continue;
    const sourceIndex = targetedSources.indexOf(source);
    const keywordOffset = Math.floor(Date.now()/(15*60*1000)) * Math.max(1, targetedSources.length * SOURCE_SHARD_COUNT)
      + SOURCE_SHARD_INDEX * Math.max(1, targetedSources.length) + Math.max(0, sourceIndex);
    const scopedKeyword = keywordBank.length ? keywordBank[keywordOffset % keywordBank.length] : '';
    const queries=buildDomainQueries(org,domain,scopedKeyword)
      .map(q=>DEEP_BACKFILL?withArchiveWindow(q,{...org,id:`${org.id}-domain-${domain}`}):q);
    let found=[];
    for (let qi=0; qi<queries.length; qi++) {
      if (gatewayBudgetLow()) break;
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
    if (gatewayBudgetLow()) break;
    const domain=domainFromUrl(source?.url||'');
    const feedTimeoutMs=Math.max(8000,Math.min(18000,Math.max(9000,GATEWAY_BUDGET_MS-(Date.now()-GATEWAY_STARTED_AT)-2500)));
    const items = keepDomain(await Promise.race([
      directFeed(source,org),
      new Promise(resolve=>setTimeout(()=>{console.log(`[${org.short_name}] Birbaşa mənbə timeout: ${String(source?.url||'').slice(0,120)}`);resolve([]);},feedTimeoutMs))
    ]),domain);
    if (/google/i.test(`${source.platform||''} ${source.name||''} ${source.url||''}`)) googleItems.push(...items);
    else directWebItems.push(...items);
  }

  // Namizədləri sadəcə gəldiyi sıraya görə 140-a kəsmək düzgün xəbərlərin hovuzdan
  // çıxmasına səbəb olurdu. İndi rayon + mövzu + aktiv açar-söz siqnalı olan materiallar
  // əvvəl sıralanır, yalnız bundan sonra ingest limiti tətbiq olunur. Son qəbul/rədd qərarı
  // yenə Supabase monitor-worker filtrində verilir; bu sıralama filtri yumşaltmır.
  const districtNorm=normalizeTitleKey(org.district||'');
  const queryTerms=[...new Set([
    ...keywordQueries,
    ...googleQueries,
    ...webQueries
  ].flatMap(q=>normalizeTitleKey(String(q||'').replace(/site:[^\s]+/gi,'')).split(/\s+/))
    .filter(t=>t.length>=4 && !['barda','berde','rayonu','rayon','sistemlerinin','sistemleri'].includes(t))
  )].slice(0,160);
  const topicTerms=['suvarma','meliorasiya','subartezian','artezian','drenaj','kollektor','kanal','arx','su','fermer','ekin','nasos','quyu','temizlen','suvaril'];
  const sourceWeight=item=>{
    const kind=String(item?.raw?.kind||'').toLowerCase();
    if(kind.includes('configured_feed') || kind.includes('configured_site')) return 18;
    if(kind.includes('google_news')) return 12;
    if(kind.includes('bing_news')) return 10;
    return 4;
  };
  const relevanceRank=item=>{
    const text=normalizeTitleKey(`${item?.title||''} ${item?.text||''}`);
    let score=sourceWeight(item);
    if(districtNorm && (` ${text} `).includes(` ${districtNorm} `)) score+=70;
    const topicHits=topicTerms.filter(t=>(` ${text} `).includes(` ${t} `)).length;
    score+=Math.min(topicHits,5)*12;
    const keywordHits=queryTerms.filter(t=>(` ${text} `).includes(` ${t} `)).length;
    score+=Math.min(keywordHits,6)*10;
    const q=normalizeTitleKey(String(item?.raw?.discovery_query||''));
    if(districtNorm && q.includes(districtNorm)) score+=15;
    if(item?.published_at){
      const ageDays=(Date.now()-new Date(item.published_at).getTime())/86400000;
      if(Number.isFinite(ageDays)) score+=ageDays<=2?12:ageDays<=30?6:0;
    }
    return score;
  };
  // Sitemap URL-lərində başlıq bəzən yalnız rəqəm/slug olur. Worker həmin URL-in
  // içindəki Bərdə + su/meliorasiya məzmununu görmədən onu rədd edə bilərdi.
  // Dərin qat seçilmiş sitemap səhifələrinin özünü əvvəlcədən açıb real başlıq/mətni
  // çıxarır; sonra həmin tam mətn normal sərt worker filtrindən keçir.
  const sitemapProbeItems=await probeSitemapCandidates(directWebItems,org,SITEMAP_PROBE_LIMIT);
  const allWebCandidates=dedupe([
    ...sitemapProbeItems,
    ...directWebItems,
    ...domainWebItems,
    ...googleItems,
    ...broadWebItems
  ]);
  const unifiedWebItems=allWebCandidates
    .map(item=>DEEP_BACKFILL ? ({...item,raw:{...(item?.raw||{}),historical_backfill:true,recent_priority:RECENT_PRIORITY,archive_year_start:ARCHIVE_YEAR_START,archive_year_end:ARCHIVE_YEAR_END,archive_slice:archiveWindowForShard(`${org?.id||''}-${item?.url||item?.title||''}`).label}}) : item)
    .map((item,index)=>({item,index,score:relevanceRank(item)}))
    .sort((a,b)=>b.score-a.score || a.index-b.index)
    .slice(0,MAX_INGEST_ITEMS)
    .map(x=>x.item);
  const rankedPositive=allWebCandidates.filter(item=>relevanceRank(item)>=70).length;
  console.log(`[${org.short_name}] Web namizədlər: direct=${directWebItems.length} sitemap-probe=${sitemapProbeItems.length} domain=${domainWebItems.length} google=${googleItems.length} broad=${broadWebItems.length} all=${allWebCandidates.length} yüksək-siqnal=${rankedPositive} unified=${unifiedWebItems.length}`);

  const screenshotQueue=[];
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
    totalChunkFailures += Number(result?.chunk_failures||0);
    console.log(`[${org.short_name}] ${batch.label}: received=${result?.received||0}, accepted=${result?.accepted||0}, rejected=${result?.rejected||0}, inserted=${result?.inserted||0}`);
    logIngestSamples(org.short_name,batch.label,result);
    if(Array.isArray(result?.screenshot_targets)) screenshotQueue.push(...result.screenshot_targets);

    // Yalnız filtrdən keçmiş materialların öz səhifəsini açıb tam mətni, tarix/müəllif
    // və əsas xəbər şəklini dəqiqləşdiririk. Beləliklə axtarış snippet-i orijinal mətn kimi saxlanmır.
    const acceptedTargets=Array.isArray(result?.accepted_targets)?result.accepted_targets:[];
    for (const target of acceptedTargets.slice(0,MAX_ENRICH_ITEMS)) {
      const enriched=await enrichPage({title:target.title||'',text:target.text||'',url:target.url,published_at:target.published_at||null,image:target.image||null,author:target.author||null,raw:target.raw||{}});
      try {
        const refreshed=await callMonitor({
          mode:'news_enrich', organization_id:org.id, source_url:target.url,
          title:enriched.title||target.title||'', text:enriched.text||target.text||'',
          image_url:enriched.image||'', image_urls:Array.isArray(enriched.raw?.image_urls)?enriched.raw.image_urls:[], published_at:reliablePublishedAt(enriched,target),
          author:enriched.author||null, canonical_url:enriched.raw?.canonical_url||target.url, page_enriched:enriched.raw?.enriched===true, published_date_source:enriched.raw?.published_date_source||'', date_parser_version:Number(enriched.raw?.date_parser_version||0)
        });
        if(!refreshed?.ok) console.log(`[${org.short_name}] Tam mətn yenilənmədi: ${refreshed?.error||target.url}`);
      } catch(e) { console.log(`[${org.short_name}] Tam mətn yeniləmə xətası: ${e?.message||e}`); }

      // Egress optimizasiyası: əsas xəbər şəklini Supabase Storage-a kopyalamırıq.
      // news_enrich artıq image_url-u raw_payload-da saxlayır və frontend həmin orijinal
      // CDN URL-ni birbaşa göstərir. Beləliklə hər baxış Supabase egress xərcləmir.
      const hasExternalPreview=Boolean(enriched.image);
      if(hasExternalPreview){
        console.log(`[${org.short_name}] Xəbər şəkli: XARİCİ CDN | ${String(enriched.title||target.title||'').slice(0,100)}`);
      }
      // Screenshot artıq preview-dən asılı deyil: hər qəbul edilmiş materialın ayrıca
      // arxiv görüntüsü olmalıdır. Canonical URL bilinəndə capture üçün onu üstün tuturuq.
      const queued=screenshotQueue.find(x=>String(x?.url||'')===String(target.url||''));
      if(queued) queued.capture_url=enriched.raw?.canonical_url||target.url;
    }

  }

  // Bazada əvvəldən olan Web materiallarını da eyni run daxilində mərhələli tam yenilə:
  // tam mətn, orijinal tarix, müəllif və yalnız xəbərə aid bir qapaq şəkli. Bu, köhnə
  // "Mətn saxlanmayıb" və discovery vaxtının səhvən paylaşım tarixi kimi qalmasını düzəldir.
  if(!gatewayBudgetLow()) {
    try {
      const backlog=await callMonitor({mode:'news_enrich_backfill_targets',organization_id:org.id,screenshot_limit:30},45000);
      const refreshTargets=Array.isArray(backlog?.targets)?backlog.targets:[];
      let refreshedCount=0;
      for(const target of refreshTargets){
        if(gatewayBudgetLow()) break;
        const enriched=await enrichPage({title:target.title||'',text:target.text||'',url:target.url,published_at:target.published_at||null,image:null,author:target.author||null,raw:target.raw||{}});
        try {
          const refreshed=await callMonitor({
            mode:'news_enrich',organization_id:org.id,source_url:target.url,
            title:enriched.title||target.title||'',text:enriched.text||target.text||'',
            image_url:enriched.image||'',image_urls:Array.isArray(enriched.raw?.image_urls)?enriched.raw.image_urls:[],
            published_at:reliablePublishedAt(enriched,target),author:enriched.author||null,
            canonical_url:enriched.raw?.canonical_url||target.url,page_enriched:enriched.raw?.enriched===true,published_date_source:enriched.raw?.published_date_source||'',date_parser_version:Number(enriched.raw?.date_parser_version||0)
          });
          if(refreshed?.ok) refreshedCount++;
          if(!target.has_screenshot) screenshotQueue.push({title:enriched.title||target.title||'',url:target.url,source_url:target.url,capture_url:enriched.raw?.canonical_url||target.url});
        } catch(e) { console.log(`[${org.short_name}] Arxiv metadata yeniləmə xətası: ${e?.message||e}`); }
      }
      if(refreshTargets.length) console.log(`[${org.short_name}] Arxiv tamamlama: namizəd=${refreshTargets.length}, yeniləndi=${refreshedCount}`);
    } catch(e) { console.log(`[${org.short_name}] Arxiv tamamlama növbəsi xətası: ${e?.message||e}`); }
  }

  // Yalnız yeni tapılan xəbərlər yox, bazada əvvəldən olan Web və YouTube qeydləri də
  // mərhələli şəkildə screenshot ilə tamamlanır. Hər run üçün limit kiçik saxlanılır;
  // beləliklə Supabase Free Storage/egress birdən-birə şişmir və növbəti run qaldığı
  // yerdən davam edir.
  if(MAX_SCREENSHOTS>0 && !gatewayBudgetLow()) {
    try {
      const backlog=await callMonitor({mode:'screenshot_backfill_targets',organization_id:org.id,screenshot_limit:Math.max(6,MAX_SCREENSHOTS*6)},45000);
      if(Array.isArray(backlog?.targets)) screenshotQueue.push(...backlog.targets);
      const uniqueTargets=dedupe(screenshotQueue.map(x=>({
        ...x,
        source_url:String(x?.source_url||x?.url||''),
        url:String(x?.url||x?.source_url||'')
      }))).filter(x=>x.source_url||x.url);
      let completed=0;
      for(const target of uniqueTargets) {
        if(completed>=MAX_SCREENSHOTS || gatewayBudgetLow()) break;
        const saved=await saveScreenshotForTarget(org,target);
        if(saved?.saved || saved?.skipped==='already-exists') completed++;
      }
      console.log(`[${org.short_name}] Screenshot növbəsi: namizəd=${uniqueTargets.length}, bu run tamamlandı=${completed}/${MAX_SCREENSHOTS}`);
    } catch(e) {
      console.log(`[${org.short_name}] Screenshot backlog xəta: ${e?.message||e}`);
    }
  }
}

console.log(`NEWS_GATEWAY_SUMMARY received=${totalReceived} accepted=${totalAccepted} rejected=${totalRejected} inserted=${totalInserted} fetch_failures=${totalFailures} ingest_chunk_failures=${totalChunkFailures}`);

// Yaşıl GitHub status yalnız bütün ingest paketləri Supabase-a çatanda verilməlidir.
// Discovery mənbəsinin müvəqqəti fetch xətası növbəti run-da təkrar olunur, amma ingest
// paketinin itməsi həmin run-ın yarımçıq olması deməkdir və artıq səssizcə yaşıl qalmır.
if (totalChunkFailures > 0) {
  throw new Error(`INCOMPLETE_RUN: ${totalChunkFailures} ingest paketi Supabase-a çatmadı. GitHub bu run-ı qırmızı göstərir və növbəti schedule yenidən yoxlayacaq.`);
}
console.log('NEWS_GATEWAY_HEALTH OK — bütün ingest paketləri tamamlandı.');
