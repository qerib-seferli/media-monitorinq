import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';

const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'notifications'); showPageLoader();
const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
renderShell(ctx.profile,'notifications');
hidePageLoader();

const list = document.querySelector('#notification-list');
let rows = [];
let mentionMap = new Map();
const isComment=m=>String(m?.raw_payload?.kind||'').includes('comment');

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
    const content = `<span class="notification-icon ${toneOf(item)}${comment?' comment-icon':''}">${comment?'✉':(toneOf(item)==='danger'?'!':'i')}</span><span class="notification-copy"><strong>${escapeHtml(item.title || 'Bildiriş')}</strong><span>${escapeHtml(item.body || '')}</span><time>${fmtDate(mention?.published_at||item.created_at)}</time></span><span class="notification-arrow">${href?'›':''}</span>`;
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
  const {data:mentions=[]}=await supabase.from('mentions').select('id,published_at,raw_payload,relevance_score').in('id',ids);
  mentionMap=new Map(mentions.map(x=>[x.id,x]));
}
rows=rows.filter(x=>!x.mention_id||Number(mentionMap.get(x.mention_id)?.relevance_score||0)>0);
rows.sort((a,b)=>new Date(mentionMap.get(b.mention_id)?.published_at||b.created_at||0)-new Date(mentionMap.get(a.mention_id)?.published_at||a.created_at||0));
render();

startLiveMonitor({organizationId:ctx.profile.organization_id,onNew:()=>location.reload()});
