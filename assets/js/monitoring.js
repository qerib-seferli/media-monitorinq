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
const PAGE_SIZE=50;
let rows=[], page=0, loading=false, done=false, requestToken=0;
const globalExcludes=await loadGlobalExcludes();
function normalizeStoryTitle(v=''){return String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKD').replace(/[əƏ]/g,'e').replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[çÇ]/g,'c').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ğĞ]/g,'g').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function storyKey(m){
  const platformName=String(m?.source_platform||'').toLowerCase();
  if(platformName==='web'||platformName==='google news'){
    const title=normalizeStoryTitle(m?.title||''); const day=String(m?.published_at||m?.detected_at||'').slice(0,10);
    if(title.length>=18)return `web|${title}|${day}`;
  }
  return `id|${m?.id||m?.content_hash||m?.source_url||Math.random()}`;
}
function mergeUnique(existing,incoming){const seen=new Set(existing.map(storyKey));const out=[...existing];for(const row of incoming){const key=storyKey(row);if(seen.has(key))continue;seen.add(key);out.push(row);}return out;}
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

function publishedDate(m){return m.published_at||m.detected_at||null;}
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
function isComment(m){return String(m.raw_payload?.kind||'').includes('comment');}
function orderedMedia(m){
  const media=Array.isArray(m?.mention_media)?[...m.mention_media]:[];
  const rank={screenshot:0,preview:1,preview_external:2};
  return media.sort((a,b)=>(rank[String(a?.media_type||'').toLowerCase()]??9)-(rank[String(b?.media_type||'').toLowerCase()]??9));
}
function primaryMediaUrl(m){return mentionPreviewUrl(m);}
function mediaImg(url,cls='detail-media'){return `<img src=\"${url}\" data-media=\"${url}\" class=\"${cls}\" alt=\"Media\" loading=\"lazy\" onerror=\"this.closest('figure')?.classList.add('media-load-error')\">`;}
function card(m){
  const comment=isComment(m);
  return `<article class="mention-card${comment?' is-comment':''}"><img class="thumb" src="${primaryMediaUrl(m)}" alt="" loading="lazy"><div><h3>${escapeHtml(m.title||'Monitorinq qeydi')}</h3><p>${escapeHtml(m.original_text||m.summary||'')}</p><div class="mention-meta">${isCentralScope(ctx.profile)&&m.organizations?.short_name?`<span class="badge ok">${escapeHtml(m.organizations.short_name)}</span>`:''}<span class="badge info">${escapeHtml(m.source_platform||'Web')}</span>${comment?'<span class="badge comment-badge">✉ Şərh</span>':''}${sourceStateBadge(m)}<span class="badge ${m.priority_score>=81?'danger':m.priority_score>=61?'warn':'info'}">${m.priority_score||0}%</span><span class="muted">${escapeHtml(m.villages?.name||m.districts?.name||'')}</span><span class="muted">Paylaşım: ${fmtDate(publishedDate(m))}</span></div></div><div class="toolbar"><button class="btn secondary" data-open="${m.id}">Ətraflı</button>${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">${comment?'Şərhə get':'Orijinalı aç'}</a>`:''}</div></article>`;
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
    let q=supabase.from('mentions').select('id,title,summary,original_text,source_platform,source_url,author_name,priority_score,relevance_score,sentiment,published_at,detected_at,source_status,raw_payload,organization_id,district_id,village_id,organizations(short_name),districts(name),villages(name),mention_media(url,media_type,captured_at)')
      .gt('relevance_score',0)
      .or(`and(published_at.gte.${range.from},published_at.lte.${range.to}),and(published_at.is.null,detected_at.gte.${range.from},detected_at.lte.${range.to})`)
      .order('published_at',{ascending:false,nullsFirst:false})
      .order('detected_at',{ascending:false}).range(from,to);
    q=applyOrganizationScope(q,ctx.profile,organizationFilter?.value||'');
    if(platform.value) q=q.ilike('source_platform',platform.value);
    if(sentiment.value) q=q.eq('sentiment',sentiment.value);
    if(commentOnly) q=q.ilike('raw_payload->>kind','%comment%');
    const {data,error}=await q; if(error) throw error; if(token!==requestToken)return;
    const rawBatch=data||[];
    const batch=filterExcludedMentions(rawBatch,globalExcludes);
    rows=mergeUnique(rows,batch);
    done=rawBatch.length<PAGE_SIZE;
    page++;
    render(true);
  }catch(e){ if(!rows.length) list.innerHTML=`<div class="empty">${escapeHtml(e.message||String(e))}</div>`; else toast(e,'error'); }
  finally{loading=false;sentinel.classList.remove('loading');}
}

function speechText(m){
  const raw=m?.raw_payload||{};
  if(isComment(m)){
    const commentText=String(m?.original_text||raw?.text_original||raw?.comment_text||'').trim();
    const videoTitle=String(raw?.video_title||'').trim();
    return [m?.title,videoTitle?`Video: ${videoTitle}`:'',commentText].filter(Boolean).join('. ');
  }
  return [m?.title,m?.original_text].filter(Boolean).join('. ');
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
    .eq('id',id).gt('relevance_score',0).maybeSingle();
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
  const mediaRows=orderedMedia(m).filter(x=>x?.url);
  const hasScreenshot=mediaRows.some(x=>String(x?.media_type||'').toLowerCase()==='screenshot');
  const media=mediaRows.map(x=>`<figure class="detail-media-wrap">${mediaImg(x.url)}<figcaption>${escapeHtml(String(x.media_type||'media')==='screenshot'?'Arxiv ekran görüntüsü':'Xəbər şəkli / media')}</figcaption></figure>`).join('');
  const screenshotState=hasScreenshot?'':`<div class="card detail-state"><p class="muted">Arxiv ekran görüntüsü hələ hazırlanır. Sistem növbəti monitorinq run-larında bunu avtomatik tamamlayacaq.</p></div>`;
  const raw=m.raw_payload||{}; const comment=isComment(m);
  const originalText=String(m.original_text||raw.text_original||raw.comment_text||'').trim();
  document.querySelector('#modal-root').innerHTML=`<div class="modal-backdrop" id="detail-bg"><div class="modal detail-modal"><div class="modal-head detail-modal-head"><div><span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}% uyğunluq</span><h2>${escapeHtml(m.title||'Monitorinq qeydi')}</h2></div><button class="icon-btn" id="detail-close" aria-label="Bağla">✕</button></div><div class="detail-grid"><div><strong>Platforma</strong><p>${escapeHtml(m.source_platform||'—')}</p></div><div><strong>Paylaşılma tarixi</strong><p>${fmtDate(publishedDate(m))}</p></div><div><strong>Müəllif</strong><p>${escapeHtml(m.author_name||raw.author_name||raw.channel_title||'—')}</p></div><div><strong>Növ</strong><p>${comment?'Şərh':'Paylaşım / material'}</p></div></div><div class="card detail-state"><div class="mention-meta">${sourceStateBadge(m)}</div><p>${escapeHtml(sourceStateText(m))}</p></div><div class="detail-actions"><button class="btn secondary" id="detail-speak">🔊 Dinlə</button>${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">${comment?'💬 Şərhə get':'🔗 Orijinal paylaşımı aç'}</a>`:''}</div><details class="detail-original" open><summary>Orijinal mətn ${originalText.length>1800?'— aç / bağla':''}</summary><div class="muted detail-text">${escapeHtml(originalText||'Mətn saxlanmayıb.')}</div></details>${raw.comment_id?`<div class="detail-grid comment-detail-grid"><div><strong>Şərh müəllifi</strong><p>${escapeHtml(m.author_name||raw.author_name||'—')}</p></div><div><strong>Şərhin tarixi</strong><p>${fmtDate(m.published_at)}</p></div><div><strong>Video</strong><p>${escapeHtml(raw.video_title||'—')}</p></div><div><strong>Şərhin bəyənmə sayı</strong><p>${escapeHtml(raw.like_count ?? '0')}</p></div><div><strong>Şərh ID</strong><p>${escapeHtml(raw.comment_id)}</p></div><div><strong>Növ</strong><p>${raw.parent_id?'Cavab':'Əsas şərh'}</p></div></div>`:''}${screenshotState}${media?`<h3>Media / arxiv görüntüsü</h3><div class="grid grid-2">${media}</div>`:''}</div></div>`;
  document.querySelector('#detail-close').onclick=()=>{window.speechSynthesis?.cancel?.();document.querySelector('#modal-root').innerHTML='';};
  document.querySelector('#detail-bg').onclick=e=>{if(e.target.id==='detail-bg')document.querySelector('#detail-close').click();};
  document.querySelector('#detail-speak').onclick=e=>speak(m,e.currentTarget);
  document.querySelectorAll('[data-media]').forEach(x=>x.onclick=()=>openViewer(x.dataset.media));
}

