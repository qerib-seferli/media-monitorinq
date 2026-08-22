import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';

const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'monitoring'); showPageLoader();
const ctx=await requireAuth(); if(!ctx) throw new Error('auth'); renderShell(ctx.profile,'monitoring'); hidePageLoader();

const list=document.querySelector('#list');
const platform=document.querySelector('#platform');
const sentiment=document.querySelector('#sentiment');
const period=document.querySelector('#period');
const dateFrom=document.querySelector('#date-from');
const dateTo=document.querySelector('#date-to');
const sentinel=document.querySelector('#load-sentinel');
const PAGE_SIZE=50;
let rows=[], page=0, loading=false, done=false, requestToken=0;
const commentOnly = new URLSearchParams(location.search).get('type') === 'comments';

function isoDay(d,end=false){
  const x=new Date(d); x.setHours(end?23:0,end?59:0,end?59:0,end?999:0); return x.toISOString();
}
function ymd(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function presetDates(v){
  const now=new Date(); let start=new Date(now);
  if(v==='today') start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  else if(v==='month') start=new Date(now.getFullYear(),now.getMonth(),1);
  else if(v!=='custom'){
    const m={ '3m':3,'6m':6,'9m':9,'1y':12,'2y':24,'3y':36,'4y':48,'5y':60 }[v]||1;
    start.setMonth(start.getMonth()-m);
  }
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
  if(state==='removed')return '<span class="badge danger">Mənbədən silinib</span>';
  if(state==='unavailable')return '<span class="badge warn">Mənbədə əlçatan deyil</span>';
  return '<span class="badge success">Mənbədə aktivdir</span>';
}
function sourceStateText(m){
  const state=String(m.source_status||'active');
  if(state==='removed')return 'Orijinal material mənbədən silinib. Arxiv qeydi sistemdə saxlanılır.';
  if(state==='unavailable')return 'Orijinal material hazırda açıq şəkildə əlçatan deyil.';
  return 'Orijinal material son yoxlamada mənbədə əlçatan olub.';
}
function isComment(m){return String(m.raw_payload?.kind||'').includes('comment');}
function card(m){
  const comment=isComment(m);
  return `<article class="mention-card${comment?' is-comment':''}"><img class="thumb" src="${m.mention_media?.[0]?.url||'./assets/img/icon.svg'}" alt=""><div><h3>${escapeHtml(m.title||'Monitorinq qeydi')}</h3><p>${escapeHtml(m.summary||m.original_text||'')}</p><div class="mention-meta"><span class="badge info">${escapeHtml(m.source_platform||'Web')}</span>${comment?'<span class="badge comment-badge">✉ Şərh</span>':''}${sourceStateBadge(m)}<span class="badge ${m.priority_score>=81?'danger':m.priority_score>=61?'warn':'info'}">${m.priority_score||0}%</span><span class="muted">${escapeHtml(m.villages?.name||m.districts?.name||'')}</span><span class="muted">Paylaşım: ${fmtDate(publishedDate(m))}</span></div></div><div class="toolbar"><button class="btn secondary" data-open="${m.id}">Ətraflı</button>${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">${comment?'Şərhə get':'Orijinalı aç'}</a>`:''}</div></article>`;
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
    const from=page*PAGE_SIZE, to=from+PAGE_SIZE-1;
    let q=supabase.from('mentions').select('*, districts(name), villages(name), mention_media(*)')
      .gt('relevance_score',0)
      .gte('published_at',range.from).lte('published_at',range.to)
      .order('published_at',{ascending:false,nullsFirst:false}).range(from,to);
    if(platform.value) q=q.ilike('source_platform',platform.value);
    if(sentiment.value) q=q.eq('sentiment',sentiment.value);
    if(commentOnly) q=q.or('raw_payload->>kind.eq.youtube_comment,raw_payload->>kind.eq.youtube_comment_reply');
    const {data,error}=await q; if(error) throw error; if(token!==requestToken)return;
    const batch=data||[]; rows.push(...batch); done=batch.length<PAGE_SIZE; page++; render(true);
  }catch(e){ if(!rows.length) list.innerHTML=`<div class="empty">${escapeHtml(e.message||String(e))}</div>`; else toast(e,'error'); }
  finally{loading=false;sentinel.classList.remove('loading');}
}

function speechText(m){return [m.title,m.summary,m.original_text].filter(Boolean).join('. ');}
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
  const media=(m.mention_media||[]).map(x=>`<img src="${x.url}" data-media="${x.url}" class="detail-media" alt="Media">`).join('');
  const raw=m.raw_payload||{}; const comment=isComment(m);
  document.querySelector('#modal-root').innerHTML=`<div class="modal-backdrop" id="detail-bg"><div class="modal detail-modal"><div class="modal-head detail-modal-head"><div><span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}% uyğunluq</span><h2>${escapeHtml(m.title||'Monitorinq qeydi')}</h2></div><button class="icon-btn" id="detail-close" aria-label="Bağla">✕</button></div><div class="detail-grid"><div><strong>Platforma</strong><p>${escapeHtml(m.source_platform||'—')}</p></div><div><strong>Paylaşılma tarixi</strong><p>${fmtDate(publishedDate(m))}</p></div><div><strong>Müəllif</strong><p>${escapeHtml(m.author_name||'—')}</p></div><div><strong>Növ</strong><p>${comment?'Şərh':'Paylaşım / material'}</p></div></div><div class="card detail-state"><div class="mention-meta">${sourceStateBadge(m)}</div><p>${escapeHtml(sourceStateText(m))}</p></div><div class="detail-actions"><button class="btn secondary" id="detail-speak">🔊 Dinlə</button>${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">${comment?'💬 Şərhə get':'🔗 Orijinal paylaşımı aç'}</a>`:''}</div><h3>AI xülasəsi</h3><p>${escapeHtml(m.summary||'Xülasə yoxdur.')}</p><h3>Orijinal mətn</h3><p class="muted detail-text">${escapeHtml(m.original_text||'Mətn saxlanmayıb.')}</p>${raw.comment_id?`<div class="detail-grid comment-detail-grid"><div><strong>Şərh müəllifi</strong><p>${escapeHtml(m.author_name||raw.author_name||'—')}</p></div><div><strong>Şərhin tarixi</strong><p>${fmtDate(m.published_at)}</p></div><div><strong>Video</strong><p>${escapeHtml(raw.video_title||'—')}</p></div><div><strong>Bəyənmə</strong><p>${escapeHtml(raw.like_count ?? '0')}</p></div><div><strong>Şərh ID</strong><p>${escapeHtml(raw.comment_id)}</p></div><div><strong>Növ</strong><p>${raw.parent_id?'Cavab':'Əsas şərh'}</p></div></div>`:''}${media?`<h3>Media / arxiv görüntüsü</h3><div class="grid grid-2">${media}</div>`:''}</div></div>`;
  document.querySelector('#detail-close').onclick=()=>{window.speechSynthesis?.cancel?.();document.querySelector('#modal-root').innerHTML='';};
  document.querySelector('#detail-bg').onclick=e=>{if(e.target.id==='detail-bg')document.querySelector('#detail-close').click();};
  document.querySelector('#detail-speak').onclick=e=>speak(m,e.currentTarget);
  document.querySelectorAll('[data-media]').forEach(x=>x.onclick=()=>openViewer(x.dataset.media));
}

