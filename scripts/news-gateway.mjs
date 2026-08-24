const MONITOR_URL = process.env.MONITOR_URL || 'https://xsmahlsqdszxqordgcvt.supabase.co/functions/v1/monitor-worker';
const MONITOR_SECRET = process.env.MONITOR_SECRET || '';
if (!MONITOR_SECRET) {
  console.log('MONITOR_SECRET yoxdur; Web/Xəbər gateway buraxıldı.');
  process.exit(0);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 MediaMonitorinqGateway/1.0';

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {headers:{'user-agent':UA,'accept':'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.7'}, signal:controller.signal});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function callMonitor(body) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 30000);
  try {
    const res = await fetch(MONITOR_URL, {
      method:'POST',
      headers:{'content-type':'application/json','x-monitor-secret':MONITOR_SECRET},
      body:JSON.stringify(body),
      signal:controller.signal
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
function parseRss(xml, rawKind, discoveryQuery, provider) {
  const blocks = [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
  return blocks.map(block=>{
    const title = stripHtml(tag(block,'title'));
    let url = stripHtml(tag(block,'link'));
    if (!url) url = stripHtml(tag(block,'guid'));
    const description = stripHtml(tag(block,'description'));
    const pub = stripHtml(tag(block,'pubDate'));
    const source = stripHtml(tag(block,'source'));
    const enclosure = block.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] || null;
    let published_at = null;
    if (pub) {
      const d = new Date(pub);
      if (!Number.isNaN(d.getTime())) published_at = d.toISOString();
    }
    return {title,text:description,url,published_at,image:enclosure,author:source || null,raw:{kind:rawKind,provider,discovery_query:discoveryQuery}};
  }).filter(x=>x.url && x.title);
}
function dedupe(items) {
  const seen = new Set();
  return items.filter(x=>{const k=x.url||`${x.title}|${x.published_at||''}`; if(!k||seen.has(k)) return false; seen.add(k); return true;});
}

async function googleNews(query) {
  const locales = [
    ['az','AZ','AZ:az'], ['ru','RU','RU:ru'], ['en-US','US','US:en']
  ];
  const settled = await Promise.allSettled(locales.map(async ([hl,gl,ceid])=>{
    const u = new URL('https://news.google.com/rss/search');
    u.searchParams.set('q',query); u.searchParams.set('hl',hl); u.searchParams.set('gl',gl); u.searchParams.set('ceid',ceid);
    const xml = await fetchText(u.toString(),12000);
    return parseRss(xml,'google_news',query,`Google News ${hl}-${gl}`);
  }));
  const out=[]; const errors=[];
  settled.forEach((r,i)=>r.status==='fulfilled'?out.push(...r.value):errors.push(String(r.reason?.message||r.reason)));
  return {items:dedupe(out),errors};
}

async function bingNews(query) {
  const u = new URL('https://www.bing.com/news/search');
  u.searchParams.set('q',query); u.searchParams.set('format','rss'); u.searchParams.set('setlang','az'); u.searchParams.set('cc','AZ');
  const xml = await fetchText(u.toString(),12000);
  return parseRss(xml,'bing_news',query,'Bing News RSS');
}

async function gdeltNews(query) {
  const u = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  u.searchParams.set('query',query); u.searchParams.set('mode','artlist'); u.searchParams.set('maxrecords','75');
  u.searchParams.set('format','rssarchive'); u.searchParams.set('sort','datedesc'); u.searchParams.set('timespan','3months');
  const xml = await fetchText(u.toString(),18000);
  return parseRss(xml,'gdelt_article',query,'GDELT DOC 2.0');
}

const plan = await callMonitor({mode:'news_plan'});
if (!plan?.ok || !Array.isArray(plan.organizations)) throw new Error(`News plan alınmadı: ${JSON.stringify(plan).slice(0,800)}`);

let totalReceived=0, totalInserted=0, totalFailures=0;
for (const org of plan.organizations) {
  const googleQueries = (org.google_queries || []).slice(0,2);
  const gdeltQueries = (org.gdelt_queries || []).slice(0,2);
  const googleItems=[]; const webItems=[];

  for (const q of googleQueries) {
    const [g,b] = await Promise.allSettled([googleNews(q),bingNews(q)]);
    if (g.status==='fulfilled') {
      googleItems.push(...g.value.items);
      if (g.value.errors.length) console.log(`[${org.short_name}] Google locale xətaları:`, g.value.errors.join(' | '));
    } else { totalFailures++; console.log(`[${org.short_name}] Google News xəta:`, g.reason?.message||g.reason); }
    if (b.status==='fulfilled') webItems.push(...b.value);
    else { totalFailures++; console.log(`[${org.short_name}] Bing News xəta:`, b.reason?.message||b.reason); }
  }
  for (const q of gdeltQueries) {
    try { webItems.push(...await gdeltNews(q)); }
    catch (e) { totalFailures++; console.log(`[${org.short_name}] GDELT xəta:`, e?.message||e); }
  }

  const batches = [
    {platform:'Google News',label:'Google News RSS / GitHub Gateway',items:dedupe(googleItems).slice(0,200)},
    {platform:'Web',label:'Web / Bing + GDELT / GitHub Gateway',items:dedupe(webItems).slice(0,250)}
  ];
  for (const batch of batches) {
    if (!batch.items.length) {
      console.log(`[${org.short_name}] ${batch.label}: 0 material`);
      continue;
    }
    const result = await callMonitor({mode:'news_ingest',organization_id:org.id,source_platform:batch.platform,source_label:batch.label,items:batch.items});
    totalReceived += Number(result?.received||0); totalInserted += Number(result?.inserted||0);
    console.log(`[${org.short_name}] ${batch.label}: received=${result?.received||0}, accepted=${result?.accepted||0}, rejected=${result?.rejected||0}, inserted=${result?.inserted||0}`);
  }
}
console.log(`NEWS_GATEWAY_SUMMARY received=${totalReceived} inserted=${totalInserted} fetch_failures=${totalFailures}`);
