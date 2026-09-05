import { supabase, escapeHtml } from './core.js';

let excludePromise=null;
const fold=v=>String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKC').replace(/\s+/g,' ').trim();
const foldLoose=v=>fold(v).normalize('NFKD').replace(/[əƏ]/g,'e').replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[çÇ]/g,'c').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ğĞ]/g,'g').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
export async function loadGlobalExcludes(){
  if(!excludePromise) excludePromise=(async()=>{
    const {data,error}=await supabase.from('keywords').select('value').is('organization_id',null).eq('is_active',true).eq('kind','exclude').limit(1000);
    if(error){console.warn('Qlobal filtr bankı yüklənmədi',error);return [];}
    return [...new Set((data||[]).map(x=>fold(x.value)).filter(x=>x.length>=3))].sort((a,b)=>b.length-a.length);
  })();
  return excludePromise;
}
export function resetGlobalExcludeCache(){ excludePromise=null; }
function protectedExcludeTerms(row){
  const protectedSet=new Set([
    'su','sukanal','suvarma','meliorasiya','kanalizasiya','kollektor','drenaj',
    'subartezian','artezian','irriqasiya','nasos','quyu','su təchizatı',
    'adsea','smsii','rsmx','isst','isbtx','simdnx','sdnx','smeti','smkli','toom'
  ].map(fold));
  const orgName=fold(row?.organizations?.short_name||row?.organizations?.name||'');
  const districtName=fold(row?.districts?.name||'');
  for(const source of [orgName,districtName]){
    source.split(/\s+/).filter(x=>x.length>=3).forEach(x=>protectedSet.add(x));
  }
  return protectedSet;
}
const BUILTIN_NOISE=[
  'haryanvi song','dance video','music video','full video','viralshort','viral short','youtube shorts','shortvideo',
  'minivlog','mini vlog','daily vlog','travel vlog','gaming','gameplay','football match','football highlights','kuboku',
  'concert','konsert','movie trailer','film trailer','serial episode','makeup tutorial','fashion show','cute baby',
  'dj remix','remix song','new song','romantic song','love song','haryanvi','bhojpuri','punjabi song','official song',
  'stock market','cryptocurrency','forex trading','casino','betting','unboxing','smartphone review','car review','recipe video','cooking recipe',
  'football','soccer','cup match','kuboku','vlog','shorts','viral','rock music','concert hall',
  'narkotik vasitə','narkotik maddə','marşrutun hərəkət sxemi','nəqliyyat vasitələrinin hərəkəti','ayna nəqliyyat',
  'kanal 7 televiziyası','kanal 7 televiziyasi','televiziya kanalı','televiziya kanali','tv kanalı','tv kanali',
  'regional mədəniyyət idarəsi','regional medeniyyet idaresi','dağlıq şirvan regional mədəniyyət','dagliq sirvan regional medeniyyet',
  'turizm reportajı','turizm reportaji','dünyayı geziyorum','dunyayi geziyorum','dünyanın tadı','dunyanin tadi'
].map(fold);
const WATER_SIGNAL_RE=/(?:suvar|melior|subartez|artez|drenaj|kollektor|irriq|sukanal|su təchiz|su techiz|içməli su|icmeli su|kanalizasiya|nasos stans|su anbar|su xətti|su xetti|quyu təmir|quyu temir)/i;
const HARD_FOREIGN_SCRIPT_RE=/[\u0600-\u06FF\u0900-\u0D7F\u0E00-\u0FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u;
export function isMentionExcluded(row,excludes=[]){
  if(!row) return false;
  const raw=[row.title,row.summary,row.original_text].filter(Boolean).join(' ');
  const hay=fold(raw);
  const hasWaterSignal=WATER_SIGNAL_RE.test(hay);
  if(!hasWaterSignal && BUILTIN_NOISE.some(term=>hay.includes(term))) return true;
  if(!hasWaterSignal && HARD_FOREIGN_SCRIPT_RE.test(raw)) return true;
  if(!excludes.length) return false;
  const protectedSet=protectedExcludeTerms(row);
  const looseHay=foldLoose(raw);
  return excludes.some(term=>{
    const t=fold(term), loose=foldLoose(term);
    if(!t || protectedSet.has(t) || protectedSet.has(loose)) return false;
    return hay.includes(t) || (loose.length>=3 && looseHay.includes(loose));
  });
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
  const ranked=[...media].filter(x=>x?.url).sort((a,b)=>({preview_external:0,preview:1,screenshot:2}[String(a?.media_type||'').toLowerCase()]??9)-({preview_external:0,preview:1,screenshot:2}[String(b?.media_type||'').toLowerCase()]??9));
  if(ranked[0]?.url) return ranked[0].url;
  // Xəbər şəkli Supabase Storage-a kopyalanmır: orijinal CDN URL-i istifadə olunur.
  // Bu, şəkil egressini ciddi azaldır; screenshot yalnız həqiqətən lazım olanda arxivlənir.
  const external=String(row?.raw_payload?.image_url||row?.raw_payload?.image||'').trim();
  if(/^https?:\/\//i.test(external)) return external;
  if(String(row?.source_platform||'').toLowerCase().includes('youtube')){const id=youtubeVideoId(row);if(id)return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;}
  return './assets/img/icon.svg';
}


export function isCentralScope(profile){
  return profile?.system_role === 'super_admin' || profile?.access_scope === 'all';
}

export async function setupOrganizationFilter(profile, select){
  if(!select) return null;
  if(!isCentralScope(profile)){
    const ownId=profile?.organization_id || '';
    const ownName=profile?.organizations?.short_name || profile?.organizations?.name || 'Təşkilatım';
    select.innerHTML=`<option value="${escapeHtml(ownId)}">${escapeHtml(ownName)}</option>`;
    select.value=ownId;
    select.disabled=true;
    // Yerli/rayon istifadəçisi öz təşkilatından çıxa bilməz. Təşkilat adı artıq
    // başlıqda göstərildiyi üçün ayrıca filtr nə telefonda, nə də kompüterdə təkrarlanmır.
    select.classList.add('hidden','scope-filter-local');
    select.classList.remove('scope-filter-pending');
    select.setAttribute('aria-label','Cari təşkilat');
    select.setAttribute('aria-hidden','true');
    return select;
  }
  select.disabled=true;
  select.innerHTML='<option value="">Təşkilatlar yüklənir…</option>';
  select.classList.remove('hidden','scope-filter-pending','scope-filter-local');
  const {data,error}=await supabase.from('organizations').select('id,short_name,name,service_status').order('short_name');
  if(error) throw error;
  // Nazirlik / mərkəzi istifadəçinin monitorinq filtrində yalnız hazırda istifadə olunan
  // təşkilatlar göstərilir. Arxiv qeydləri tarix, alias və köhnə nəticələrin bütövlüyü üçün
  // bazada/admin reyestrində saxlanılır, amma gündəlik monitorinq filtrini qarışdırmır.
  const items=(data||[]).filter(o=>['active','grace'].includes(o.service_status));
  select.innerHTML='<option value="">Bütün təşkilatlar</option>'+items.map(o=>`<option value="${o.id}">${escapeHtml(o.short_name||o.name||'Təşkilat')}</option>`).join('');
  select.disabled=false;
  select.classList.remove('hidden','scope-filter-pending');
  return select;
}

export function applyOrganizationScope(query, profile, organizationId=''){
  if(isCentralScope(profile)) return organizationId ? query.eq('organization_id',organizationId) : query;
  return profile?.organization_id ? query.eq('organization_id',profile.organization_id) : query;
}
