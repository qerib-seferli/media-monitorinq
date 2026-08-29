import { supabase, escapeHtml } from './core.js';

let excludePromise=null;
const fold=v=>String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKC').replace(/\s+/g,' ').trim();
export async function loadGlobalExcludes(){
  if(!excludePromise) excludePromise=(async()=>{
    const {data,error}=await supabase.from('keywords').select('value').is('organization_id',null).eq('is_active',true).eq('kind','exclude').limit(1000);
    if(error){console.warn('Qlobal filtr bankı yüklənmədi',error);return [];}
    return [...new Set((data||[]).map(x=>fold(x.value)).filter(x=>x.length>=3))].sort((a,b)=>b.length-a.length);
  })();
  return excludePromise;
}
export function resetGlobalExcludeCache(){ excludePromise=null; }
export function isMentionExcluded(row,excludes=[]){
  if(!row||!excludes.length) return false;
  const hay=fold([row.title,row.summary,row.original_text].filter(Boolean).join(' '));
  return excludes.some(term=>term&&hay.includes(term));
}
export function filterExcludedMentions(rows,excludes=[]){return (rows||[]).filter(row=>!isMentionExcluded(row,excludes));}
export function youtubeVideoId(row){
  const raw=row?.raw_payload||{};
  for(const value of [raw.video_id,raw.videoId,raw.parent_video_id,raw.video?.id,row?.source_url]){
    const text=String(value||'');
    const direct=text.match(/^[A-Za-z0-9_-]{11}$/)?.[0]; if(direct) return direct;
    const m=text.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/); if(m) return m[1];
  }
  return '';
}
export function mentionPreviewUrl(row){
  const media=Array.isArray(row?.mention_media)?row.mention_media:[];
  const ranked=[...media].filter(x=>x?.url).sort((a,b)=>({preview:0,screenshot:1,preview_external:2}[String(a?.media_type||'').toLowerCase()]??9)-({preview:0,screenshot:1,preview_external:2}[String(b?.media_type||'').toLowerCase()]??9));
  if(ranked[0]?.url) return ranked[0].url;
  if(String(row?.source_platform||'').toLowerCase().includes('youtube')){const id=youtubeVideoId(row);if(id)return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;}
  return './assets/img/icon.svg';
}


export function isCentralScope(profile){
  return profile?.system_role === 'super_admin' || profile?.access_scope === 'all';
}

export async function setupOrganizationFilter(profile, select){
  if(!select || !isCentralScope(profile)){
    select?.classList.add('hidden');
    select?.classList.remove('scope-filter-pending');
    return select || null;
  }
  const {data,error}=await supabase.from('organizations').select('id,short_name,name,service_status').order('short_name');
  if(error) throw error;
  // Nazirlik / mərkəzi istifadəçi bütün reyestri görməlidir. Arxiv statusu yalnız
  // monitorinq işinin prioritetidir; filtrdən təşkilatı gizlətməməlidir.
  const items=(data||[]);
  select.innerHTML='<option value="">Bütün təşkilatlar</option>'+items.map(o=>`<option value="${o.id}">${escapeHtml(o.short_name||o.name||'Təşkilat')}</option>`).join('');
  select.classList.remove('hidden','scope-filter-pending');
  return select;
}

export function applyOrganizationScope(query, profile, organizationId=''){
  if(isCentralScope(profile)) return organizationId ? query.eq('organization_id',organizationId) : query;
  return profile?.organization_id ? query.eq('organization_id',profile.organization_id) : query;
}
