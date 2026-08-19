import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const secret = Deno.env.get('INGEST_SECRET');
    if (!secret || req.headers.get('x-ingest-secret') !== secret) throw new Error('İcazəsiz ingest sorğusu');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json();
    if (!body.organization_id || !body.source_url) throw new Error('organization_id və source_url tələb olunur');
    const text = `${body.title || ''}\n${body.original_text || ''}\n${body.source_url || ''}`;
    const hash = await sha256(`${body.organization_id}|${text}`);
    const row = {
      organization_id: body.organization_id,
      district_id: body.district_id || null,
      village_id: body.village_id || null,
      source_platform: body.source_platform || 'Web',
      source_url: body.source_url,
      source_post_id: body.source_post_id || null,
      author_name: body.author_name || null,
      title: body.title || 'Monitorinq qeydi',
      original_text: body.original_text || '',
      summary: body.summary || '',
      topic: body.topic || null,
      mention_type: body.mention_type || null,
      sentiment: body.sentiment || 'neutral',
      priority_score: clamp(body.priority_score),
      relevance_score: clamp(body.relevance_score),
      published_at: body.published_at || null,
      raw_payload: body.raw_payload || body,
      content_hash: hash
    };
    const { data, error } = await admin.from('mentions').upsert(row,{onConflict:'organization_id,content_hash',ignoreDuplicates:true}).select().maybeSingle();
    if (error) throw error;
    if (data?.id && Array.isArray(body.media)) {
      const media = body.media.filter((x:any)=>x?.url).map((x:any)=>({mention_id:data.id,media_type:x.media_type||'preview',url:x.url,width:x.width||null,height:x.height||null,file_hash:x.file_hash||null,captured_at:x.captured_at||new Date().toISOString()}));
      if (media.length) await admin.from('mention_media').insert(media);
    }
    if (data?.id && Number(row.priority_score) >= 81) {
      await admin.from('notifications').insert({organization_id:body.organization_id,mention_id:data.id,title:'Yüksək prioritetli yeni qeyd',body:row.title,kind:'critical'});
    }
    return json({ok:true,mention:data});
  } catch(e) { return json({ok:false,error:e.message||String(e)},400); }
});
function clamp(v:any){const n=Number(v||0);return Math.max(0,Math.min(100,Math.round(n)))}
async function sha256(input:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})}
