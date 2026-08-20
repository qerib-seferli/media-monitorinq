import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

type Item = { title?:string; text?:string; url?:string; published_at?:string|null; image?:string|null; author?:string|null; raw?:unknown };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, service);
    const expected = Deno.env.get('MONITOR_SECRET');
    const secretOk = Boolean(expected && req.headers.get('x-monitor-secret') === expected);
    if (!secretOk) {
      const authHeader = req.headers.get('Authorization') || '';
      const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
      const caller = createClient(url, anon, { global:{ headers:{ Authorization:authHeader } } });
      const { data:{ user } } = await caller.auth.getUser();
      if (!user) throw new Error('İcazəsiz monitor sorğusu');
      const { data:profile } = await admin.from('profiles').select('system_role,is_active').eq('auth_user_id',user.id).maybeSingle();
      if (!profile?.is_active || profile.system_role !== 'super_admin') throw new Error('Yalnız Super Admin monitorinqi manual işə sala bilər');
    }
    const { data:orgs, error } = await admin.from('organizations')
      .select('id,name,short_name,district_id,districts(name),keywords(*),sources(*)')
      .in('service_status',['active','grace']);
    if (error) throw error;

    let checked = 0, inserted = 0, failures = 0;
    const details:any[] = [];

    for (const org of orgs || []) {
      const keywords = (org.keywords || []).filter((k:any)=>k.is_active !== false).map((k:any)=>String(k.value || '').trim()).filter(Boolean);
      const lowerKeywords = keywords.map((k:string)=>k.toLocaleLowerCase('az-AZ'));
      const sources = (org.sources || []).filter((s:any)=>s.is_active !== false);

      // Zero-cost discovery lane: Google News RSS. No API key is required.
      try {
        checked++;
        const rssItems = await googleNewsItems(org, keywords);
        let newsCount = 0;
        for (const item of rssItems.slice(0,30)) newsCount += await save(admin,org,{platform:'Google News',url:'https://news.google.com/'},item,lowerKeywords);
        inserted += newsCount;
        details.push({ organization:org.short_name, source:'Google News RSS', found:rssItems.length, inserted:newsCount });
      } catch (e) {
        failures++;
        console.error('google-news',org.short_name,e);
      }

      for (const source of sources) {
        checked++;
        try {
          const platform = String(source.platform || 'Web').toLowerCase();

          if (platform === 'youtube') {
            const last = source.last_checked_at ? new Date(source.last_checked_at).getTime() : 0;
            // YouTube search costs quota; do not spend it every 15 minutes.
            if (Date.now() - last < 6 * 3600 * 1000) continue;
            const key = Deno.env.get('YOUTUBE_API_KEY');
            if (!key) continue;
            const items = await youtubeItems(org, keywords, key);
            let count = 0;
            for (const item of items) count += await save(admin,org,source,item,lowerKeywords);
            inserted += count;
            details.push({ organization:org.short_name, source:'YouTube', found:items.length, inserted:count });
          } else if (platform === 'rss' || source.url?.match(/(\.xml|\.rss)(\?|$)/i) || String(source.url||'').includes('/rss')) {
            const response = await fetch(source.url,{headers:{'user-agent':'MediaMonitorinq/2.0'}});
            if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
            const items = parseRss(await response.text());
            let count = 0;
            for (const item of items.slice(0,30)) count += await save(admin,org,source,item,lowerKeywords);
            inserted += count;
            details.push({ organization:org.short_name, source:source.url, found:items.length, inserted:count });
          } else {
            const item = await pageItem(source.url, source.name || source.url);
            inserted += await save(admin,org,source,item,lowerKeywords);
          }

          await admin.from('sources').update({last_checked_at:new Date().toISOString()}).eq('id',source.id);
        } catch (e) {
          failures++;
          console.error('source',source.url,e);
        }
      }
    }

    return json({ok:true,checked_sources:checked,new_mentions:inserted,failures,details});
  } catch (e) {
    return json({ok:false,error:e.message || String(e)},400);
  }
});

async function googleNewsItems(org:any, keywords:string[]):Promise<Item[]> {
  const strong = [org.short_name, org.name, ...keywords]
    .filter(Boolean)
    .filter((v:string,i:number,a:string[])=>a.indexOf(v)===i)
    .slice(0,6);
  // Separate phrases with OR so one huge AND-query does not miss relevant mentions.
  const query = strong.map((v:string)=>`"${v.replaceAll('"','')}"`).join(' OR ');
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=az&gl=AZ&ceid=AZ:az`;
  const response = await fetch(url,{headers:{'user-agent':'MediaMonitorinq/2.0'}});
  if (!response.ok) throw new Error(`Google News RSS HTTP ${response.status}`);
  return parseRss(await response.text());
}

async function youtubeItems(org:any, keywords:string[], key:string):Promise<Item[]> {
  const q = [org.short_name, ...keywords.filter(k=>/bərdə|suvarma|kanal|arx/i.test(k)).slice(0,2)].filter(Boolean).join(' ');
  const after = new Date(Date.now()-48*3600*1000).toISOString();
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&order=date&publishedAfter=${encodeURIComponent(after)}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || `YouTube HTTP ${response.status}`);
  return (data.items || []).map((x:any)=>({
    title:x.snippet?.title || '',
    text:x.snippet?.description || '',
    url:x.id?.videoId ? `https://www.youtube.com/watch?v=${x.id.videoId}` : '',
    published_at:x.snippet?.publishedAt || null,
    image:x.snippet?.thumbnails?.high?.url || x.snippet?.thumbnails?.medium?.url || null,
    author:x.snippet?.channelTitle || null,
    raw:x
  }));
}

