import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
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
let rows = [];
let mentionMap = new Map();
const isComment=m=>String(m?.raw_payload?.kind||'').includes('comment');
const sourceStatus=m=>String(m?.source_status||'active');

let filter = 'all';

function toneOf(item) {
  const kind = String(item.kind || '').toLowerCase();
  if (kind.includes('critical') || kind.includes('risk')) return 'danger';
  if (kind.includes('system')) return 'info';
  return 'ok';
}

function matches(item) {
  if (filter === 'all') return true;
  const kind = String(item.kind || '').toLowerCase();
  if (filter === 'critical') return kind.includes('critical') || kind.includes('risk');
  if (filter === 'system') return kind.includes('system');
  return true;
}

function render() {
  const visible = rows.filter(matches);
  list.innerHTML = visible.length ? visible.map(item => {
    const href = item.mention_id ? `./monitorinq.html?id=${encodeURIComponent(item.mention_id)}` : '';
    const mention=mentionMap.get(item.mention_id);
    const comment=isComment(mention);
    const removed=sourceStatus(mention)==='removed';
    const unavailable=sourceStatus(mention)==='unavailable';
    const statusChip=removed?`<span class="notification-status-chip removed">${comment?'Şərh silinib':'Material silinib'}</span>`:unavailable?'<span class="notification-status-chip unavailable">Əlçatan deyil</span>':'';
    const content = `<span class="notification-icon ${removed?'danger':toneOf(item)}${comment?' comment-icon':''}">${comment?'✉':(removed||toneOf(item)==='danger'?'!':'i')}</span><span class="notification-copy"><span class="notification-title-row"><strong>${escapeHtml(item.title || 'Bildiriş')}</strong>${statusChip}</span><span class="notification-body">${escapeHtml(item.body || '')}</span><span class="notification-meta-row"><time>${fmtDate(mention?.published_at||item.created_at)}</time>${comment?'<span class="mini-type-chip">YouTube rəyi</span>':''}</span></span><span class="notification-arrow">${href?'›':''}</span>`;
    return href ? `<a class="notification-card${comment?' is-comment':''}" href="${href}">${content}</a>` : `<article class="notification-card${comment?' is-comment':''}">${content}</article>`;
  }).join('') : '<div class="card empty">Bu filtr üzrə bildiriş yoxdur.</div>';
}

document.querySelectorAll('[data-notification-filter]').forEach(btn => btn.addEventListener('click', () => {
  filter = btn.dataset.notificationFilter;
  document.querySelectorAll('[data-notification-filter]').forEach(x => x.classList.toggle('active', x === btn));
  render();
}));

const { data, error } = await supabase.from('notifications').select('*').order('created_at',{ascending:false}).limit(150);
if (error) toast(error,'error');
rows = data || [];
const ids=[...new Set(rows.map(x=>x.mention_id).filter(Boolean))];
if(ids.length){
  const {data:mentions=[]}=await supabase.from('mentions').select('id,published_at,raw_payload,relevance_score,source_status,title,summary,original_text,author_name,source_url,organizations(short_name)').in('id',ids);
  mentionMap=new Map(mentions.map(x=>[x.id,x]));
}
const ownPortalNoise=m=>{try{const u=new URL(String(m?.source_url||''));const host=u.hostname.replace(/^www\./i,'').toLowerCase();const path=u.pathname.replace(/\/+$/,'')||'/';return /smsii\.az$/i.test(host)&&(path==='/'||path==='/index.html');}catch{return false;}};
rows=rows.filter(x=>!x.mention_id||(Number(mentionMap.get(x.mention_id)?.relevance_score||0)>0&&!ownPortalNoise(mentionMap.get(x.mention_id))&&!isMentionExcluded(mentionMap.get(x.mention_id),globalExcludes)));
rows.sort((a,b)=>new Date(mentionMap.get(b.mention_id)?.published_at||b.created_at||0)-new Date(mentionMap.get(a.mention_id)?.published_at||a.created_at||0));
render();

startLiveMonitor({organizationId:ctx.profile.organization_id,onNew:()=>location.reload()});
