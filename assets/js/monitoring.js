import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';
import { applyOrganizationScope, isCentralScope, setupOrganizationFilter, loadGlobalExcludes, filterExcludedMentions, mentionPreviewUrl } from './scope.js';

const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'monitoring'); showPageLoader();
const ctx=await requireAuth(); if(!ctx) throw new Error('auth'); renderShell(ctx.profile,'monitoring'); hidePageLoader();

const organizationFilter=document.querySelector('#organization-filter');
await setupOrganizationFilter(ctx.profile, organizationFilter);
const list=document.querySelector('#list');
const platform=document.querySelector('#platform');
const sentiment=document.querySelector('#sentiment');
const period=document.querySelector('#period');
const dateFrom=document.querySelector('#date-from');
const dateTo=document.querySelector('#date-to');
const sentinel=document.querySelector('#load-sentinel');
const platformSwitcher=document.querySelector('#platform-switcher');
const PAGE_SIZE=50;
let rows=[], page=0, loading=false, done=false, requestToken=0;
const globalExcludes=await loadGlobalExcludes();
function canonicalPlatform(value=''){
  const p=String(value||'').trim().toLowerCase();
  if(p.includes('youtube'))return 'YouTube';
  if(p.includes('facebook'))return 'Facebook';
  if(p.includes('instagram'))return 'Instagram';
  if(p.includes('tiktok'))return 'TikTok';
  if(p.includes('linkedin'))return 'LinkedIn';
  if(p==='x'||p.includes('twitter'))return 'X';
  if(p==='web'||p.includes('google news')||p.includes('bing'))return 'Web';
  return String(value||'Web').trim()||'Web';
}
function mentionSourceUrl(m){
  const raw=m?.raw_payload||{};
  return String(m?.source_url||raw.permalink||raw.permalink_url||raw.canonical_url||raw.url||raw.post_url||raw.media_url||'').trim();
}
function isOpenSocialDiscovery(m){
  const raw=m?.raw_payload||{};
  // Bu nişan yalnız API-siz açıq sosial discovery lane-i tərəfindən açıq şəkildə
  // işarələnmiş materiallara aiddir. Köhnə public/known profile qeydləri təkcə
  // kind dəyərinə görə açıq sosial material hesab edilmir.
  return raw?.open_social_discovery===true || raw?.discovered_without_platform_api===true || raw?.discovery_channel==='open_social_web';
}
function applyUserVisibleQuality(q){
  // 1–30 zəif nəticələr bazada/admin yoxlamasında saxlanılır, amma adi istifadəçi
  // monitorinqinə çıxmır. Legacy qeydlərdə priority boş/0 ola bildiyi üçün
  // relevance >=31 olan düzgün köhnə materialları da qoruyuruq.
  return q.gte('relevance_score',31);
}
function openSocialChip(m){
  return isOpenSocialDiscovery(m)?'<span class="open-social-chip" title="Platform API-sindən asılı olmayan açıq internet kəşfiyyatı">🌐 Açıq sosial şəbəkə</span>':'';
}
function applyPlatformFilter(q,value){
  const p=canonicalPlatform(value);
  if(!value)return q;
  if(p==='Web')return q.or('source_platform.ilike.Web,source_platform.ilike.Google News,source_platform.ilike.Bing News');
  if(p==='X')return q.or('source_platform.ilike.X,source_platform.ilike.Twitter');
  return q.ilike('source_platform',p);
}

