import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';

const cachedProfile=getCachedProfile();if(cachedProfile)renderShell(cachedProfile,'monitoring');showPageLoader();const ctx=await requireAuth();if(!ctx)throw new Error('auth');renderShell(ctx.profile,'monitoring');hidePageLoader();
const list=document.querySelector('#list'),platform=document.querySelector('#platform'),sentiment=document.querySelector('#sentiment');let rows=[];

async function load(){
  let q=supabase.from('mentions').select('*, districts(name), villages(name), mention_media(*)').order('detected_at',{ascending:false}).limit(150);
  if(platform.value)q=q.eq('source_platform',platform.value);
  if(sentiment.value)q=q.eq('sentiment',sentiment.value);
  const{data,error}=await q;
  if(error){list.innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;return;}
  rows=data||[];render();
}
function render(){
  list.innerHTML=rows.length?rows.map(m=>`<article class="mention-card"><img class="thumb" src="${m.mention_media?.[0]?.url||'./assets/img/icon.svg'}" alt=""><div><h3>${escapeHtml(m.title||'Monitorinq qeydi')}</h3><p>${escapeHtml(m.summary||m.original_text||'')}</p><div class="mention-meta"><span class="badge info">${escapeHtml(m.source_platform||'Web')}</span><span class="badge ${m.priority_score>=81?'danger':m.priority_score>=61?'warn':'info'}">${m.priority_score||0}%</span><span class="muted">${escapeHtml(m.villages?.name||m.districts?.name||'')}</span><span class="muted">${fmtDate(m.detected_at)}</span></div></div><div class="toolbar"><button class="btn secondary" data-open="${m.id}">Ətraflı</button>${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">Orijinalı aç</a>`:''}</div></article>`).join(''):'<div class="card empty">Nəticə tapılmadı.</div>';
  document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDetail(b.dataset.open));
}
function openDetail(id){
  const m=rows.find(x=>x.id===id);if(!m)return;
  const media=(m.mention_media||[]).map(x=>`<img src="${x.url}" data-media="${x.url}" style="width:100%;max-height:260px;object-fit:cover;border-radius:14px;cursor:zoom-in" alt="media">`).join('');
  document.querySelector('#modal-root').innerHTML=`<div class="modal-backdrop" id="detail-bg"><div class="modal"><div class="modal-head"><div><span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}% uyğunluq</span><h2>${escapeHtml(m.title||'Monitorinq qeydi')}</h2></div><button class="icon-btn" id="detail-close">✕</button></div><div class="grid grid-2"><div><strong>Platforma</strong><p class="muted">${escapeHtml(m.source_platform||'—')}</p></div><div><strong>Aşkarlanıb</strong><p class="muted">${fmtDate(m.detected_at)}</p></div></div><h3>AI xülasəsi</h3><p>${escapeHtml(m.summary||'Xülasə yoxdur.')}</p><h3>Orijinal mətn</h3><p class="muted" style="white-space:pre-wrap">${escapeHtml(m.original_text||'Mətn saxlanmayıb.')}</p>${media?`<h3>Screenshot / Media</h3><div class="grid grid-2">${media}</div>`:''}<div class="toolbar" style="margin-top:18px">${m.source_url?`<a class="btn" target="_blank" rel="noopener" href="${m.source_url}">🔗 Orijinal paylaşımı aç</a>`:''}</div></div></div>`;
  document.querySelector('#detail-close').onclick=()=>document.querySelector('#modal-root').innerHTML='';
  document.querySelector('#detail-bg').onclick=e=>{if(e.target.id==='detail-bg')document.querySelector('#modal-root').innerHTML=''};
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
document.querySelector('#share-media').onclick=async()=>{
  if(navigator.share){try{await navigator.share({title:'Media Monitorinq — Screenshot',url:currentUrl})}catch{}}
  else if(navigator.clipboard){await navigator.clipboard.writeText(currentUrl);toast('Media linki kopyalandı','success')}
};

stage.addEventListener('pointerdown',e=>{if(scale<=1)return;isDragging=true;startX=e.clientX;startY=e.clientY;baseX=tx;baseY=ty;stage.setPointerCapture?.(e.pointerId)});
stage.addEventListener('pointermove',e=>{if(!isDragging)return;tx=baseX+(e.clientX-startX);ty=baseY+(e.clientY-startY);applyTransform()});
stage.addEventListener('pointerup',()=>isDragging=false);stage.addEventListener('pointercancel',()=>isDragging=false);
stage.addEventListener('dblclick',()=>{if(scale===1)scale=2;else resetViewer();applyTransform()});
stage.addEventListener('touchstart',e=>{if(e.touches.length===2){pinchStart=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);pinchScale=scale}},{passive:true});
stage.addEventListener('touchmove',e=>{if(e.touches.length===2&&pinchStart){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale=Math.max(.75,Math.min(4,pinchScale*(d/pinchStart)));applyTransform()}},{passive:true});
stage.addEventListener('touchend',()=>{pinchStart=0});

platform.onchange=load;sentiment.onchange=load;await load();
const openId=new URLSearchParams(location.search).get('id');if(openId)openDetail(openId);
