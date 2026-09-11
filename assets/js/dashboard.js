import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, registerSW, friendlyError, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';
import { startLiveMonitor } from './live-monitor.js';
import { applyOrganizationScope, isCentralScope, setupOrganizationFilter, loadGlobalExcludes, filterExcludedMentions, mentionPreviewUrl, isMentionExcluded } from './scope.js';
import { initAzerbaijanMonitoringMap } from './azerbaijan-map.js';

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
if(isCentralScope(ctx.profile)){const card=document.querySelector('#dashboard-azerbaijan-map-card');card?.classList.remove('hidden');initAzerbaijanMonitoringMap({rootId:'dashboard-azerbaijan-live-map',profile:ctx.profile,allowScan:true});}
const today = new Date(); today.setHours(0,0,0,0);
let latest=[], notifs=[];

async function fetchDashboardData(){
  const orgId=organizationFilter?.value||'';
  const scoped=(q)=>applyOrganizationScope(q,ctx.profile,orgId);
  const excludes=await loadGlobalExcludes();
  const todayIso=today.toISOString();
  const countQuery=(extra=(q)=>q)=>extra(scoped(
    supabase.from('mentions').select('id',{count:'exact',head:true})
      .gt('relevance_score',0).or('priority_score.gte.31,relevance_score.gte.31').gte('detected_at',todayIso)
  ));
  // Dashboard statistikası üçün 1000 tam sətir yükləmək əvəzinə yalnız server count gəlir.
  // Bu xüsusilə mərkəzi istifadəçidə aylıq Supabase egressini kəskin azaldır.
  const [allCount,highCount,negCount,posCount,latestRes,notifRes]=await Promise.all([
    countQuery(),
    countQuery(q=>q.gte('priority_score',81)),
    countQuery(q=>q.eq('sentiment','negative')),
    countQuery(q=>q.eq('sentiment','positive')),
    scoped(supabase.from('mentions').select('id,title,summary,original_text,source_platform,source_url,priority_score,relevance_score,sentiment,detected_at,published_at,source_status,raw_payload,organization_id,organizations(short_name),service_point:organization_service_points!mentions_service_point_id_fkey(short_name,name),mention_media(url,media_type)').gt('relevance_score',0).or('priority_score.gte.31,relevance_score.gte.31').not('published_at','is',null).order('published_at',{ascending:false}).limit(48)),
    scoped(supabase.from('notifications').select('id,organization_id,mention_id,title,body,kind,created_at').order('created_at',{ascending:false}).limit(32))
  ]);
  const fatal=[allCount,highCount,negCount,posCount,latestRes,notifRes].find(x=>x.error); if(fatal?.error) console.warn(friendlyError(fatal.error));
  const latestRows=filterExcludedMentions(latestRes.data||[],excludes)
    .filter(hasReliablePublishedDate)
    .filter(m=>!(isComment(m)&&String(m?.source_status||'active')==='removed'))
    .sort((a,b)=>new Date(b.published_at||0)-new Date(a.published_at||0))
    .slice(0,6);
  return {
    metrics:{total:allCount.count||0,high:highCount.count||0,negative:negCount.count||0,positive:posCount.count||0},
    latestRows,notifRows:notifRes.data||[],excludes
  };
}
function canonicalPlatform(value=''){const p=String(value||'').trim().toLowerCase();if(p.includes('youtube'))return 'YouTube';if(p.includes('facebook'))return 'Facebook';if(p.includes('instagram'))return 'Instagram';if(p.includes('tiktok'))return 'TikTok';if(p.includes('linkedin'))return 'LinkedIn';if(p==='x'||p.includes('twitter'))return 'X';if(p==='web'||p.includes('google news')||p.includes('bing'))return 'Web';return String(value||'Web').trim()||'Web';}
const isComment=m=>{const k=String(m?.raw_payload?.kind||'').toLowerCase();return k.includes('comment')||k.includes('reply');};
function hasReliablePublishedDate(m){if(!m?.published_at)return false;const platform=String(m?.source_platform||'').toLowerCase();if(platform.includes('youtube'))return true;const raw=m?.raw_payload||{};if(platform==='web'||platform.includes('google news')){const source=String(raw?.published_date_source||'');return raw?.published_from_page===true&&raw?.published_date_status==='verified'&&Number(raw?.date_parser_version||0)>=2&&['structured:datePublished','meta:article:published_time','visible:article-heading'].includes(source);}return true;}
const stateBadge=m=>String(m?.source_status||'active')==='removed'?`<span class="badge danger source-removed">${isComment(m)?'Şərh silinib':'Material silinib'}</span>`:String(m?.source_status||'active')==='unavailable'?'<span class="badge warn">Əlçatan deyil</span>':'';
function dashboardPlatformIcon(label=''){
  const common='viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  const icons={
    YouTube:`<svg ${common}><path d="M21.2 7.05a2.9 2.9 0 0 0-2.04-2.05C17.35 4.5 12 4.5 12 4.5s-5.35 0-7.16.5A2.9 2.9 0 0 0 2.8 7.05C2.3 8.86 2.3 12 2.3 12s0 3.14.5 4.95A2.9 2.9 0 0 0 4.84 19C6.65 19.5 12 19.5 12 19.5s5.35 0 7.16-.5a2.9 2.9 0 0 0 2.04-2.05c.5-1.81.5-4.95.5-4.95s0-3.14-.5-4.95Z" fill="currentColor"/><path d="m10 15.35 5.1-3.35L10 8.65v6.7Z" fill="#fff"/></svg>`,
    Facebook:`<svg ${common}><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M13.55 20v-7h2.35l.36-2.74h-2.71V8.51c0-.79.22-1.33 1.36-1.33h1.45V4.73c-.25-.03-1.11-.1-2.12-.1-2.1 0-3.54 1.28-3.54 3.64v1.99H8.82V13h2.38v7h2.35Z" fill="#fff"/></svg>`,
    Instagram:`<svg ${common}><rect x="3.1" y="3.1" width="17.8" height="17.8" rx="5.3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.15" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.45" cy="6.65" r="1.2" fill="currentColor"/></svg>`,
    TikTok:`<svg ${common}><path d="M14.6 3.1h3.05c.27 1.72 1.23 3.02 3.05 3.55v3.07a7.3 7.3 0 0 1-3.04-.9v6.05a5.54 5.54 0 1 1-5.55-5.54c.36 0 .72.03 1.06.1v3.13a2.55 2.55 0 1 0 1.43 2.3V3.1Z" fill="currentColor"/></svg>`,
    LinkedIn:`<svg ${common}><rect x="2.7" y="2.7" width="18.6" height="18.6" rx="2.5" fill="currentColor"/><circle cx="7.2" cy="8.1" r="1.45" fill="#fff"/><path d="M5.95 10.2h2.5v7.35h-2.5V10.2Zm4.05 0h2.4v1c.75-.98 1.65-1.32 2.78-1.32 2.5 0 3.12 1.62 3.12 4.2v3.47h-2.5v-3.08c0-1.36-.05-2.47-1.5-2.47-1.52 0-1.8 1.18-1.8 2.64v2.91H10V10.2Z" fill="#fff"/></svg>`,
    X:`<svg ${common}><path d="M4.4 3.5h4.15l4.17 5.58 4.9-5.58h1.98l-5.97 6.81 6.15 8.19h-4.15l-4.55-6.08-5.34 6.08H3.76l6.4-7.31L4.4 3.5Zm3.08 1.45H6.94l9.43 12.11h.55L7.48 4.95Z" fill="currentColor"/></svg>`,
    Web:`<svg ${common}><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.4 12h17.2M12 3c2.25 2.45 3.42 5.43 3.42 9S14.25 18.55 12 21c-2.25-2.45-3.42-5.43-3.42-9S9.75 5.45 12 3Z" fill="none" stroke="currentColor" stroke-width="1.55"/></svg>`
  };
  return icons[canonicalPlatform(label)]||icons.Web;
}
function dashboardCommentLike(m){if(!isComment(m))return '';const raw=m?.raw_payload||{};const n=raw.like_count??raw.reaction_count??raw.reactions_count??0;return `<span class="dashboard-thumb-like"><span>♥</span> Şərh bəyənməsi <b>${escapeHtml(String(n))}</b></span>`;}
function cleanDashboardText(value=''){
  return String(value||'').replace(/\s+/g,' ').replace(/^\s*[0-9.,]+(?:[kmb])?\s+likes?\s*,\s*[0-9.,]+(?:[kmb])?\s+comments?\s*[-–—]\s*[^:]{1,120}\s+(?:on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*)?:\s*/i,'').trim();
}
async function renderDashboard(){
  const results=await fetchDashboardData();
  const metrics=results.metrics||{}; latest=results.latestRows||[]; notifs=results.notifRows||[];
  const items=[['Yeni qeydlər',metrics.total||0,'info'],['Yüksək risk',metrics.high||0,'danger'],['Mənfi',metrics.negative||0,'warn'],['Müsbət',metrics.positive||0,'ok']];
  document.querySelector('#metrics').innerHTML=items.map(([l,n,c])=>`<article class="card metric"><span class="badge ${c}">${escapeHtml(l)}</span><div class="num">${n}</div><div class="label">Bu gün</div></article>`).join('');
const latestEl=document.querySelector('#latest');
latestEl.innerHTML=latest?.length?latest.map(m=>{const pl=canonicalPlatform(m.source_platform);return `<article class="mention-card dashboard-mention-card${isComment(m)?' is-comment':''}" data-detail-href="./monitorinq.html?id=${encodeURIComponent(m.id)}" tabindex="0" role="link" aria-label="${escapeHtml((m.title||'Monitorinq qeydi')+' — ətraflı bax')}"><div class="mention-media-col dashboard-media-col"><span class="thumb-platform-chip ${pl.toLowerCase().replace(/[^a-z0-9]+/g,'-')}"><span class="thumb-platform-icon">${dashboardPlatformIcon(pl)}</span><span>${escapeHtml(pl)}</span></span><div class="mention-thumb-wrap"><img class="thumb" src="${mentionPreviewUrl(m)}" alt="" loading="lazy"></div>${dashboardCommentLike(m)}</div><div class="mention-copy"><h3>${escapeHtml(m.title||'Adsız qeyd')}</h3><p>${escapeHtml(cleanDashboardText(m.original_text||m.summary||''))}</p><div class="mention-meta">${isCentralScope(ctx.profile)&&(m.service_point?.short_name||m.organizations?.short_name)?`<span class="badge ok">${escapeHtml(m.service_point?.short_name||m.organizations?.short_name)}</span>`:''}${isComment(m)?'<span class="badge comment-badge">✉ Şərh</span>':''}${stateBadge(m)}<span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}%</span><span class="muted">Paylaşım: ${fmtDate(m.published_at)}</span></div></div></article>`}).join(''):'<div class="empty compact-empty">Hələ nəticə yoxdur.</div>';
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
  const {data:linked=[]}=await supabase.from('mentions').select('id,published_at,raw_payload,relevance_score,priority_score,source_status,title,summary,original_text,author_name,organizations(short_name),service_point:organization_service_points!mentions_service_point_id_fkey(short_name,name)').in('id',notifIds);
  mentionMap=new Map(linked.map(x=>[x.id,x]));
}
notifRows=notifRows.filter(x=>{if(!x.mention_id)return true;const m=mentionMap.get(x.mention_id);return Number(m?.relevance_score||0)>0&&(Number(m?.priority_score||0)>=31||Number(m?.relevance_score||0)>=31)&&!isMentionExcluded(m,results.excludes);}).sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,8);
n.innerHTML=notifRows.length?notifRows.map(x=>{const m=mentionMap.get(x.mention_id);const comment=isComment(m);const removed=String(m?.source_status||'active')==='removed';const unavailable=String(m?.source_status||'active')==='unavailable';const status=removed?`<span class="dashboard-status-chip removed">${comment?'Şərh silinib':'Material silinib'}</span>`:unavailable?'<span class="dashboard-status-chip unavailable">Əlçatan deyil</span>':'';return `<a class="dashboard-notification${comment?' is-comment':''}${removed?' is-removed':''}" href="${x.mention_id ? `./monitorinq.html?id=${x.mention_id}` : './bildirisler.html'}"><span class="notification-dot ${removed?'removed':x.kind==='critical'?'critical':'system'}"></span><span class="dashboard-notification-copy"><strong>${escapeHtml(x.title||'Bildiriş')}${comment?'<span class="dashboard-comment-chip">✉ Şərh</span>':''}${status}</strong><small>${escapeHtml(x.body||'')}</small></span><time>${fmtDate(x.created_at)}</time><span class="dashboard-notification-arrow">›</span></a>`}).join(''):'<div class="empty compact-empty">Yeni bildiriş yoxdur.</div>';

}
await renderDashboard();
if(organizationFilter) organizationFilter.onchange=renderDashboard;
if(!isCentralScope(ctx.profile)) startLiveMonitor({organizationId:ctx.profile.organization_id,onNew:()=>{ if(!document.hidden) renderDashboard(); }});
