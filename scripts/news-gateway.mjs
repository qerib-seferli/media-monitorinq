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
    const enclosure = attr(block,'enclosure','url') || attr(block,'media:content','url') || null;
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
function dedupe(items) {
  const seen = new Set();
  return items.filter(x=>{
    const k=(x.url||`${x.title}|${x.published_at||''}`).trim();
    if(!k||seen.has(k)) return false;
    seen.add(k); return true;
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

async function enrichPage(item) {
  if (!item?.url || /news\.google\.com/i.test(item.url)) return item;
  try {
    const html = await fetchText(item.url,{timeoutMs:9000,retries:0,minGapMs:650});
    const title = firstMatch(html,[/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,/<title[^>]*>([\s\S]*?)<\/title>/i]);
    const desc = firstMatch(html,[/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i]);
    const image = firstMatch(html,[/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i]);
    const published = firstMatch(html,[/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+(?:name|itemprop)=["']datePublished["'][^>]+content=["']([^"']+)["']/i,/"datePublished"\s*:\s*"([^"]+)"/i]);
    return {...item,title:stripHtml(title)||item.title,text:stripHtml(desc)||item.text,image:image||item.image,published_at:normalizeDate(published)||item.published_at,raw:{...(item.raw||{}),enriched:true}};
  } catch { return item; }
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
  const args=['--headless=new','--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1365,900',`--screenshot=${file}`,target.url];
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

async function directFeed(source, orgName) {
  if (!source?.url) return [];
  // Google News axtarış feed-ləri ayrıca discovery lane ilə idarə olunur.
  if (/news\.google\.com\/rss\/search/i.test(source.url)) return [];
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
  const coreQueries = allGoogle.slice(0,3);
  const rotatingQueries = allGoogle.slice(3);
  const selectedQueries = [...new Set([...coreQueries, ...rotate(rotatingQueries,3,org.id)])].slice(0,6);
  console.log(`[${org.short_name}] Discovery sorğuları: ${selectedQueries.join(' || ')}`);

  const googleItems=[];
  const webItems=[];

  for (const q of selectedQueries) {
    try {
      const g = await googleNews(q);
      googleItems.push(...g.items);
      if (g.errors.length) console.log(`[${org.short_name}] Google locale xətaları (${q}): ${g.errors.join(' | ')}`);
    } catch (e) {
      totalFailures++; console.log(`[${org.short_name}] Google News xəta (${q}):`, e?.message||e);
    }

    try {
      webItems.push(...await bingNews(q,0));
      webItems.push(...await bingWeb(q,0));
      // Əsas rayon sorğularında ikinci səhifəni də oxuyuruq ki ilk 10 nəticə ilə məhdudlaşmayaq.
      if (selectedQueries.indexOf(q) < 2) {
        webItems.push(...await bingNews(q,1));
        webItems.push(...await bingWeb(q,1));
      }
    } catch (e) { totalFailures++; console.log(`[${org.short_name}] Bing discovery xəta (${q}):`, e?.message||e); }
  }

  // Admin paneldə əl ilə əlavə olunan normal RSS/Atom feed-ləri birbaşa oxu.
  for (const source of (Array.isArray(org.rss_sources)?org.rss_sources:[]).slice(0,12)) {
    const items = await directFeed(source,org.short_name);
    if (/google/i.test(source.platform||source.name||'')) googleItems.push(...items);
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
  const googleDeduped=dedupe(googleItems).slice(0,220);
  const webDeduped=dedupe(webItems).slice(0,260);
  const enrichedWeb=[];
  for (const item of webDeduped.slice(0,36)) enrichedWeb.push(await enrichPage(item));
  enrichedWeb.push(...webDeduped.slice(36));

  const batches = [
    {platform:'Google News',label:'Google News RSS / GitHub Gateway',items:googleDeduped},
    {platform:'Web',label:'Web / Bing News + Bing Web + RSS / GitHub Gateway',items:dedupe(enrichedWeb)}
  ];

  for (const batch of batches) {
    if (!batch.items.length) {
      console.log(`[${org.short_name}] ${batch.label}: 0 material`);
      continue;
    }
    const result = await callMonitor({
      mode:'news_ingest',organization_id:org.id,source_platform:batch.platform,
      source_label:batch.label,items:batch.items
    });
    totalReceived += Number(result?.received||0);
    totalAccepted += Number(result?.accepted||0);
    totalRejected += Number(result?.rejected||0);
    totalInserted += Number(result?.inserted||0);
    console.log(`[${org.short_name}] ${batch.label}: received=${result?.received||0}, accepted=${result?.accepted||0}, rejected=${result?.rejected||0}, inserted=${result?.inserted||0}`);
    logIngestSamples(org.short_name,batch.label,result);

    // Yalnız filtrlərdən keçmiş və bazada screenshot-u olmayan xəbərlər üçün arxiv görüntüsü alırıq.
    // Bir run-da limit saxlanılır ki GitHub Action uzanmasın.
    const screenshotTargets=Array.isArray(result?.screenshot_targets)?result.screenshot_targets.slice(0,6):[];
    for (const target of screenshotTargets) {
      const shot=await captureScreenshot(target);
      if (!shot) { console.log(`[${org.short_name}] Screenshot alınmadı: ${String(target?.url||'').slice(0,120)}`); continue; }
      try {
        const saved=await callMonitor({mode:'news_screenshot',organization_id:org.id,source_url:target.url,image_base64:shot.base64,mime_type:shot.mime_type});
        console.log(`[${org.short_name}] Screenshot: ${saved?.ok && saved?.saved ? 'SAXLANDI' : (saved?.skipped||saved?.error||'buraxıldı')} | ${String(target?.title||target?.url||'').slice(0,100)}`);
      } catch(e) { console.log(`[${org.short_name}] Screenshot upload xəta: ${e?.message||e}`); }
    }
  }
}

console.log(`NEWS_GATEWAY_SUMMARY received=${totalReceived} accepted=${totalAccepted} rejected=${totalRejected} inserted=${totalInserted} fetch_failures=${totalFailures}`);