function platformIcon(id=''){
  const common='viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"';
  const icons={
    all:`<svg ${common}><circle cx=\"12\" cy=\"12\" r=\"8.25\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"12\" cy=\"12\" r=\"2.7\" fill=\"currentColor\"/><path d=\"M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></svg>`,
    YouTube:`<svg ${common}><path d=\"M21.2 7.05a2.9 2.9 0 0 0-2.04-2.05C17.35 4.5 12 4.5 12 4.5s-5.35 0-7.16.5A2.9 2.9 0 0 0 2.8 7.05C2.3 8.86 2.3 12 2.3 12s0 3.14.5 4.95A2.9 2.9 0 0 0 4.84 19C6.65 19.5 12 19.5 12 19.5s5.35 0 7.16-.5a2.9 2.9 0 0 0 2.04-2.05c.5-1.81.5-4.95.5-4.95s0-3.14-.5-4.95Z\" fill=\"currentColor\"/><path d=\"m10 15.35 5.1-3.35L10 8.65v6.7Z\" fill=\"#fff\"/></svg>`,
    Facebook:`<svg ${common}><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"currentColor\"/><path d=\"M13.55 20v-7h2.35l.36-2.74h-2.71V8.51c0-.79.22-1.33 1.36-1.33h1.45V4.73c-.25-.03-1.11-.1-2.12-.1-2.1 0-3.54 1.28-3.54 3.64v1.99H8.82V13h2.38v7h2.35Z\" fill=\"#fff\"/></svg>`,
    Instagram:`<svg ${common}><rect x=\"3.1\" y=\"3.1\" width=\"17.8\" height=\"17.8\" rx=\"5.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"4.15\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"17.45\" cy=\"6.65\" r=\"1.2\" fill=\"currentColor\"/></svg>`,
    TikTok:`<svg ${common}><path d=\"M14.6 3.1h3.05c.27 1.72 1.23 3.02 3.05 3.55v3.07a7.3 7.3 0 0 1-3.04-.9v6.05a5.54 5.54 0 1 1-5.55-5.54c.36 0 .72.03 1.06.1v3.13a2.55 2.55 0 1 0 1.43 2.3V3.1Z\" fill=\"currentColor\"/></svg>`,
    LinkedIn:`<svg ${common}><rect x=\"2.7\" y=\"2.7\" width=\"18.6\" height=\"18.6\" rx=\"2.5\" fill=\"currentColor\"/><circle cx=\"7.2\" cy=\"8.1\" r=\"1.45\" fill=\"#fff\"/><path d=\"M5.95 10.2h2.5v7.35h-2.5V10.2Zm4.05 0h2.4v1c.75-.98 1.65-1.32 2.78-1.32 2.5 0 3.12 1.62 3.12 4.2v3.47h-2.5v-3.08c0-1.36-.05-2.47-1.5-2.47-1.52 0-1.8 1.18-1.8 2.64v2.91H10V10.2Z\" fill=\"#fff\"/></svg>`,
    X:`<svg ${common}><path d=\"M4.4 3.5h4.15l4.17 5.58 4.9-5.58h1.98l-5.97 6.81 6.15 8.19h-4.15l-4.55-6.08-5.34 6.08H3.76l6.4-7.31L4.4 3.5Zm3.08 1.45H6.94l9.43 12.11h.55L7.48 4.95Z\" fill=\"currentColor\"/></svg>`,
    Web:`<svg ${common}><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M3.4 12h17.2M12 3c2.25 2.45 3.42 5.43 3.42 9S14.25 18.55 12 21c-2.25-2.45-3.42-5.43-3.42-9S9.75 5.45 12 3Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.55\"/></svg>`
  };
  return icons[id||'all']||icons.Web;
}
const PLATFORM_TABS=[
  {id:'',label:'Hamısı',className:'all'},
  {id:'YouTube',label:'YouTube',className:'youtube'},
  {id:'Facebook',label:'Facebook',className:'facebook'},
  {id:'Instagram',label:'Instagram',className:'instagram'},
  {id:'TikTok',label:'TikTok',className:'tiktok'},
  {id:'LinkedIn',label:'LinkedIn',className:'linkedin'},
  {id:'X',label:'X',className:'x'},
  {id:'Web',label:'Web',className:'web'}
];
const PLATFORM_TYPES={
  YouTube:[['','Hamısı'],['video','Videolar'],['short','Shorts'],['comment','Şərhlər'],['reply','Cavablar']],
  Facebook:[['','Hamısı'],['post','Postlar'],['photo','Foto'],['video','Video / Reels'],['comment','Şərhlər']],
  Instagram:[['','Hamısı'],['post','Postlar'],['reel','Reels'],['photo','Foto / Karusel'],['comment','Şərhlər']],
  TikTok:[['','Hamısı'],['video','Videolar'],['comment','Şərhlər']],
  LinkedIn:[['','Hamısı'],['post','Postlar'],['media','Media'],['comment','Şərhlər']],
  X:[['','Hamısı'],['post','Postlar'],['reply','Cavablar'],['media','Media']],
  Web:[['','Hamısı'],['news','Xəbərlər'],['official','Rəsmi saytlar'],['archive','Arxiv']]
};
let contentType='';
function renderPlatformSwitcher(){
  if(!platformSwitcher)return;
  const selected=platform.value ? canonicalPlatform(platform.value) : '';
  const main=PLATFORM_TABS.map(x=>`<button type="button" class="platform-pill ${x.className}${selected===x.id?' active':''}" data-platform-tab="${escapeHtml(x.id)}" aria-pressed="${selected===x.id?'true':'false'}"><span class="platform-brand-icon">${platformIcon(x.id)}</span><span class="platform-pill-label">${escapeHtml(x.label)}</span></button>`).join('');
  const types=(PLATFORM_TYPES[selected]||[]).map(x=>`<button type="button" class="content-pill${contentType===x[0]?' active':''}" data-content-type="${escapeHtml(x[0])}">${escapeHtml(x[1])}</button>`).join('');
  platformSwitcher.innerHTML=`<div class="platform-pill-row">${main}</div>${types?`<div class="content-pill-row">${types}</div>`:''}`;
  platformSwitcher.querySelectorAll('[data-platform-tab]').forEach(btn=>btn.addEventListener('click',()=>{
    platform.value=btn.dataset.platformTab||''; contentType=''; renderPlatformSwitcher(); load({reset:true});
  }));
  platformSwitcher.querySelectorAll('[data-content-type]').forEach(btn=>btn.addEventListener('click',()=>{
    contentType=btn.dataset.contentType||''; renderPlatformSwitcher(); load({reset:true});
  }));
}
function matchesContentType(m,type=contentType){
  if(!type)return true;
  const raw=m?.raw_payload||{};
  const kind=String(raw.kind||raw.media_product_type||raw.media_type||raw.type||'').toLowerCase();
  const url=String(m?.source_url||'').toLowerCase();
  const text=`${kind} ${url}`;
  if(type==='comment')return /comment|reply/.test(text);
  if(type==='reply')return /reply/.test(text);
  if(type==='short')return /shorts\//.test(url)||/short/.test(kind);
  if(type==='reel')return /\/reel\//.test(url)||/reel/.test(kind);
  if(type==='photo')return /photo|image|carousel|\/p\//.test(text)&&!/video|reel/.test(kind);
  if(type==='video')return /video|reel|short/.test(text)&&!/comment|reply/.test(kind);
  if(type==='media')return /image|photo|video|media|reel/.test(text);
  if(type==='post')return !/comment|reply/.test(kind);
  if(type==='news')return /google_news|bing_news|gdelt|news|rss|feed/.test(kind)||canonicalPlatform(m?.source_platform)==='Web';
  if(type==='official')return /configured_site|official|direct_page/.test(kind);
  if(type==='archive')return raw?.historical_backfill===true||/archive|sitemap/.test(kind);
  return true;
}
function normalizeStoryTitle(v=''){return String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKD').replace(/[əƏ]/g,'e').replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[çÇ]/g,'c').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ğĞ]/g,'g').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function canonicalMentionUrl(value=''){
  const raw=String(value||'').trim(); if(!raw)return '';
  try{const u=new URL(raw);u.hash='';for(const key of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|source|feature|si)$/i.test(key))u.searchParams.delete(key);return `${u.origin}${u.pathname}${u.search}`.replace(/\/$/,'').toLowerCase();}catch{return raw.replace(/\/$/,'').toLowerCase();}
}
function storyKey(m){
  const raw=m?.raw_payload||{};
  const commentId=String(raw.comment_id||raw.commentId||'').trim();
  if(commentId)return `comment|${commentId}`;
  const videoId=String(raw.video_id||raw.videoId||raw.parent_video_id||'').trim() || (()=>{const x=String(m?.source_url||'').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);return x?.[1]||'';})();
  if(videoId)return `youtube|${videoId}`;
  const canonical=canonicalMentionUrl(raw.canonical_url||m?.source_url||'');
  if(canonical)return `url|${canonical}`;
  const title=normalizeStoryTitle(m?.title||''); const day=String(m?.published_at||'').slice(0,10);
  if(title.length>=18)return `title|${title}|${day}`;
  return `id|${m?.id||m?.content_hash||''}`;
}
function mergeUnique(existing,incoming){const seen=new Set(existing.map(storyKey));const out=[...existing];for(const row of incoming){const key=storyKey(row);if(key&&seen.has(key))continue;if(key)seen.add(key);out.push(row);}return out;}
const commentOnly = new URLSearchParams(location.search).get('type') === 'comments';

