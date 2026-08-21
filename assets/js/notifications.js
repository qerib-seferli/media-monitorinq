import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast } from './core.js';

const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
renderShell(ctx.profile,'notifications');

const list = document.querySelector('#notification-list');
let rows = [];
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
    const content = `<span class="notification-icon ${toneOf(item)}">${toneOf(item)==='danger'?'!':'i'}</span><span class="notification-copy"><strong>${escapeHtml(item.title || 'Bildiriş')}</strong><span>${escapeHtml(item.body || '')}</span><time>${fmtDate(item.created_at)}</time></span><span class="notification-arrow">${href?'›':''}</span>`;
    return href ? `<a class="notification-card" href="${href}">${content}</a>` : `<article class="notification-card">${content}</article>`;
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
render();