async function pageItem(url:string, fallback:string):Promise<Item> {
  const res = await fetch(url,{headers:{'user-agent':'MediaMonitorinq/2.0'}});
  if (!res.ok) throw new Error(`Web HTTP ${res.status}`);
  const html = await res.text();
  const title = clean(meta(html,'og:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback);
  const description = clean(meta(html,'og:description') || meta(html,'description') || '');
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).slice(0,14000);
  return { title, text:`${description}\n${text}`.trim(), url, image:meta(html,'og:image') || null, published_at:meta(html,'article:published_time') || null };
}

async function save(admin:any, org:any, source:any, item:Item, keywords:string[]) {
  if (!item.url) return 0;
  const normalized = `${item.title || ''} ${item.text || ''}`.toLocaleLowerCase('az-AZ');
  const direct = [String(org.name||''),String(org.short_name||'')].map(x=>x.toLocaleLowerCase('az-AZ')).filter(Boolean);
  const matches = [...new Set([...direct,...keywords].filter(k=>k && normalized.includes(k)))];
  if (!matches.length) return 0;

  const negativeWords = ['şikayət','problem','su yoxdur','su gəlmir','verilmir','quruyur','narazı','etiraz','çatışmazlıq','susuz','kanal təmizlənmir'];
  const positiveWords = ['təşəkkür','bərpa olundu','təmir edildi','su verildi','işlər başa çatdı'];
  const neg = negativeWords.some(x=>normalized.includes(x));
  const pos = !neg && positiveWords.some(x=>normalized.includes(x));
  const directHit = direct.some(x=>normalized.includes(x));
  const relevance = Math.min(100, 40 + Math.min(4,matches.length)*10 + (directHit?25:0));
  const priority = Math.min(100, relevance + (neg?15:0));
  const sentiment = neg ? 'negative' : pos ? 'positive' : 'neutral';

  let summary = clean(item.text || '').slice(0,520);
  let topic = neg ? 'Potensial problem / şikayət' : 'Media qeydi';
  const ai = await optionalAiAnalysis(org,item,relevance,sentiment);
  if (ai?.summary) summary = String(ai.summary).slice(0,700);
  if (ai?.topic) topic = String(ai.topic).slice(0,160);

  const hash = await sha256(`${org.id}|${item.url}|${item.title||''}`);
  const row:any = {
    organization_id:org.id,
    district_id:org.district_id || null,
    source_platform:source.platform || 'Web',
    source_url:item.url,
    author_name:item.author || null,
    title:item.title || 'Monitorinq qeydi',
    original_text:item.text || '',
    summary,
    topic,
    mention_type:neg ? 'complaint' : 'media',
    sentiment,
    priority_score:priority,
    relevance_score:ai?.relevance_score ? clamp(ai.relevance_score) : relevance,
    published_at:item.published_at || null,
    content_hash:hash,
    raw_payload:item.raw || item
  };

  const { data, error } = await admin.from('mentions')
    .upsert(row,{onConflict:'organization_id,content_hash',ignoreDuplicates:true})
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return 0;

  if (item.image) {
    await admin.from('mention_media').insert({mention_id:data.id,media_type:'preview',url:item.image,captured_at:new Date().toISOString()});
  }
  if (priority >= 81) {
    await admin.from('notifications').insert({organization_id:org.id,mention_id:data.id,title:'Yüksək prioritetli yeni qeyd',body:item.title || 'Yeni material',kind:'critical'});
  }
  return 1;
}

async function optionalAiAnalysis(org:any,item:Item,relevance:number,sentiment:string) {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey || relevance < 60) return null;
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
  const prompt = `Sən Azərbaycan dilində media monitorinq analitikisən. Təşkilat: ${org.name} (${org.short_name}). Aşağıdakı materialı yalnız bu təşkilata aidiyyət baxımından qısa analiz et. JSON qaytar: {"summary":"...","topic":"...","relevance_score":0-100}. Fakt uydurma. Başlıq: ${item.title||''}\nMətn: ${(item.text||'').slice(0,4000)}`;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}})
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) { console.error('ai-analysis',e); return null; }
}

function parseRss(xml:string):Item[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(x=>x[0]);
  return blocks.map(b=>({
    title:decode(tag(b,'title')),
    text:decode(tag(b,'description') || tag(b,'summary') || tag(b,'content')),
    url:decode(tag(b,'link') || b.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || ''),
    published_at:tag(b,'pubDate') || tag(b,'published') || tag(b,'updated') || null,
    author:decode(tag(b,'source') || tag(b,'author') || ''),
    image:b.match(/<media:content[^>]+url=["']([^"']+)/i)?.[1] || b.match(/<media:thumbnail[^>]+url=["']([^"']+)/i)?.[1] || null
  }));
}
function meta(html:string,name:string){const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,'i'))?.[1] || ''}
function tag(s:string,n:string){return s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`,'i'))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').trim()||''}
function clean(s:string){return decode(String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())}
function decode(s:string){return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')}
function clamp(v:any){const n=Number(v||0);return Math.max(0,Math.min(100,Math.round(n)))}
async function sha256(input:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})}
