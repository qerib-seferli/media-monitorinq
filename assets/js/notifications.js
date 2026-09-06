import { requireAuth } from './guard.js';
import { renderShell, markNotificationsSeen } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';
import { loadGlobalExcludes, isMentionExcluded } from './scope.js';

const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'notifications'); showPageLoader();
const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
renderShell(ctx.profile,'notifications');
hidePageLoader();

const list = document.querySelector('#notification-list');
const globalExcludes=await loadGlobalExcludes();
const PAGE_SIZE=20;
let rows=[], mentionMap=new Map(), page=0, loading=false, done=false, filter='all';
const isComment=m=>String(m?.raw_payload?.kind||'').includes('comment');
const sourceStatus=m=>String(m?.source_status||'active');

const sentinel=document.createElement('div');
sentinel.className='notification-load-sentinel';
sentinel.setAttribute('aria-hidden','true');
list.insertAdjacentElement('afterend',sentinel);

function toneOf(item) {
  const kind = String(item.kind || '').toLowerCase();
  if (kind.includes('critical') || kind.includes('risk')) return 'danger';
  if (kind.includes('system') || kind.includes('removed') || kind.includes('unavailable')) return 'info';
  return 'ok';
}
function matches(item) {
  if (filter === 'all') return true;
  const kind = String(item.kind || '').toLowerCase();
  if (filter === 'critical') return kind.includes('critical') || kind.includes('risk');
  if (filter === 'system') return kind.includes('system') || kind.includes('removed') || kind.includes('unavailable');
  return true;
}
function ownPortalNoise(m){try{const u=new URL(String(m?.source_url||''));const host=u.hostname.replace(/^www\./i,'').toLowerCase();const path=u.pathname.replace(/\/+$/,'')||'/';return /smsii\.az$/i.test(host)&&(path==='/'||path==='/index.html');}catch{return false;}}
function validNotification(item){
  if(!item.mention_id) return true;
  const m=mentionMap.get(item.mention_id);
  return Number(m?.relevance_score||0)>0 && !ownPortalNoise(m) && !isMentionExcluded(m,globalExcludes);
}
function card(item){
  const href = item.mention_id ? `./monitorinq.html?id=${encodeURIComponent(item.mention_id)}` : '';
  const mention=mentionMap.get(item.mention_id);
  const comment=isComment(mention);
  const removed=sourceStatus(mention)==='removed' || String(item.kind||'').toLowerCase()==='removed';
  const unavailable=sourceStatus(mention)==='unavailable';
  const statusChip=removed?`<span class="notification-status-chip removed">${comment?'Şərh silinib':'Material silinib'}</span>`:unavailable?'<span class="notification-status-chip unavailable">Əlçatan deyil</span>':'';
  const content = `<span class="notification-icon ${removed?'danger':toneOf(item)}${comment?' comment-icon':''}">${comment?'✉':(removed||toneOf(item)==='danger'?'!':'i')}</span><span class="notification-copy"><span class="notification-title-row"><strong>${escapeHtml(item.title || 'Bildiriş')}</strong>${statusChip}</span><span class="notification-body">${escapeHtml(item.body || '')}</span><span class="notification-meta-row"><time>${fmtDate(mention?.published_at||item.created_at)}</time>${comment?'<span class="mini-type-chip">YouTube rəyi</span>':''}</span></span><span class="notification-arrow">${href?'›':''}</span>`;
  return href ? `<a class="notification-card${comment?' is-comment':''}" href="${href}">${content}</a>` : `<article class="notification-card${comment?' is-comment':''}">${content}</article>`;
}
function render(){
  const visible=rows.filter(validNotification).filter(matches);
  list.innerHTML=visible.length?visible.map(card).join(''):'<div class="card empty">Bu filtr üzrə bildiriş yoxdur.</div>';
}

async function loadNext({reset=false}={}){
  if(loading || (done&&!reset)) return;
  if(reset){page=0;done=false;rows=[];mentionMap=new Map();render();}
  loading=true;sentinel.classList.add('loading');
  try{
    const from=page*PAGE_SIZE,to=from+PAGE_SIZE-1;
    let notificationQuery=supabase.from('notifications').select('*').order('created_at',{ascending:false}).range(from,to);
    if(ctx.profile?.service_point_id) notificationQuery=notificationQuery.eq('service_point_id',ctx.profile.service_point_id);
    else if(ctx.profile?.access_scope!=='all' && ctx.profile?.system_role!=='super_admin' && ctx.profile?.organization_id) notificationQuery=notificationQuery.eq('organization_id',ctx.profile.organization_id);
    const {data,error}=await notificationQuery;
    if(error)throw error;
    const batch=data||[];
    const ids=[...new Set(batch.map(x=>x.mention_id).filter(Boolean))];
    if(ids.length){
      const {data:mentions=[],error:mentionError}=await supabase.from('mentions').select('id,published_at,raw_payload,relevance_score,source_status,title,summary,original_text,author_name,source_url,organizations(short_name)').in('id',ids);
      if(mentionError) throw mentionError;
      mentions.forEach(x=>mentionMap.set(x.id,x));
    }
    rows.push(...batch);
    rows.sort((a,b)=>new Date(mentionMap.get(b.mention_id)?.published_at||b.created_at||0)-new Date(mentionMap.get(a.mention_id)?.published_at||a.created_at||0));
    done=batch.length<PAGE_SIZE;page++;render();
    if(page===1 && batch[0]?.created_at) markNotificationsSeen(ctx.profile,batch[0].created_at);
  }catch(e){toast(e,'error');}
  finally{loading=false;sentinel.classList.remove('loading');}
}

document.querySelectorAll('[data-notification-filter]').forEach(btn => btn.addEventListener('click', () => {
  filter = btn.dataset.notificationFilter;
  document.querySelectorAll('[data-notification-filter]').forEach(x => x.classList.toggle('active', x === btn));
  render();
}));

const observer=new IntersectionObserver(entries=>{if(entries.some(x=>x.isIntersecting))loadNext();},{rootMargin:'500px 0px'});
observer.observe(sentinel);
await loadNext({reset:true});
startLiveMonitor({organizationId:ctx.profile.organization_id,onNew:()=>{if(!document.hidden)loadNext({reset:true});}});