function isoDay(d,end=false){
  const x=new Date(d); x.setHours(end?23:0,end?59:0,end?59:0,end?999:0); return x.toISOString();
}
function ymd(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function presetDates(v){
  const now=new Date(); let start=new Date(now);
  if(v==='today') start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  else if(v==='month') start=new Date(now.getFullYear(),now.getMonth(),1);
  else if(v==='6m') start.setMonth(start.getMonth()-6);
  else if(v==='1y') start.setFullYear(start.getFullYear()-1);
  else if(v==='10y') start.setFullYear(start.getFullYear()-10);
  else if(v==='all') start=new Date(2000,0,1);
  if(v!=='custom'){dateFrom.value=ymd(start);dateTo.value=ymd(now);}
}
function dateRange(){
  if(!dateFrom.value||!dateTo.value) return null;
  return {from:isoDay(dateFrom.value),to:isoDay(dateTo.value,true)};
}
function updateDateInputs(){
  dateFrom.classList.remove('hidden'); dateTo.classList.remove('hidden');
}

function hasSafeStoredPublishedDate(m){
  if(!m?.published_at)return false;
  const published=new Date(m.published_at);
  if(Number.isNaN(published.getTime()))return false;
  const now=Date.now();
  if(published.getUTCFullYear()<1995 || published.getTime()>now+86400000)return false;

  // Köhnə arxiv qeydlərinin bir hissəsində published_at düzgün saxlanılıb, amma
  // raw_payload-a yeni date_parser_version / published_date_status sahələri sonradan
  // əlavə olunduğu üçün istifadəçi ekranı həmin düzgün tarixi gizlədirdi.
  // detected_at paylaşım tarixi deyil. Legacy fallback yalnız published_at aşkarlanma
  // vaxtından aydın şəkildə əvvəl olanda işləyir; beləliklə köhnə "aşkarlanma vaxtını
  // paylaşım vaxtı kimi yaz" problemini yenidən geri qaytarmırıq.
  const detected=m?.detected_at?new Date(m.detected_at):null;
  if(!detected || Number.isNaN(detected.getTime()))return true;
  const delta=detected.getTime()-published.getTime();
  return delta>=36*60*60*1000;
}
function hasReliablePublishedDate(m){
  if(!m?.published_at)return false;
  const platform=String(m?.source_platform||'').toLowerCase();
  if(platform.includes('youtube'))return true;
  const raw=m?.raw_payload||{};
  // Web/Google News tarixlərində birinci seçim məqalənin öz səhifəsindən və ya
  // mənbənin RSS/feed pubDate sahəsindən təsdiqlənmiş tarixdir.
  if(platform==='web'||platform.includes('google news')){
    const source=String(raw?.published_date_source||'');
    const pageVerified=raw?.published_from_page===true && raw?.published_date_status==='verified' && Number(raw?.date_parser_version||0)>=2 && ['structured:datePublished','meta:article:published_time','visible:article-heading'].includes(source);
    const provider=String(raw?.provider||'').toLowerCase();
    const kind=String(raw?.kind||'').toLowerCase();
    const feedReported=raw?.published_date_status==='source-reported' && source==='feed:published' && Number(raw?.date_parser_version||0)>=3 && (/(google news|bing|rss|gdelt|configured feed)/.test(provider) || ['google_news','bing_news','bing_web','gdelt_article','configured_feed'].includes(kind));
    if(pageVerified||feedReported)return true;
    // Admin paneldə düzgün görünən köhnə materialların published_at dəyərini
    // istifadəçi ekranında da göstər, amma detected_at-a yaxın şübhəli tarixləri yox.
    return hasSafeStoredPublishedDate(m);
  }
  if(['facebook','instagram','tiktok','linkedin','x'].includes(platform)){
    // Sosial paylaşım tarixi platformanın öz səhifəsindən / rəsmi API-dən
    // təsdiqlənəndə göstərilir. Köhnə təhlükəsiz published_at qeydləri də qorunur.
    if(String(raw?.provider||'').toLowerCase().includes('meta graph api')) return true;
    const socialVerified=raw?.published_from_page===true && raw?.published_date_status==='verified' && String(raw?.published_date_source||'').startsWith('social:');
    return socialVerified||hasSafeStoredPublishedDate(m);
  }
  return true;
}
function publishedDate(m){return hasReliablePublishedDate(m)?m.published_at:null;}
function publicationSortValue(m){
  const reliable=publishedDate(m);
  return reliable ? new Date(reliable).getTime()||0 : 0;
}
function detectedSortValue(m){return new Date(m?.detected_at||0).getTime()||0;}
function sortRowsByPublication(list=[]){
  return [...list].sort((a,b)=>{
    const ap=publicationSortValue(a),bp=publicationSortValue(b);
    if(ap!==bp)return bp-ap;
    const ar=hasReliablePublishedDate(a),br=hasReliablePublishedDate(b);
    if(ar!==br)return br-ar;
    return detectedSortValue(b)-detectedSortValue(a);
  });
}
function publishedDateText(m){
  if(hasReliablePublishedDate(m))return fmtDate(m.published_at);
  const raw=m?.raw_payload||{};
  if(raw?.published_date_status==='not-found')return 'Mənbədə tarix göstərilməyib';
  return 'Tarix yoxlanılır';
}
function sourceStateBadge(m){
  const state=String(m.source_status||'active');
  const comment=isComment(m);
  if(state==='removed')return `<span class="badge danger source-removed">${comment?'Şərh silinib':'Video / material silinib'}</span>`;
  if(state==='unavailable')return `<span class="badge warn">${comment?'Şərh əlçatan deyil':'Mənbə əlçatan deyil'}</span>`;
  return `<span class="badge success">${comment?'Şərh aktivdir':'Mənbədə aktivdir'}</span>`;
}
function sourceStateText(m){
  const state=String(m.source_status||'active');
  const comment=isComment(m);
  if(state==='removed')return comment?'Şərh orijinal platformadan silinib. Arxiv qeydi sistemdə saxlanılır.':'Orijinal video / material mənbədən silinib. Arxiv qeydi sistemdə saxlanılır.';
  if(state==='unavailable')return comment?'Şərh hazırda platformada açıq şəkildə əlçatan deyil.':'Orijinal material hazırda açıq şəkildə əlçatan deyil.';
  return comment?'Şərh son yoxlamada platformada mövcud olub.':'Orijinal material son yoxlamada mənbədə əlçatan olub.';
}

function socialDetailHtml(m,raw={}){
  const p=canonicalPlatform(m?.source_platform);
  if(!['Facebook','Instagram','TikTok','LinkedIn','X'].includes(p)) return '';
  const rows=[];
  const add=(label,value)=>{if(value!==null&&value!==undefined&&String(value)!=='')rows.push(`<div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(String(value))}</p></div>`)};
  add('Mənbə tipi',raw.kind||raw.social_platform||p);
  add('Aşkarlanma üsulu',raw.discovery_channel==='open_social_web'?'Açıq internet / platforma indeksi':(raw.discovery_method||raw.provider||raw.discovery_provider));
  add('Provayder',raw.provider||raw.discovery_provider);
  add('Post identifikatoru',raw.source_post_identity);
  add('İstifadəçi / səhifə',raw.username||raw.page_name||raw.author_name||raw.account_name||raw.owner_name);
  add('Media növü',raw.media_product_type||raw.media_type||raw.type);
  add('Bəyənmə / reaksiya',raw.like_count??raw.reaction_count??raw.reactions_count);
  add('Şərh sayı',raw.comments_count??raw.comment_count);
  add('Cavab sayı',raw.replies_count??raw.reply_count);
  add('Paylaşım sayı',raw.share_count??raw.shares_count??raw.shares);
  add('Baxış sayı',raw.views_count??raw.view_count??raw.video_views);
  add('Post / Media ID',raw.post_id||raw.media_id||raw.parent_post_id||raw.parent_media_id||raw.id);
  add('Səhifə / hesab ID',raw.page_id||raw.account_id||raw.instagram_account_id);
  add('Şərh ID',raw.comment_id);
  add('Ana şərh ID',raw.parent_comment_id||raw.parent_id);
  return rows.length?`<h3>Sosial platforma detalları</h3><div class="detail-grid social-detail-grid">${rows.join('')}</div>`:'';
}

function cleanSocialDisplayText(value=''){
  let text=String(value||'').replace(/\s+/g,' ').trim();
  text=text.replace(/^\s*[0-9.,]+(?:[kmb])?\s+likes?\s*,\s*[0-9.,]+(?:[kmb])?\s+comments?\s*[-–—]\s*[^:]{1,120}\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*:\s*/i,'');
  text=text.replace(/^\s*[0-9.,]+(?:[kmb])?\s+likes?\s*,\s*[0-9.,]+(?:[kmb])?\s+comments?\s*[-–—]\s*[^:]{1,120}\s*:\s*/i,'');
  return text.replace(/^[“"]|[”"]$/g,'').trim();
}
function socialAuthor(m,raw={}){
  const p=canonicalPlatform(m?.source_platform);
  let value=String(m?.author_name||raw.author_name||raw.channel_title||raw.author||raw.creator||raw.publisher||raw.username||raw.page_name||raw.account_name||raw.owner_name||'').trim();
  value=value.replace(/\s+(?:on\s+)?(?:Facebook|Instagram|TikTok|LinkedIn|X)\s*$/i,'').trim();
  if(p) value=value.replace(new RegExp(`\\s*(?:[-–—|]\\s*)?${String(p).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`,'i'),'').trim();
  return value;
}
function compactDisplayTitle(m){
  const raw=m?.raw_payload||{}; const p=canonicalPlatform(m?.source_platform);
  const trimHeadline=(value='')=>{
    const clean=cleanSocialDisplayText(String(value||'')).replace(/\s+/g,' ').trim();
    if(!clean)return '';
    const sentence=(clean.match(/^.{24,220}?(?=[.!?](?:\s|$))/)?.[0]||clean).trim();
    return sentence.length>150?`${sentence.slice(0,147).replace(/[,:;\s]+$/,'')}…`:sentence;
  };
  if(['Facebook','Instagram','TikTok','LinkedIn','X'].includes(p)){
    const stored=String(m?.title||'').trim();
    const generic=/(?:facebook|instagram|tiktok|linkedin|x)?\s*(?:paylaşımı|açıq paylaşımı|paylaşım linki)$/i.test(stored) || /—\s*(?:facebook|instagram|tiktok|linkedin|x)\s*(?:paylaşımı)?$/i.test(stored);
    if(stored && !generic) return trimHeadline(stored);
    const original=trimHeadline(m?.original_text||raw?.text_original||raw?.text||raw?.message||raw?.caption||raw?.description||'');
    if(original)return original;
    const author=socialAuthor(m,raw);
    if(author)return `${author} — ${p}`;
    return `${p} paylaşımı`;
  }
  return String(m?.title||'Monitorinq qeydi');
}
function socialMetricBar(raw={},options={}){
  const metrics=[];
  const add=(icon,label,value,cls='')=>{if(value!==null&&value!==undefined&&String(value)!=='')metrics.push(`<span class="social-metric ${cls}" title="${escapeHtml(label)}"><span class="social-metric-icon">${icon}</span><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></span>`)};
  if(options.comment){
    add('♥','Şərh bəyənməsi',raw.like_count??raw.reaction_count??raw.reactions_count??0,'comment-like');
  }else{
    add('♥','Bəyənmə',raw.like_count??raw.reaction_count??raw.reactions_count);
    add('💬','Şərh',raw.comments_count??raw.comment_count);
    add('↗','Paylaşım',raw.share_count??raw.shares_count??raw.shares);
    add('▶','Baxış',raw.views_count??raw.view_count??raw.video_views);
  }
  return metrics.length?`<div class="social-metrics${options.comment?' comment-social-metrics':''}">${metrics.join('')}</div>`:'';
}

function commentDisplayParts(m,raw={}){
  const original=cleanSocialDisplayText(String(m?.original_text||raw?.text_original||raw?.comment_text||raw?.text||'')).trim();
  let video=String(raw?.video_title||raw?.parent_title||raw?.parent_text||raw?.parent_caption||raw?.parent_message||'').trim();
  let comment=original;
  const videoMatch=original.match(/(?:^|\s)Video:\s*([\s\S]*?)(?=\s+(?:Şərh|Cavab):|$)/i);
  const commentMatch=original.match(/(?:^|\s)(?:Şərh|Cavab):\s*([\s\S]*)$/i);
  if(!video && videoMatch) video=videoMatch[1].trim();
  if(commentMatch) comment=commentMatch[1].trim();
  else if(videoMatch) comment=original.replace(videoMatch[0],'').replace(/^\s*(?:Şərh|Cavab):\s*/i,'').trim();
  return {video,comment};
}
function commentDisplayHtml(m,raw={}){
  const parts=commentDisplayParts(m,raw);
  if(!parts.video && !parts.comment) return '';
  return `<div class="comment-readable">${parts.video?`<div class="comment-readable-row"><strong>Video:</strong><span>${escapeHtml(parts.video)}</span></div>`:''}${parts.comment?`<div class="comment-readable-row comment-line"><strong>Şərh:</strong><span>${escapeHtml(parts.comment)}</span></div>`:''}</div>`;
}
function isComment(m){const k=String(m?.raw_payload?.kind||'').toLowerCase();return k.includes('comment')||k.includes('reply');}
function orderedMedia(m){
  const media=Array.isArray(m?.mention_media)?[...m.mention_media]:[];
  const rank={screenshot:0,preview:1,preview_external:2};
  return media.sort((a,b)=>(rank[String(a?.media_type||'').toLowerCase()]??9)-(rank[String(b?.media_type||'').toLowerCase()]??9));
}
function primaryMediaUrl(m){return mentionPreviewUrl(m);}
function mediaImg(url,cls='detail-media'){return `<img src=\"${url}\" data-media=\"${url}\" class=\"${cls}\" alt=\"Media\" loading=\"lazy\" onerror=\"this.closest('figure')?.classList.add('media-load-error')\">`;}
function card(m){
  const comment=isComment(m);
  const sourceUrl=mentionSourceUrl(m);
  const platformLabel=canonicalPlatform(m.source_platform);
  const commentMetric=comment?socialMetricBar(m.raw_payload||{},{comment:true}):'';
  const bodyMetrics=comment?'':socialMetricBar(m.raw_payload||{},{});
  return `<article class="mention-card${comment?' is-comment':''}">${openSocialChip(m)}<div class="mention-media-col"><span class="thumb-platform-chip ${platformLabel.toLowerCase().replace(/[^a-z0-9]+/g,'-')}"><span class="thumb-platform-icon">${platformIcon(platformLabel)}</span><span>${escapeHtml(platformLabel)}</span></span><div class="mention-thumb-wrap"><img class="thumb" src="${escapeHtml(primaryMediaUrl(m))}" alt="" loading="lazy" onerror="this.onerror=null;this.src='./assets/img/icon.svg';this.classList.add('thumb-fallback')"></div>${commentMetric}</div><div class="mention-copy"><h3>${escapeHtml(compactDisplayTitle(m))}</h3><p>${escapeHtml(cleanSocialDisplayText(m.original_text||m.summary||''))}</p>${bodyMetrics}<div class="mention-meta">${isCentralScope(ctx.profile)&&(m.service_point?.short_name||m.organizations?.short_name)?`<span class="badge ok">${escapeHtml(m.service_point?.short_name||m.organizations?.short_name)}</span>`:''}${comment?'<span class="badge comment-badge">✉ Şərh</span>':''}${sourceStateBadge(m)}<span class="badge ${m.relevance_score>=81?'danger':m.relevance_score>=61?'warn':'info'}">${m.relevance_score||0}%</span><span class="muted">Paylaşım: ${publishedDateText(m)}</span></div></div><div class="toolbar"><button class="btn secondary" data-open="${m.id}">Ətraflı</button>${sourceUrl?`<a class="btn" target="_blank" rel="noopener" href="${escapeHtml(sourceUrl)}">${comment?'Şərhə get':'Orijinalı aç'}</a>`:''}</div></article>`;
}
function render(append=false){
  if(!append) list.innerHTML='';
  if(!rows.length){list.innerHTML='<div class="card empty">Nəticə tapılmadı.</div>';return;}
  list.innerHTML=rows.map(card).join('');
  document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDetail(b.dataset.open));
}
async function load({reset=false}={}){
  if(loading||(done&&!reset)) return;
  if(reset){page=0;done=false;rows=[];requestToken++;render();}
  const token=requestToken; const range=dateRange(); if(!range) return;
  loading=true; sentinel.classList.add('loading');
  try{
    // Egress qoruması: hər frontend sorğusunda Supabase-dən maksimum 50 qeyd gəlir.
    // Əvvəl filtrdən sonra 50 görünən nəticə toplamaq üçün bir çağırışda 6 səhifəyədək
    // (300 sətir) yüklənə bilirdi. İndi növbəti 50 yalnız istifadəçi aşağı sürüşəndə gəlir.
    const from=page*PAGE_SIZE, to=from+PAGE_SIZE-1;
    let q=applyUserVisibleQuality(supabase.from('mentions').select('id,title,summary,original_text,source_platform,source_url,author_name,priority_score,relevance_score,sentiment,published_at,detected_at,source_status,raw_payload,organization_id,district_id,village_id,organizations(short_name),service_point:organization_service_points!mentions_service_point_id_fkey(short_name,name),districts(name),villages(name),mention_media(url,media_type,captured_at)'));
    // Tarix filtri yalnız real paylaşım tarixinə tətbiq edilir. detected_at sistemin
    // aşkarlama vaxtıdır və köhnə xəbəri "Bu ay" kimi göstərməməlidir.
    if(period.value!=='all') q=q.gte('published_at',range.from).lte('published_at',range.to);
    q=q.order('published_at',{ascending:false,nullsFirst:false})
      .order('detected_at',{ascending:false}).range(from,to);
    q=applyOrganizationScope(q,ctx.profile,organizationFilter?.value||'');
    if(platform.value) q=applyPlatformFilter(q,platform.value);
    if(sentiment.value) q=q.eq('sentiment',sentiment.value);
    if(commentOnly) q=q.ilike('raw_payload->>kind','%comment%');
    const {data,error}=await q; if(error) throw error; if(token!==requestToken)return;
    const rawBatch=data||[];
    // Müəyyən tarix aralığında yalnız təsdiqlənmiş paylaşım tarixi olan materiallar
    // görünür. "Bütün tarix" rejimində tarixsiz köhnə arxiv qeydləri də saxlanılır.
    const dateSafeBatch=period.value==='all' ? rawBatch : rawBatch.filter(hasReliablePublishedDate);
    const batch=filterExcludedMentions(dateSafeBatch,globalExcludes).filter(row=>matchesContentType(row));
    rows=sortRowsByPublication(mergeUnique(rows,batch));
    done=rawBatch.length<PAGE_SIZE;
    page++;
    render(true);
  }catch(e){ if(!rows.length) list.innerHTML=`<div class="empty">${escapeHtml(e.message||String(e))}</div>`; else toast(e,'error'); }
  finally{loading=false;sentinel.classList.remove('loading');}
}