let scale=1,currentUrl='',tx=0,ty=0,startX=0,startY=0,baseX=0,baseY=0,isDragging=false,pinchStart=0,pinchScale=1;
const viewer=document.querySelector('#viewer'),img=document.querySelector('#viewer-img'),stage=document.querySelector('#viewer-stage');
function applyTransform(){img.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;}
function resetViewer(){scale=1;tx=0;ty=0;applyTransform();}
function openViewer(url){currentUrl=url;resetViewer();img.src=url;document.querySelector('#save-media').href=url;viewer.classList.remove('hidden');document.body.style.overflow='hidden';}
function closeViewer(){viewer.classList.add('hidden');document.body.style.overflow='';resetViewer();}
document.querySelector('#viewer-close').onclick=closeViewer;
document.querySelector('#zoom-in').onclick=()=>{scale=Math.min(4,scale+.25);applyTransform()};
document.querySelector('#zoom-out').onclick=()=>{scale=Math.max(.75,scale-.25);if(scale<=1){tx=0;ty=0}applyTransform()};
document.querySelector('#share-media').onclick=async()=>{if(navigator.share){try{await navigator.share({title:'Media Monitorinq — Media',url:currentUrl})}catch{}}else if(navigator.clipboard){await navigator.clipboard.writeText(currentUrl);toast('Media linki kopyalandı','success')}};
stage.addEventListener('pointerdown',e=>{if(scale<=1)return;isDragging=true;startX=e.clientX;startY=e.clientY;baseX=tx;baseY=ty;stage.setPointerCapture?.(e.pointerId)});
stage.addEventListener('pointermove',e=>{if(!isDragging)return;tx=baseX+(e.clientX-startX);ty=baseY+(e.clientY-startY);applyTransform()});
stage.addEventListener('pointerup',()=>isDragging=false);stage.addEventListener('pointercancel',()=>isDragging=false);
stage.addEventListener('dblclick',()=>{if(scale===1)scale=2;else resetViewer();applyTransform()});
stage.addEventListener('touchstart',e=>{if(e.touches.length===2){pinchStart=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);pinchScale=scale}},{passive:true});
stage.addEventListener('touchmove',e=>{if(e.touches.length===2&&pinchStart){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale=Math.max(.75,Math.min(4,pinchScale*(d/pinchStart)));applyTransform()}},{passive:true});
stage.addEventListener('touchend',()=>{pinchStart=0});

const reset=()=>load({reset:true}); platform.onchange=reset; sentiment.onchange=reset; period.onchange=()=>{presetDates(period.value);updateDateInputs();reset();}; dateFrom.onchange=()=>{period.value='custom';reset();};dateTo.onchange=()=>{period.value='custom';reset();};
new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting)load();},{rootMargin:'500px'}).observe(sentinel);
if(commentOnly){
  const h1=document.querySelector('.monitor-head h1');
  const p=document.querySelector('.monitor-head p');
  if(h1) h1.textContent='Aşkarlanan rəylər';
  if(p) p.textContent='Monitorinqə düşən bütün uyğun YouTube şərhləri və cavabları.';
  platform.value='YouTube';
  period.value='custom';
  dateFrom.value='2010-01-01';
  dateTo.value=ymd(new Date());
}else{
  if(!period.value || period.value==='custom') period.value='month';
  presetDates(period.value);
}
updateDateInputs(); await load({reset:true});
const openId=new URLSearchParams(location.search).get('id'); if(openId)await openDetail(openId);

startLiveMonitor({organizationId:ctx.profile.organization_id,fullFirst:commentOnly,onNew:()=>load({reset:true})});
