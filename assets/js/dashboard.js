import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, registerSW, friendlyError, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';

registerSW();
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'dashboard'); showPageLoader();
const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
renderShell(ctx.profile,'dashboard');
hidePageLoader();

const fullName = `${ctx.profile.first_name || ''} ${ctx.profile.last_name || ''}`.trim() || 'İstifadəçi';
document.querySelector('#hello').textContent = `Salam, ${fullName}`;

const today = new Date();
today.setHours(0,0,0,0);
const results = await Promise.all([
  supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()),
  supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).gte('priority_score',81),
  supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).eq('sentiment','negative'),
  supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).eq('sentiment','positive'),
  supabase.from('mentions').select('id,title,summary,source_platform,source_url,priority_score,sentiment,detected_at,published_at,mention_media(url,media_type)').order('detected_at',{ascending:false}).limit(6),
  supabase.from('notifications').select('*').order('created_at',{ascending:false}).limit(5)
]);

const fatal = results.find(x => x.error);
if (fatal?.error) console.warn(friendlyError(fatal.error));
const [{count:total},{count:critical},{count:negative},{count:positive},{data:latest},{data:notifs}] = results;
const items=[['Yeni qeydlər',total||0,'info'],['Yüksək risk',critical||0,'danger'],['Mənfi',negative||0,'warn'],['Müsbət',positive||0,'ok']];
document.querySelector('#metrics').innerHTML=items.map(([l,n,c])=>`<article class="card metric"><span class="badge ${c}">${escapeHtml(l)}</span><div class="num">${n}</div><div class="label">Bu gün</div></article>`).join('');
const latestEl=document.querySelector('#latest');
latestEl.innerHTML=latest?.length?latest.map(m=>`<article class="mention-card"><img class="thumb" src="${m.mention_media?.[0]?.url||'./assets/img/icon.svg'}" alt=""><div><h3>${escapeHtml(m.title||'Adsız qeyd')}</h3><p>${escapeHtml(m.summary||'')}</p><div class="mention-meta"><span class="badge info">${escapeHtml(m.source_platform||'Web')}</span><span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}%</span><span class="muted">Paylaşım: ${fmtDate(m.published_at||m.detected_at)}</span></div></div><a class="btn secondary" href="./monitorinq.html?id=${m.id}">Ətraflı</a></article>`).join(''):'<div class="empty compact-empty">Hələ nəticə yoxdur.</div>';
const n=document.querySelector('#notif-list');
n.innerHTML=notifs?.length?notifs.map(x=>`<a class="dashboard-notification" href="${x.mention_id ? `./monitorinq.html?id=${x.mention_id}` : './bildirisler.html'}"><span class="notification-dot ${x.kind==='critical'?'critical':'system'}"></span><span><strong>${escapeHtml(x.title||'Bildiriş')}</strong><small>${escapeHtml(x.body||'')}</small></span><time>${fmtDate(x.created_at)}</time></a>`).join(''):'<div class="empty compact-empty">Yeni bildiriş yoxdur.</div>';