function speechText(m){
  const raw=m?.raw_payload||{};
  if(isComment(m)){
    const commentText=cleanSocialDisplayText(String(m?.original_text||raw?.text_original||raw?.comment_text||''));
    const videoTitle=String(raw?.video_title||'').trim();
    return [videoTitle?`Video: ${videoTitle}`:'',commentText].filter(Boolean).join('. ');
  }
  const p=canonicalPlatform(m?.source_platform);
  const original=cleanSocialDisplayText(m?.original_text||raw?.text_original||raw?.text||raw?.message||raw?.caption||raw?.description||'');
  if(['Facebook','Instagram','TikTok','LinkedIn','X'].includes(p)){
    const author=socialAuthor(m,raw);
    return [author?`${author}`:'',original].filter(Boolean).join('. ');
  }
  return [m?.title,original].filter(Boolean).join('. ');
}
function bestSpeechVoice(){
  const voices=window.speechSynthesis?.getVoices?.()||[];
  return voices.find(v=>/^az([-_]|$)/i.test(v.lang))
    || voices.find(v=>/^tr([-_]|$)/i.test(v.lang))
    || voices.find(v=>/^en([-_]|$)/i.test(v.lang))
    || voices[0]
    || null;
}
function speak(m,button){
  if(!('speechSynthesis' in window)) return toast('Bu cihazda səslə oxuma dəstəklənmir.','error');
  if(window.speechSynthesis.speaking){window.speechSynthesis.cancel();button.textContent='🔊 Dinlə';return;}
  const u=new SpeechSynthesisUtterance(speechText(m));
  const voice=bestSpeechVoice();
  if(voice) u.voice=voice;
  u.lang=voice?.lang || 'az-AZ';
  u.rate=.9; u.pitch=1;
  if(!voice || !/^az([-_]|$)/i.test(voice.lang||'')) toast('Cihazda Azərbaycan dili səsi yoxdur; ən yaxın mövcud səs istifadə olunur.','info');
  u.onend=u.onerror=()=>button.textContent='🔊 Dinlə'; button.textContent='■ Dayandır'; window.speechSynthesis.speak(u);
}
async function fetchMentionById(id){
  const {data,error}=await supabase.from('mentions')
    .select('*, districts(name), villages(name), mention_media(*)')
    .eq('id',id).gte('relevance_score',31).maybeSingle();
  if(error) throw error;
  return data || null;
}
async function openDetail(id){
  let m=rows.find(x=>x.id===id);
  if(!m){
    try{ m=await fetchMentionById(id); }
    catch(e){ toast(e,'error'); return; }
  }
  if(!m){ toast('Seçilən monitorinq qeydi tapılmadı.','error'); return; }
  window.speechSynthesis?.cancel?.();
  const raw=m.raw_payload||{}; const comment=isComment(m); const platformLabel=canonicalPlatform(m.source_platform); const sourceUrl=mentionSourceUrl(m);
  const storedMedia=orderedMedia(m).filter(x=>x?.url);
  const rawImageValues=[...(Array.isArray(raw.image_urls)?raw.image_urls:[]),raw.image_url,raw.thumbnail_url,raw.picture,raw.preview_url].filter(Boolean);
  const rawVideoValues=[...(Array.isArray(raw.video_urls)?raw.video_urls:[]),raw.video_url,raw.playable_url,raw.playable_url_quality_hd].filter(Boolean);
  const rawImages=rawImageValues.map(url=>({url,media_type:'preview_external'}));
  const rawVideos=rawVideoValues.map(url=>({url,media_type:'video_external'}));
  const ytId=String(raw.video_id||'');
  const fallbackYoutube=String(m.source_platform||'').toLowerCase()==='youtube'&&ytId?[{url:`https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`,media_type:'preview_external'}]:[];
  const mediaRows=[...storedMedia,...rawImages,...rawVideos,...fallbackYoutube].filter((x,i,a)=>x?.url&&a.findIndex(y=>String(y?.url)===String(x.url))===i);
  const screenshotRow=mediaRows.find(x=>String(x?.media_type||'').toLowerCase()==='screenshot');
  const socialFirst=mediaRows.filter(x=>String(x?.media_type||'').toLowerCase()!=='screenshot');
  const socialPlatformMedia=['Facebook','Instagram','TikTok','LinkedIn','X'].includes(platformLabel);
  const screenshots=mediaRows.filter(x=>String(x?.media_type||'').toLowerCase()==='screenshot').slice(0,1);
  const videos=socialFirst.filter(x=>String(x?.media_type||'').toLowerCase().includes('video')).slice(0,1);
  const images=socialFirst.filter(x=>!String(x?.media_type||'').toLowerCase().includes('video')).slice(0,1);
  const displayMedia=platformLabel==='Web'
    ? [...images,...screenshots]
    : socialPlatformMedia ? [...images,...videos,...screenshots] : [...socialFirst.slice(0,3),...screenshots];
  const hasScreenshot=Boolean(screenshotRow);
  const mediaItemHtml=(x,i)=>{
    const type=String(x?.media_type||'').toLowerCase();
    const isVideo=type.includes('video')||/\.(?:mp4|m4v|webm)(?:$|\?)/i.test(String(x.url||''));
    const body=isVideo
      ? `<video class="detail-media detail-media-video" controls preload="metadata" playsinline src="${escapeHtml(x.url)}"></video>`
      : mediaImg(x.url);
    const label=type==='screenshot'?'Arxiv ekran görüntüsü':(isVideo?'Paylaşım videosu':'Paylaşım şəkli');
    return `<figure class="detail-media-wrap${i===0?' is-active':''}" data-media-slide="${i}">${body}<figcaption>${escapeHtml(label)}</figcaption></figure>`;
  };
  const media=displayMedia.length?`<div class="detail-media-carousel"><div class="detail-media-track">${displayMedia.map(mediaItemHtml).join('')}</div>${displayMedia.length>1?`<button class="detail-media-nav prev" type="button" aria-label="Əvvəlki media">‹</button><button class="detail-media-nav next" type="button" aria-label="Növbəti media">›</button><div class="detail-media-count"><span>1</span> / ${displayMedia.length}</div>`:''}</div>`:'';
  const screenshotState=platformLabel==='Web'&&!hasScreenshot?`<div class="card detail-state"><p class="muted">Arxiv ekran görüntüsü hələ hazırlanır. Yeni qəbul olunan Web materialları tam mətn və media ilə birlikdə tamamlanır; köhnə arxiv növbə ilə yenilənir.</p></div>`:'';
  const originalText=cleanSocialDisplayText(m.original_text||raw.text_original||raw.comment_text||raw.text||raw.message||raw.caption||raw.description||'');
  const displayTitle=compactDisplayTitle(m);
  const metricsHtml=socialMetricBar(raw,{comment});
  const socialPlatform=['Facebook','Instagram','TikTok','LinkedIn','X'].includes(platformLabel);
  document.querySelector('#modal-root').innerHTML=`<div class="modal-backdrop" id="detail-bg"><div class="modal detail-modal"><div class="modal-head detail-modal-head"><div><span class="badge ${m.relevance_score>=81?'danger':m.relevance_score>=61?'warn':'info'}">${m.relevance_score||0}% uyğunluq</span>${openSocialChip(m)}<h2 title="${escapeHtml(m.title||displayTitle)}">${escapeHtml(displayTitle)}</h2>${metricsHtml}</div><button class="icon-btn" id="detail-close" aria-label="Bağla">✕</button></div><div class="detail-grid"><div><strong>Platforma</strong><p>${escapeHtml(platformLabel)}</p></div><div><strong>Paylaşılma tarixi</strong><p>${publishedDateText(m)}</p></div><div><strong>Müəllif</strong><p>${escapeHtml(socialAuthor(m,raw)||'—')}</p></div><div><strong>Növ</strong><p>${comment?'Şərh / cavab':'Paylaşım / material'}</p></div></div><div class="card detail-state"><div class="mention-meta">${sourceStateBadge(m)}</div><p>${escapeHtml(sourceStateText(m))}</p></div><div class="detail-actions"><button class="btn secondary" id="detail-speak">🔊 Dinlə</button>${sourceUrl?`<a class="btn" target="_blank" rel="noopener" href="${escapeHtml(sourceUrl)}">${comment?'💬 Şərhə get':'🔗 Orijinal paylaşımı aç'}</a>`:''}</div>${comment?commentDisplayHtml(m,raw):`<details class="detail-original" ${socialPlatform?'': 'open'}><summary>Orijinal mətn ${originalText.length>700?'— aç / bağla':''}</summary><div class="muted detail-text">${escapeHtml(originalText||(platformLabel==='Web'?'Tam mətn mənbədən avtomatik tamamlanma növbəsindədir.':'Mətn mənbə tərəfindən təqdim edilməyib.'))}</div></details>`}${raw.comment_id?`<div class="comment-context comment-context-technical-only"><div class="comment-technical"><span>Şərh ID: ${escapeHtml(raw.comment_id)}</span><span>${raw.parent_id||raw.parent_comment_id?'Cavab':'Əsas şərh'}</span></div></div>`:''}${socialDetailHtml(m,raw)}${screenshotState}${media?`<h3>Media sübutları</h3><p class="muted detail-media-help">Əsas paylaşım mediası və varsa arxiv ekran görüntüsü göstərilir; profil loqosu və əlaqəsiz səhifə şəkilləri süzgəcdən keçirilir.</p><div class="detail-media-gallery">${media}</div>`:''}</div></div>`;
  document.body.classList.add('detail-modal-open');
  document.documentElement.classList.add('detail-modal-open');
  mountViewerTopbar();

  document.querySelector('#detail-close').onclick=()=>{
    window.speechSynthesis?.cancel?.();
    document.querySelector('#modal-root').innerHTML='';
    document.body.classList.remove('detail-modal-open');
    document.documentElement.classList.remove('detail-modal-open');
    if(viewer.classList.contains('hidden')){
      unmountViewerTopbar();
      document.body.style.overflow='';
    }
  };
  document.querySelector('#detail-bg').onclick=e=>{if(e.target.id==='detail-bg')document.querySelector('#detail-close').click();};
  document.querySelector('#detail-speak').onclick=e=>speak(m,e.currentTarget);
  document.querySelectorAll('[data-media]').forEach(x=>x.onclick=()=>openViewer(x.dataset.media));
  const slides=[...document.querySelectorAll('#detail-bg [data-media-slide]')];
  if(slides.length>1){
    let mediaIndex=0;
    const counter=document.querySelector('#detail-bg .detail-media-count span');
    const showMedia=(next)=>{
      mediaIndex=(next+slides.length)%slides.length;
      slides.forEach((el,i)=>{el.classList.toggle('is-active',i===mediaIndex); if(i!==mediaIndex) el.querySelector('video')?.pause?.();});
      if(counter)counter.textContent=String(mediaIndex+1);
    };
    document.querySelector('#detail-bg .detail-media-nav.prev')?.addEventListener('click',()=>showMedia(mediaIndex-1));
    document.querySelector('#detail-bg .detail-media-nav.next')?.addEventListener('click',()=>showMedia(mediaIndex+1));
    showMedia(0);
  }
}

