import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  try {
    if (req.headers.get('x-monitor-secret') !== Deno.env.get('MONITOR_SECRET')) throw new Error('İcazəsiz monitor sorğusu');
    const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:orgs,error}=await admin.from('organizations').select('id,name,short_name,districts(name),keywords(*),sources(*)').in('service_status',['active','grace']);
    if(error)throw error;
    let checked=0,inserted=0;
    for(const org of orgs||[]){
      const keywords=(org.keywords||[]).filter((k:any)=>k.is_active).map((k:any)=>String(k.value).toLowerCase());
      const sources=(org.sources||[]).filter((s:any)=>s.is_active);
      for(const source of sources){
        checked++;
        try{
          const platform=String(source.platform||'Web').toLowerCase();
          if(platform==='rss'||source.url?.match(/\.(xml|rss)(\?|$)/i)){
            const text=await (await fetch(source.url,{headers:{'user-agent':'MediaMonitorinq/1.0'}})).text();
            for(const item of parseRss(text).slice(0,20)) inserted+=await save(admin,org,source,item,keywords);
          }else if(platform==='youtube'){
            const key=Deno.env.get('YOUTUBE_API_KEY'); if(!key)continue;
            const q=encodeURIComponent([org.short_name,...keywords.slice(0,4)].join(' '));
            const after=new Date(Date.now()-24*3600*1000).toISOString();
            const url=`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&order=date&publishedAfter=${encodeURIComponent(after)}&q=${q}&key=${key}`;
            const data=await (await fetch(url)).json();
            for(const x of data.items||[]) inserted+=await save(admin,org,source,{title:x.snippet?.title||'',text:x.snippet?.description||'',url:`https://www.youtube.com/watch?v=${x.id?.videoId}`,published_at:x.snippet?.publishedAt},keywords);
          }else{
            const res=await fetch(source.url,{headers:{'user-agent':'MediaMonitorinq/1.0'}}); if(!res.ok)continue;
            const html=await res.text();const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||source.name||source.url).replace(/<[^>]+>/g,' ').trim();
            const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,12000);
            inserted+=await save(admin,org,source,{title,text,url:source.url,published_at:null},keywords);
          }
          await admin.from('sources').update({last_checked_at:new Date().toISOString()}).eq('id',source.id);
        }catch(e){console.error('source',source.url,e)}
      }
    }
    return json({ok:true,checked_sources:checked,new_mentions:inserted});
  }catch(e){return json({ok:false,error:e.message||String(e)},400)}
});

async function save(admin:any,org:any,source:any,item:any,keywords:string[]){
  const text=`${item.title||''} ${item.text||''}`.toLowerCase();
  const direct=[String(org.name||'').toLowerCase(),String(org.short_name||'').toLowerCase()].filter(Boolean);
  const matches=[...direct,...keywords].filter(k=>k&&text.includes(k));
  if(!matches.length)return 0;
  const relevance=Math.min(100,35+matches.length*12+(direct.some(x=>text.includes(x))?25:0));
  const negativeWords=['şikayət','problem','su yoxdur','su gəlmir','verilmir','quruyur','narazı','etiraz','çatışmazlıq'];
  const neg=negativeWords.some(x=>text.includes(x));
  const priority=Math.min(100,relevance+(neg?15:0));
  const hash=await sha256(`${org.id}|${item.url}|${item.title||''}`);
  const {data,error}=await admin.from('mentions').upsert({organization_id:org.id,source_platform:source.platform||'Web',source_url:item.url,title:item.title||'Monitorinq qeydi',original_text:item.text||'',summary:(item.text||'').slice(0,500),sentiment:neg?'negative':'neutral',priority_score:priority,relevance_score:relevance,published_at:item.published_at||null,content_hash:hash,raw_payload:item},{onConflict:'organization_id,content_hash',ignoreDuplicates:true}).select('id').maybeSingle();
  if(error)throw error;if(!data)return 0;
  if(priority>=81)await admin.from('notifications').insert({organization_id:org.id,mention_id:data.id,title:'Yüksək prioritetli yeni qeyd',body:item.title||'Yeni material',kind:'critical'});
  return 1;
}
function parseRss(xml:string){const blocks=[...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(x=>x[0]);return blocks.map(b=>({title:decode(tag(b,'title')),text:decode(tag(b,'description')||tag(b,'summary')||tag(b,'content')),url:decode(tag(b,'link')||b.match(/<link[^>]+href=["']([^"']+)/i)?.[1]||''),published_at:tag(b,'pubDate')||tag(b,'published')||null}))}
function tag(s:string,n:string){return s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`,'i'))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').trim()||''}
function decode(s:string){return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")}
async function sha256(input:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})}
