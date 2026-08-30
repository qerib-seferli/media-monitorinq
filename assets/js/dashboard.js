import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, registerSW, friendlyError, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';
import { applyOrganizationScope, isCentralScope, setupOrganizationFilter, loadGlobalExcludes, filterExcludedMentions, mentionPreviewUrl, isMentionExcluded } from './scope.js';

registerSW();
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'dashboard'); showPageLoader();
const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
renderShell(ctx.profile,'dashboard');
hidePageLoader();

const fullName = `${ctx.profile.first_name || ''} ${ctx.profile.last_name || ''}`.trim() || 'İstifadəçi';
document.querySelector('#hello').textContent = `Salam, ${fullName}`;
const organizationFilter=document.querySelector('#organization-filter');
await setupOrganizationFilter(ctx.profile, organizationFilter);
const today = new Date(); today.setHours(0,0,0,0);
let latest=[], notifs=[];

async function fetchDashboardData(){
  const orgId=organizationFilter?.value||'';
  const scoped=(q)=>applyOrganizationScope(q,ctx.profile,orgId);
  const excludes=await loadGlobalExcludes();
  const [todayRowsRes,latestRes,notifRes]=await Promise.all([
    scoped(supabase.from('mentions').select('id,title,summary,original_text,source_platform,priority_score,sentiment,published_at,detected_at').gt('relevance_score',0).gte('published_at',today.toISOString()).limit(1000)),
    scoped(supabase.from('mentions').select('id,title,summary,original_text,source_platform,source_url,priority_score,sentiment,detected_at,published_at,source_status,raw_payload,organization_id,organizations(short_name),mention_media(url,media_type)').gt('relevance_score',0).order('published_at',{ascending:false,nullsFirst:false}).limit(20)),
    scoped(supabase.from('notifications').select('*').order('created_at',{ascending:false}).limit(30))
  ]);
  const fatal=[todayRowsRes,latestRes,notifRes].find(x=>x.error); if(fatal?.error) console.warn(friendlyError(fatal.error));
  const todayRows=filterExcludedMentions(todayRowsRes.data||[],excludes);
  const latestRows=filterExcludedMentions(latestRes.data||[],excludes).slice(0,6);
  return {todayRows,latestRows,notifRows:notifRes.data||[],excludes};
}
const isComment=m=>String(m?.raw_payload?.kind||'').includes('comment');
const stateBadge=m=>String(m?.source_status||'active')==='removed'?`<span class="badge danger source-removed">${isComment(m)?'Şərh silinib':'Material silinib'}</span>`:String(m?.source_status||'active')==='unavailable'?'<span class="badge warn">Əlçatan deyil</span>':'';
async function renderDashboard(){
  const results=await fetchDashboardData();
  const todayRows=results.todayRows||[]; latest=results.latestRows||[]; notifs=results.notifRows||[];
  const items=[['Yeni qeydlər',todayRows.length,'info'],['Yüksək risk',todayRows.filter(x=>Number(x.priority_score||0)>=81).length,'danger'],['Mənfi',todayRows.filter(x=>x.sentiment==='negative').length,'warn'],['Müsbət',todayRows.filter(x=>x.sentiment==='positive').length,'ok']];
  document.querySelector('#metrics').innerHTML=items.map(([l,n,c])=>`<article class="card metric"><span class="badge ${c}">${escapeHtml(l)}</span><div class="num">${n}</div><div class="label">Bu gün</div></article>`).join('');
const latestEl=document.querySelector('#latest');
latestEl.innerHTML=latest?.length?latest.map(m=>`<article class="mention-card dashboard-mention-card${isComment(m)?' is-comment':''}" data-detail-href="./monitorinq.html?id=${encodeURIComponent(m.id)}" tabindex="0" role="link" aria-label="${escapeHtml((m.title||'Monitorinq qeydi')+' — ətraflı bax')}"><img class="thumb" src="${mentionPreviewUrl(m)}" alt=""><div><h3>${escapeHtml(m.title||'Adsız qeyd')}</h3><p>${escapeHtml(m.summary||'')}</p><div class="mention-meta">${isCentralScope(ctx.profile)&&m.organizations?.short_name?`<span class="badge ok">${escapeHtml(m.organizations.short_name)}</span>`:''}<span class="badge info">${escapeHtml(m.source_platform||'Web')}</span>${isComment(m)?'<span class="badge comment-badge">✉ Şərh</span>':''}${stateBadge(m)}<span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}%</span><span class="muted">Paylaşım: ${fmtDate(m.published_at||m.detected_at)}</span></div></div></article>`).join(''):'<div class="empty compact-empty">Hələ nəticə yoxdur.</div>';
latestEl.querySelectorAll('[data-detail-href]').forEach(card=>{
  const open=()=>location.href=card.dataset.detailHref;
  card.addEventListener('click',open);
  card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
});
const n=document.querySelector('#notif-list');
let notifRows=notifs||[];
const notifIds=[...new Set(notifRows.map(x=>x.mention_id).filter(Boolean))];
let mentionMap=new Map();
if(notifIds.length){
  const {data:linked=[]}=await supabase.from('mentions').select('id,published_at,raw_payload,relevance_score,source_status,title,summary,original_text,author_name,organizations(short_name)').in('id',notifIds);
  mentionMap=new Map(linked.map(x=>[x.id,x]));
}
notifRows=notifRows.filter(x=>!x.mention_id||(Number(mentionMap.get(x.mention_id)?.relevance_score||0)>0&&!isMentionExcluded(mentionMap.get(x.mention_id),results.excludes))).sort((a,b)=>new Date(mentionMap.get(b.mention_id)?.published_at||b.created_at||0)-new Date(mentionMap.get(a.mention_id)?.published_at||a.created_at||0)).slice(0,5);
n.innerHTML=notifRows.length?notifRows.map(x=>{const m=mentionMap.get(x.mention_id);const comment=isComment(m);const removed=String(m?.source_status||'active')==='removed';const unavailable=String(m?.source_status||'active')==='unavailable';const status=removed?`<span class="dashboard-status-chip removed">${comment?'Şərh silinib':'Material silinib'}</span>`:unavailable?'<span class="dashboard-status-chip unavailable">Əlçatan deyil</span>':'';return `<a class="dashboard-notification${comment?' is-comment':''}${removed?' is-removed':''}" href="${x.mention_id ? `./monitorinq.html?id=${x.mention_id}` : './bildirisler.html'}"><span class="notification-dot ${removed?'removed':x.kind==='critical'?'critical':'system'}"></span><span class="dashboard-notification-copy"><strong>${escapeHtml(x.title||'Bildiriş')}${comment?'<span class="dashboard-comment-chip">✉ Şərh</span>':''}${status}</strong><small>${escapeHtml(x.body||'')}</small></span><time>${fmtDate(m?.published_at||x.created_at)}</time><span class="dashboard-notification-arrow">›</span></a>`}).join(''):'<div class="empty compact-empty">Yeni bildiriş yoxdur.</div>';

}
await renderDashboard();
if(organizationFilter) organizationFilter.onchange=renderDashboard;
if(!isCentralScope(ctx.profile)) startLiveMonitor({organizationId:ctx.profile.organization_id,onNew:()=>{ if(!document.hidden) renderDashboard(); }});