let scale=1,currentUrl='',tx=0,ty=0,startX=0,startY=0,baseX=0,baseY=0,isDragging=false,pinchStart=0,pinchScale=1,pinchMidX=0,pinchMidY=0,pinchBaseX=0,pinchBaseY=0;
const viewer=document.querySelector('#viewer'),img=document.querySelector('#viewer-img'),stage=document.querySelector('#viewer-stage');
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
function openViewer(url){currentUrl=url;resetViewer();img.src=url;viewer.classList.remove('hidden');document.body.style.overflow='hidden';requestAnimationFrame(applyTransform);}
function closeViewer(){viewer.classList.add('hidden');document.body.style.overflow='';img.removeAttribute('src');resetViewer();}
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
const reset=()=>load({reset:true}); if(organizationFilter) organizationFilter.onchange=reset; platform.onchange=reset; sentiment.onchange=reset; period.onchange=()=>{presetDates(period.value);updateDateInputs();reset();}; dateFrom.onchange=()=>{period.value='custom';reset();};dateTo.onchange=()=>{period.value='custom';reset();};
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
updateDateInputs(); await load({reset:true});
const openId=new URLSearchParams(location.search).get('id'); if(openId)await openDetail(openId);

if(!isCentralScope(ctx.profile)) startLiveMonitor({organizationId:ctx.profile.organization_id,fullFirst:commentOnly,onNew:()=>load({reset:true})});