let scale=1,currentUrl='',tx=0,ty=0,startX=0,startY=0,baseX=0,baseY=0,isDragging=false,pinchStart=0,pinchScale=1,pinchMidX=0,pinchMidY=0,pinchBaseX=0,pinchBaseY=0;
const viewer=document.querySelector('#viewer'),img=document.querySelector('#viewer-img'),stage=document.querySelector('#viewer-stage');

function mountViewerTopbar(){
  // Ətraflı pəncərə açıq qaldığı müddətdə eyni sabit başlıq saxlanılır.
  // Şəkillər arasında keçiddə klonu silib-yaratmamaq başlığın itməsinin qarşısını alır.
  if(document.querySelector('#viewer-topbar-clone')) return;
  const source=document.querySelector('#topbar');
  if(!source) return;
  const clone=source.cloneNode(true);
  clone.id='viewer-topbar-clone';
  clone.classList.add('viewer-topbar-clone');
  clone.setAttribute('aria-hidden','true');
  clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
  clone.querySelectorAll('a,button,input,select,textarea').forEach(el=>{
    el.setAttribute('tabindex','-1');
    el.style.pointerEvents='none';
  });
  document.body.appendChild(clone);
}
function unmountViewerTopbar(){
  document.querySelector('#viewer-topbar-clone')?.remove();
}
function clampPan(){
  const iw=Math.max(1,img.clientWidth||0), ih=Math.max(1,img.clientHeight||0);
  const sw=Math.max(1,stage.clientWidth||0), sh=Math.max(1,stage.clientHeight||0);
  const maxX=Math.max(0,(iw*scale-sw)/2), maxY=Math.max(0,(ih*scale-sh)/2);
  tx=Math.max(-maxX,Math.min(maxX,tx)); ty=Math.max(-maxY,Math.min(maxY,ty));
  if(scale<=1){tx=0;ty=0;}
}
function applyTransform(){clampPan();img.style.transform=`translate3d(${tx}px,${ty}px,0) scale(${scale})`;stage.classList.toggle('is-zoomed',scale>1.001);}
function resetViewer(){scale=1;tx=0;ty=0;isDragging=false;pinchStart=0;applyTransform();}
function zoomAt(nextScale,clientX,clientY){
  const prev=scale; nextScale=Math.max(1,Math.min(6,nextScale));
  if(Math.abs(nextScale-prev)<.001)return;
  const r=stage.getBoundingClientRect(); const x=clientX-(r.left+r.width/2), y=clientY-(r.top+r.height/2);
  tx=x-(x-tx)*(nextScale/prev); ty=y-(y-ty)*(nextScale/prev); scale=nextScale; applyTransform();
}
function openViewer(url){
  currentUrl=url;
  resetViewer();
  img.src=url;
  viewer.classList.remove('hidden');
  viewer.setAttribute('aria-hidden','false');
  document.body.classList.add('media-viewer-open');
  document.documentElement.classList.add('media-viewer-open');
  mountViewerTopbar();
  document.body.style.overflow='hidden';
  requestAnimationFrame(applyTransform);
}
function closeViewer(){
  viewer.classList.add('hidden');
  viewer.setAttribute('aria-hidden','true');
  document.body.classList.remove('media-viewer-open');
  document.documentElement.classList.remove('media-viewer-open');
  // Ətraflı modal açıqdırsa sabit başlıq klonu qalır; yalnız bütün detal bağlananda silinir.
  if(!document.querySelector('#detail-bg')) unmountViewerTopbar();
  document.body.style.overflow=document.querySelector('#detail-bg')?'hidden':'';
  img.removeAttribute('src');
  resetViewer();
}
document.querySelector('#viewer-close').onclick=closeViewer;
document.querySelector('#zoom-in').onclick=()=>zoomAt(scale+.35,innerWidth/2,innerHeight/2);
document.querySelector('#zoom-out').onclick=()=>zoomAt(scale-.35,innerWidth/2,innerHeight/2);
document.querySelector('#share-media').onclick=async()=>{if(navigator.share){try{await navigator.share({title:'Media Monitorinq — Media',url:currentUrl})}catch{}}else if(navigator.clipboard){await navigator.clipboard.writeText(currentUrl);toast('Media linki kopyalandı','success')}};
document.querySelector('#save-media').onclick=async()=>{
  if(!currentUrl)return;
  const ext=(currentUrl.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1]||'jpg').replace('jpeg','jpg');
  const name=`media-monitorinq-${new Date().toISOString().replace(/[:.]/g,'-')}.${ext}`;
  try{
    const response=await fetch(currentUrl,{mode:'cors',credentials:'omit'}); if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const blob=await response.blob(), href=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=href;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1500);
  }catch{
    const a=document.createElement('a');a.href=currentUrl;a.download=name;a.target='_blank';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
    toast('Brauzer birbaşa endirməyə icazə verməsə, şəkil yeni pəncərədə açılacaq.','info');
  }
};
img.addEventListener('load',()=>{resetViewer();applyTransform();});
stage.addEventListener('wheel',e=>{e.preventDefault();const factor=e.deltaY<0?1.16:1/1.16;zoomAt(scale*factor,e.clientX,e.clientY);},{passive:false});
stage.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||scale<=1)return;isDragging=true;startX=e.clientX;startY=e.clientY;baseX=tx;baseY=ty;stage.setPointerCapture?.(e.pointerId);stage.classList.add('is-dragging');});
stage.addEventListener('pointermove',e=>{if(!isDragging)return;tx=baseX+(e.clientX-startX);ty=baseY+(e.clientY-startY);applyTransform();});
stage.addEventListener('pointerup',e=>{isDragging=false;stage.classList.remove('is-dragging');stage.releasePointerCapture?.(e.pointerId);});
stage.addEventListener('pointercancel',()=>{isDragging=false;stage.classList.remove('is-dragging');});
stage.addEventListener('dblclick',e=>{if(scale>1.01)resetViewer();else zoomAt(2.25,e.clientX,e.clientY);});
stage.addEventListener('touchstart',e=>{
  if(e.touches.length===2){
    e.preventDefault();const a=e.touches[0],b=e.touches[1];pinchStart=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);pinchScale=scale;
    pinchMidX=(a.clientX+b.clientX)/2;pinchMidY=(a.clientY+b.clientY)/2;pinchBaseX=tx;pinchBaseY=ty;isDragging=false;
  }else if(e.touches.length===1&&scale>1){const t=e.touches[0];startX=t.clientX;startY=t.clientY;baseX=tx;baseY=ty;isDragging=true;}
},{passive:false});
stage.addEventListener('touchmove',e=>{
  if(e.touches.length===2&&pinchStart){
    e.preventDefault();const a=e.touches[0],b=e.touches[1],d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),midX=(a.clientX+b.clientX)/2,midY=(a.clientY+b.clientY)/2;
    scale=Math.max(1,Math.min(6,pinchScale*(d/pinchStart)));tx=pinchBaseX+(midX-pinchMidX);ty=pinchBaseY+(midY-pinchMidY);applyTransform();
  }else if(e.touches.length===1&&isDragging&&scale>1){e.preventDefault();const t=e.touches[0];tx=baseX+(t.clientX-startX);ty=baseY+(t.clientY-startY);applyTransform();}
},{passive:false});
stage.addEventListener('touchend',e=>{if(e.touches.length<2)pinchStart=0;if(e.touches.length===0)isDragging=false;});
window.addEventListener('resize',applyTransform);
const reset=()=>load({reset:true}); if(organizationFilter) organizationFilter.onchange=reset; platform.onchange=()=>{contentType='';renderPlatformSwitcher();reset();}; sentiment.onchange=reset; period.onchange=()=>{presetDates(period.value);updateDateInputs();reset();}; dateFrom.onchange=()=>{period.value='custom';reset();};dateTo.onchange=()=>{period.value='custom';reset();};
new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting)load();},{rootMargin:'500px'}).observe(sentinel);
if(commentOnly){
  const h1=document.querySelector('.monitor-head h1');
  const p=document.querySelector('.monitor-head p');
  if(h1) h1.textContent='Aşkarlanan rəylər';
  if(p) p.textContent='Monitorinqə düşən bütün uyğun platforma rəyləri və cavabları.';
  platform.value='';
  period.value='all';
  dateFrom.value='2000-01-01';
  dateTo.value=ymd(new Date());
}else{
  if(!period.value || period.value==='custom') period.value='month';
  presetDates(period.value);
}
updateDateInputs(); renderPlatformSwitcher(); await load({reset:true});
const openId=new URLSearchParams(location.search).get('id'); if(openId)await openDetail(openId);

if(!isCentralScope(ctx.profile)) startLiveMonitor({organizationId:ctx.profile.organization_id,fullFirst:commentOnly,onNew:()=>load({reset:true})});
