import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader, confirmDialog, promptDialog } from './core.js';
import { resetGlobalExcludeCache, loadGlobalExcludes, isMentionExcluded } from './scope.js';

const cachedProfile=getCachedProfile(); if(cachedProfile?.system_role==='super_admin') renderShell(cachedProfile, location.hash.replace('#','')||'dashboard'); showPageLoader();
const ctx = await requireAuth({ superAdmin: true });
if (!ctx) throw new Error('auth');

let orgs = [];
let users = [];
let positions = [];
let districts = [];
let keywords = [];
let keywordStats = [];
const KEYWORD_PAGE_SIZE = 100;
let sources = [];
let sourceIndex = [];
const SOURCE_PAGE_SIZE = 100;
let auditRows = [];
let aliases = [];

const STATUS_LABELS = { active: 'Aktiv', grace: 'Möhlət', suspended: 'Dayandırılıb', archived: 'Arxiv' };
const ROLE_LABELS = { super_admin: 'Super Admin', organization_admin: 'Təşkilat admini', manager: 'Menecer', analyst: 'Analitik', viewer: 'Baxış' };

function currentView() {
  const value = location.hash.replace('#','').trim();
  return ['organizations','users','catalogs','monitoring','audit'].includes(value) ? value : 'dashboard';
}

function route() {
  const view = currentView();
  renderShell(ctx.profile, view);
  document.querySelectorAll('[data-admin-view]').forEach(el => el.classList.toggle('hidden', el.dataset.adminView !== view));
  document.querySelectorAll('.nav a,.bottom-nav a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const key = href.includes('#') ? href.split('#')[1] : 'dashboard';
    a.classList.toggle('active', key === view);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  bindRouteLinks();
  if(view==='monitoring') setTimeout(()=>renderRelevanceReview(),0);
  if(view==='dashboard') setTimeout(()=>{ renderBardaStatus(); renderNetworkRadarIdle(); },0);
}

function bindRouteLinks() {
  document.querySelectorAll('a[href^="#"],a[href*="admin.html#"]').forEach(a => {
    if (a.dataset.routeBound) return;
    a.dataset.routeBound = '1';
    a.addEventListener('click', () => setTimeout(route, 0));
  });
}

window.addEventListener('hashchange', route);
route();
hidePageLoader();

async function loadKeywordStats() {
  const target = { organization_id:null, name:'Qlobal' };
  const [positive, excluded] = await Promise.all([
    supabase.from('keywords').select('id',{count:'exact',head:true}).is('organization_id',null).eq('is_active',true).neq('kind','exclude'),
    supabase.from('keywords').select('id',{count:'exact',head:true}).is('organization_id',null).eq('is_active',true).eq('kind','exclude')
  ]);
  if (positive.error || excluded.error) toast((positive.error || excluded.error).message,'error');
  keywordStats = [{...target,positive_count:positive.count||0,excluded_count:excluded.count||0,error:positive.error||excluded.error||null}];
}

async function refresh() {
  const results = await Promise.all([
    supabase.from('organizations').select('*,districts(name)').order('created_at'),
    supabase.from('profiles').select('*,organizations(short_name),positions(name)').order('created_at',{ascending:false}),
    supabase.from('positions').select('*').order('name'),
    supabase.from('districts').select('*,villages(*)').order('name'),
    supabase.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(100),
    supabase.from('organization_aliases').select('*').order('alias')
  ]);

  const [o,u,p,d,a,al] = results;
  const fatal = results.find(r => r.error);
  if (fatal?.error) toast(fatal.error.message, 'error');

  orgs = o.data || [];
  users = u.data || [];
  positions = p.data || [];
  districts = d.data || [];
  keywords = [];
  sources = [];
  auditRows = a.data || [];
  aliases = al.data || [];

  await Promise.all([loadKeywordStats(), loadSourceIndex()]);

  renderMetrics();
  renderOrgs();
  renderUsers();
  renderCatalogs();
  renderKeywords();
  renderSources();
  renderAliases();
  if (currentView() === 'monitoring') renderRelevanceReview();
  renderAudit();
  fillSelects();
  if (currentView() === 'dashboard') renderBardaStatus();
  renderNetworkRadarIdle();
  bindDynamicActions();
}

function renderMetrics() {
  const active = orgs.filter(x => x.service_status === 'active').length;
  const suspended = orgs.filter(x => x.service_status === 'suspended').length;
  const orgUsers = users.filter(x => x.system_role !== 'super_admin').length;
  const globalSources = sourceIndex.filter(x=>x.is_active!==false).length;
  const items = [
    ['Aktiv təşkilat', active, '●', 'ok'],
    ['Dayandırılıb', suspended, 'Ⅱ', suspended ? 'danger' : 'muted'],
    ['İstifadəçilər', orgUsers, '👥', 'info'],
    ['Qlobal mənbələr', globalSources, '◎', 'gold']
  ];
  document.querySelector('#metrics').innerHTML = items.map(([label,value,icon,tone]) => `
    <article class="card metric metric-pro ${tone}">
      <div class="metric-top"><span>${escapeHtml(label)}</span><i>${icon}</i></div>
      <div class="num">${value}</div>
    </article>`).join('');
}

function statusBadge(status) {
  const tone = status === 'active' ? 'ok' : status === 'grace' ? 'warn' : 'danger';
  return `<span class="badge ${tone}">${STATUS_LABELS[status] || escapeHtml(status || '—')}</span>`;
}

function organizationTypeLabel(value='') {
  return ({district:'Rayon idarəsi',regional_unit:'Regional vahid',special_unit:'Xüsusi idarə',central_service:'Mərkəzi xidmət'})[value] || value || 'Rayon idarəsi';
}

function organizationSortKey(o={}) {
  const order = { central_service:0, regional_unit:1, district:2, special_unit:3 };
  return [order[o.organization_type] ?? 9, String(o.short_name || o.name || '')];
}

function sortedOrganizations(rows=orgs) {
  return [...rows].sort((a,b)=>{
    const ak=organizationSortKey(a), bk=organizationSortKey(b);
    return ak[0]-bk[0] || ak[1].localeCompare(bk[1],'az');
  });
}

function renderOrgs() {
  const desktop = document.querySelector('#org-body');
  const mobile = document.querySelector('#org-mobile-list');
  if (!desktop || !mobile) return;
  desktop.innerHTML = sortedOrganizations().map(o => `
    <tr>
      <td><strong>${escapeHtml(o.short_name)}</strong><br><span class="muted table-sub">${escapeHtml(o.name)}</span></td>
      <td>${escapeHtml(organizationTypeLabel(o.organization_type))}</td>
      <td>${escapeHtml(o.districts?.name || '—')}</td>
      <td>${statusBadge(o.service_status)}</td>
      <td><div class="inline-actions"><button class="btn ghost btn-sm" data-org-edit="${o.id}">Redaktə et</button><button class="btn secondary btn-sm" data-org-toggle="${o.id}">${o.service_status === 'suspended' || o.service_status === 'archived' ? 'Aktivləşdir' : 'Dayandır'}</button><button class="btn danger btn-sm" data-org-delete="${o.id}">Sil</button></div></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Təşkilat yoxdur.</td></tr>';

  mobile.innerHTML = sortedOrganizations().map(o => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(o.short_name)}</strong><small>${escapeHtml(o.name)}</small></div>${statusBadge(o.service_status)}</div>
      <div class="record-grid"><div><span>Növ</span><b>${escapeHtml(organizationTypeLabel(o.organization_type))}</b></div><div><span>Rayon</span><b>${escapeHtml(o.districts?.name || '—')}</b></div><div><span>Ad variantı</span><b>${aliases.filter(a=>a.organization_id===o.id&&a.is_active!==false).length}</b></div></div>
      <div class="record-actions org-record-actions"><button class="btn ghost" data-org-edit="${o.id}">Redaktə et</button><button class="btn secondary" data-org-toggle="${o.id}">${o.service_status === 'suspended' || o.service_status === 'archived' ? 'Aktivləşdir' : 'Dayandır'}</button><button class="btn danger" data-org-delete="${o.id}">Sil</button></div>
    </article>`).join('') || '<div class="empty">Təşkilat yoxdur.</div>';
}

function userName(u) {
  const full = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  return full || u.email || 'İstifadəçi';
}

function userScopeLabel(u) {
  return u.access_scope === 'all' ? 'Bütün sistem / Nazirlik' : (u.organizations?.short_name || 'Təşkilat seçilməyib');
}

function renderUsers() {
  const desktop = document.querySelector('#user-body');
  const mobile = document.querySelector('#user-mobile-list');
  if (!desktop || !mobile) return;
  desktop.innerHTML = users.map(u => `
    <tr>
      <td><strong>${escapeHtml(userName(u))}</strong><br><span class="muted table-sub">${escapeHtml(u.email || '')}</span></td>
      <td>${escapeHtml(userScopeLabel(u))}</td>
      <td>${escapeHtml(u.positions?.name || '—')}</td>
      <td>${escapeHtml(ROLE_LABELS[u.system_role] || u.system_role || '—')}</td>
      <td><span class="badge ${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Aktiv' : 'Deaktiv'}</span></td>
      <td>${u.system_role !== 'super_admin' ? `<div class="inline-actions"><button class="btn ghost btn-sm" data-user-edit="${u.id}">Redaktə et</button><button class="btn secondary btn-sm" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Blokla' : 'Aktiv et'}</button><button class="btn ghost btn-sm" data-reset="${u.auth_user_id}">Şifrə</button></div>` : '<span class="badge info">Qorunan hesab</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">İstifadəçi yoxdur.</td></tr>';

  mobile.innerHTML = users.map(u => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(userName(u))}</strong><small>${escapeHtml(u.email || '')}</small></div><span class="badge ${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Aktiv' : 'Deaktiv'}</span></div>
      <div class="record-grid"><div><span>Əhatə</span><b>${escapeHtml(userScopeLabel(u))}</b></div><div><span>Vəzifə</span><b>${escapeHtml(u.positions?.name || '—')}</b></div><div><span>Rol</span><b>${escapeHtml(ROLE_LABELS[u.system_role] || u.system_role || '—')}</b></div></div>
      ${u.system_role !== 'super_admin' ? `<div class="record-actions"><button class="btn ghost" data-user-edit="${u.id}">Redaktə et</button><button class="btn secondary" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Blokla' : 'Aktiv et'}</button><button class="btn ghost" data-reset="${u.auth_user_id}">Şifrə</button></div>` : '<div class="record-actions"><span class="badge info">Super Admin qorunur</span></div>'}
    </article>`).join('') || '<div class="empty">İstifadəçi yoxdur.</div>';
}

function fillSelects() {
  const orgOptions = '<option value="">Seçin</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
  const posOrg = document.querySelector('#position-org');
  if (posOrg) posOrg.innerHTML = '<option value="">Qlobal</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
  const aliasOrg = document.querySelector('#alias-org');
  if (aliasOrg) aliasOrg.innerHTML = orgOptions;
  const villageDistrict = document.querySelector('#village-district');
  if (villageDistrict) villageDistrict.innerHTML = '<option value="">Rayon seçin</option>' + districts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
}

function renderCatalogs() {
  const p = document.querySelector('#position-list');
  if (p) {
    const seen = new Set();
    const visiblePositions = positions.filter(x => { const key = String(x.name || '').trim().toLocaleLowerCase('az-AZ'); if (seen.has(key)) return false; seen.add(key); return true; });
    p.innerHTML = visiblePositions.map(x => `<span class="chip"><i></i>${escapeHtml(x.name)}</span>`).join('') || '<div class="empty compact">Vəzifə yoxdur.</div>';
  }
  const l = document.querySelector('#location-list');
  const uniqueDistricts=[...new Map(districts.map(d=>[String(d.name||'').trim().toLocaleLowerCase('az-AZ'),d])).values()];
  if (l) l.innerHTML = uniqueDistricts.map(d => `
    <details class="location-row location-group"><summary class="location-title"><strong>${escapeHtml(d.name)}</strong><span>${(d.villages || []).length} məntəqə</span></summary><div class="location-values location-values-grid">${(d.villages || []).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'az')).map(v => `<span>${escapeHtml(v.name)}</span>`).join('') || '<em>Kənd əlavə edilməyib</em>'}</div></details>`).join('') || '<div class="empty">Rayon yoxdur.</div>';
}

function keywordGroupSummary(stat, mode) {
  const count = mode === 'exclude' ? stat.excluded_count : stat.positive_count;
  if (!count) return '';
  const orgKey = stat.organization_id || '';
  const css = mode === 'exclude' ? 'keyword-group exclusion-group' : 'keyword-group positive-group';
  const label = mode === 'exclude' ? 'aktiv filtr' : 'açar söz';
  return `
    <details class="${css}" data-keyword-group="1" data-mode="${mode}" data-org-id="${escapeHtml(orgKey)}" data-total="${count}">
      <summary>
        <span><strong>${escapeHtml(stat.name)}</strong><small>${count} ${label}</small></span>
        <span class="keyword-count">${count}</span>
      </summary>
      <div class="keyword-group-body" data-keyword-body>
        <div class="empty compact">Açdıqda ilk ${Math.min(KEYWORD_PAGE_SIZE,count)} qeyd yüklənəcək.</div>
      </div>
    </details>`;
}

function renderKeywordSearchResults(target, rows, mode) {
  if (!target) return;
  if (!rows?.length) { target.innerHTML='<div class="empty compact">Uyğun söz tapılmadı.</div>'; target.classList.remove('hidden'); return; }
  target.innerHTML=rows.map(x=>`<div class="keyword-search-hit"><span>${escapeHtml(x.value)}</span><small>${mode==='exclude'?'Axtarılmamalı':'Monitorinq açar sözü'}</small></div>`).join('');
  target.classList.remove('hidden');
}

function bindKeywordSearch(inputId, resultId, mode) {
  const input=document.querySelector(inputId), result=document.querySelector(resultId);
  if(!input||!result||input.dataset.bound==='1') return;
  input.dataset.bound='1';
  let timer=null, token=0;
  input.addEventListener('input',()=>{
    clearTimeout(timer); const value=input.value.trim(); const current=++token;
    if(value.length<2){result.classList.add('hidden');result.innerHTML='';return;}
    timer=setTimeout(async()=>{
      let q=supabase.from('keywords').select('id,value,kind').is('organization_id',null).eq('is_active',true).ilike('value',`%${value.replace(/[%_]/g,'')}%`).order('value').limit(30);
      q=mode==='exclude'?q.eq('kind','exclude'):q.neq('kind','exclude');
      const {data,error}=await q; if(current!==token)return;
      if(error){result.innerHTML=`<div class="empty compact">${escapeHtml(error.message)}</div>`;result.classList.remove('hidden');return;}
      renderKeywordSearchResults(result,data||[],mode);
    },220);
  });
}

function renderKeywords() {
  const el = document.querySelector('#keyword-list');
  const excludeEl = document.querySelector('#exclude-list');
  if (!el) return;

  const positiveGroups = keywordStats.filter(x => x.positive_count > 0);
  el.innerHTML = positiveGroups.map(x => keywordGroupSummary(x,'positive')).join('') || '<div class="empty compact">Açar söz yoxdur.</div>';

  if (excludeEl) {
    const excludeGroups = keywordStats.filter(x => x.excluded_count > 0);
    excludeEl.innerHTML = excludeGroups.map(x => keywordGroupSummary(x,'exclude')).join('') || '<div class="empty compact">Axtarılmamalı söz təyin edilməyib.</div>';
  }

  document.querySelectorAll('[data-keyword-group]').forEach(group => {
    if (group.dataset.lazyBound) return;
    group.dataset.lazyBound = '1';
    group.addEventListener('toggle', () => {
      if (group.open && group.dataset.loaded !== '1') loadKeywordGroup(group, 0, false);
    });
  });
  bindKeywordSearch('#keyword-search','#keyword-search-results','positive');
  bindKeywordSearch('#exclude-search','#exclude-search-results','exclude');
}

async function loadKeywordGroup(group, offset=0, append=false) {
  const body = group.querySelector('[data-keyword-body]');
  if (!body || group.dataset.loading === '1') return;
  group.dataset.loading = '1';
  if (!append) body.innerHTML = '<div class="empty compact">Yüklənir…</div>';

  const orgId = group.dataset.orgId || '';
  const mode = group.dataset.mode || 'positive';
  let q = supabase
    .from('keywords')
    .select('id,organization_id,value,kind,is_active')
    .order('value',{ascending:true})
    .range(offset, offset + KEYWORD_PAGE_SIZE - 1);

  q = mode === 'exclude' ? q.eq('kind','exclude') : q.neq('kind','exclude');
  q = orgId ? q.eq('organization_id',orgId) : q.is('organization_id',null);

  const { data, error } = await q;
  group.dataset.loading = '0';
  if (error) {
    body.innerHTML = `<div class="empty compact">${escapeHtml(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  const html = rows.map(x => mode === 'exclude' ? `
    <div class="keyword-item exclusion-item">
      <span>${escapeHtml(x.value)}</span>
      <button class="icon-btn keyword-delete exclusion-delete" type="button" title="Filtri sil" aria-label="${escapeHtml(x.value)} filtrini sil" data-keyword-delete="${x.id}" data-keyword-delete-mode="exclude">×</button>
    </div>` : `
    <div class="keyword-item">
      <span>${escapeHtml(x.value)}</span>
      <span class="keyword-item-actions"><span class="badge info">${escapeHtml(x.kind || 'phrase')}</span><button class="icon-btn keyword-delete" type="button" title="Açar sözü sil" aria-label="${escapeHtml(x.value)} açar sözünü sil" data-keyword-delete="${x.id}" data-keyword-delete-mode="positive">×</button></span>
    </div>`).join('');

  const total = Number(group.dataset.total || 0);
  const nextOffset = offset + rows.length;
  const more = nextOffset < total ? `<button class="btn ghost btn-sm keyword-load-more" type="button" data-keyword-more="${nextOffset}">Daha ${Math.min(KEYWORD_PAGE_SIZE,total-nextOffset)} göstər</button>` : '';

  if (append) {
    body.querySelector('[data-keyword-more]')?.remove();
    body.insertAdjacentHTML('beforeend', html + more);
  } else {
    body.innerHTML = html + more || '<div class="empty compact">Qeyd yoxdur.</div>';
    group.dataset.loaded = '1';
  }

  body.querySelector('[data-keyword-more]')?.addEventListener('click', e => {
    loadKeywordGroup(group, Number(e.currentTarget.dataset.keywordMore || 0), true);
  });
  bindDynamicActions();
}

function normalizeSourcePlatform(value='') {
  const v = String(value || '').trim().toLocaleLowerCase('az-AZ');
  if (v.includes('youtube')) return 'youtube';
  if (v.includes('facebook')) return 'facebook';
  if (v.includes('instagram')) return 'instagram';
  if (v.includes('tiktok')) return 'tiktok';
  if (v.includes('linkedin') || v.includes('linked in')) return 'linkedin';
  if (v === 'x' || v.includes('twitter')) return 'x';
  if (v.includes('rss') || v.includes('web') || v.includes('google news')) return 'web';
  return v || 'digər';
}

function sourcePlatformLabel(key) {
  return ({youtube:'YouTube',facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok',linkedin:'LinkedIn',x:'X',web:'Web',digər:'Digər'})[key] || key;
}

async function loadSourceIndex() {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase.from('sources')
      .select('id,organization_id,platform,is_active')
      .order('created_at',{ascending:false})
      .range(from, from + pageSize - 1);
    if (error) { toast(error.message,'error'); break; }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  sourceIndex = rows;
}

function renderSources() {
  const el = document.querySelector('#source-list');
  if (!el) return;
  const counts = new Map();
  for (const row of sourceIndex) {
    const key = normalizeSourcePlatform(row.platform);
    counts.set(key,(counts.get(key)||0)+1);
  }
  const order = ['youtube','facebook','instagram','tiktok','linkedin','x','web','digər'];
  el.innerHTML = order.filter(key=>counts.get(key)).map(key=>`
    <details class="source-platform-group" data-source-platform-group data-platform-key="${key}" data-total="${counts.get(key)}">
      <summary><span><strong>${sourcePlatformLabel(key)}</strong><small>${counts.get(key)} qlobal mənbə</small></span><span class="badge info">${counts.get(key)}</span></summary>
      <div class="source-platform-body" data-source-platform-body><div class="empty compact">Açdıqda yüklənəcək.</div></div>
    </details>`).join('') || '<div class="empty compact">Mənbə yoxdur.</div>';

  el.querySelectorAll('[data-source-platform-group]').forEach(group => {
    group.addEventListener('toggle', () => {
      if (group.open && group.dataset.loaded !== '1') loadSourcePlatformGroup(group, 0, false);
    });
  });
}

async function loadSourcePlatformGroup(group, offset=0, append=false) {
  const body = group.querySelector('[data-source-platform-body]');
  if (!body || group.dataset.loading === '1') return;
  group.dataset.loading = '1';
  if (!append) body.innerHTML = '<div class="empty compact">Yüklənir…</div>';

  const platformKey = group.dataset.platformKey;
  const actualPlatforms = [...new Set(sourceIndex
    .filter(x => normalizeSourcePlatform(x.platform) === platformKey)
    .map(x => String(x.platform || 'Web')))].filter(Boolean);

  let q = supabase.from('sources')
    .select('id,organization_id,platform,url,is_active,created_at')
    .order('created_at',{ascending:false})
    .range(offset, offset + SOURCE_PAGE_SIZE - 1);
  if (actualPlatforms.length === 1) q = q.eq('platform', actualPlatforms[0]);
  else if (actualPlatforms.length > 1) q = q.in('platform', actualPlatforms);

  const { data, error } = await q;
  group.dataset.loading = '0';
  if (error) { body.innerHTML = `<div class="empty compact">${escapeHtml(error.message)}</div>`; return; }

  const rows = data || [];
  const html = rows.map(x => {
    const rawUrl = String(x.url || '');
    return `<div class="source-item">
      <div class="source-item-main"><a target="_blank" rel="noopener" href="${escapeHtml(rawUrl || '#')}">${escapeHtml(rawUrl || 'URL yoxdur')}</a><small>${escapeHtml(x.platform || sourcePlatformLabel(platformKey))}${x.organization_id ? ' • köhnə tenant mənbəsi, qlobal hovuzda istifadə olunur' : ' • qlobal'}</small></div>
      <span class="source-item-actions"><span class="badge source-status-badge ${x.is_active === false ? 'danger' : 'ok'}">${x.is_active === false ? 'Söndürülüb' : 'Aktiv'}</span><button class="icon-btn source-delete" type="button" title="Mənbəni sil" aria-label="Mənbəni sil" data-source-delete="${x.id}">×</button></span>
    </div>`;
  }).join('');

  const total = Number(group.dataset.total || 0);
  const nextOffset = offset + rows.length;
  const more = nextOffset < total ? `<button class="btn ghost btn-sm source-load-more" type="button" data-source-more="${nextOffset}">Daha ${Math.min(SOURCE_PAGE_SIZE,total-nextOffset)} göstər</button>` : '';
  if (append) {
    body.querySelector('[data-source-more]')?.remove();
    body.insertAdjacentHTML('beforeend', html + more);
  } else {
    body.innerHTML = html + more || '<div class="empty compact">Mənbə yoxdur.</div>';
    group.dataset.loaded = '1';
  }
  body.querySelector('[data-source-more]')?.addEventListener('click', e => loadSourcePlatformGroup(group, Number(e.currentTarget.dataset.sourceMore || 0), true));
  bindDynamicActions();
}

function renderAliases() {
  const el = document.querySelector('#alias-list');
  if (!el) return;
  const grouped = orgs.map(org=>({org,rows:aliases.filter(a=>a.organization_id===org.id&&a.is_active!==false)})).filter(x=>x.rows.length);
  el.innerHTML = grouped.map(({org,rows})=>`
    <details class="keyword-group alias-group">
      <summary><span><strong>${escapeHtml(org.short_name || org.name)}</strong><small>${rows.length} aktiv ad variantı</small></span><span class="keyword-count">${rows.length}</span></summary>
      <div class="keyword-group-body">${rows.map(a=>`<div class="keyword-item"><span>${escapeHtml(a.alias)}</span><span class="keyword-item-actions"><span class="badge info">${escapeHtml(a.alias_type || 'alias')}</span><button class="icon-btn keyword-delete" type="button" title="Ad variantını sil" data-alias-delete="${a.id}">×</button></span></div>`).join('')}</div>
    </details>`).join('') || '<div class="empty compact">Ad variantı yoxdur.</div>';
}

const REVIEW_NOISE_RULES = [
  ['haryanvi song','haryanvi song'],['dance video','dance video'],['music video','music video'],['full video','full video'],
  ['viralshort','viralshort'],['viral short','viral short'],['minivlog','minivlog'],['daily vlog','daily vlog'],['vlog','vlog'],
  ['marşrut','marşrut'],['avtobus','avtobus'],['ictimai nəqliyyat','ictimai nəqliyyat'],['metro','metro'],
  ['futbol','futbol'],['çempionat','çempionat'],['premyer liqa','premyer liqa'],['transfer','transfer'],['basketbol','basketbol'],
  ['bank','bank'],['kredit','kredit'],['valyuta','valyuta'],['birja','birja'],['sığorta','sığorta'],
  ['hava proqnozu','hava proqnozu'],['qətl','qətl'],['cinayət','cinayət'],['saxlanılıb','saxlanılıb'],['həbs','həbs'],
  ['universitet','universitet'],['imtahan','imtahan'],['konsert','konsert'],['film','film'],['serial','serial'],
  ['telefon','telefon'],['smartfon','smartfon'],['restoran','restoran'],['toy','toy'],['moda','moda']
];
const REVIEW_WATER_PHRASES = [
  'subartezian quyusu','artezian quyusu','suvarma kanalı','suvarma sistemi','suvarma suyu',
  'meliorasiya sistemi','kollektor drenaj','drenaj sistemi','nasos stansiyası','içməli su',
  'su təchizatı','su xətti','kanalizasiya xətti','tullantı su','su anbarı','suvarma mövsümü',
  'kanal təmizlənməsi','arx təmizlənməsi','su çatışmazlığı'
];
const REVIEW_WATER_RE = /(su(?:yun|yu|ya|da|dan|lar|ları|larımız|suz|lu)?|sukanal|melior|suvar|kanal|kollektor|drenaj|subartez|artezian|quyu|nasos|hidroqov|bənd|anbar|irriqasiya|içməli|kanalizasiya|tullantı su|su təchizatı)/i;
const REVIEW_PROTECTED = new Set([
  'su','kanal','rayon','rayonu','bərdə','berde','goranboy','ağdam','agdam','tərtər','terter',
  'adsea','smsii','rsmx','isst','isbtx','simdnx','sdnx','smeti','smkli','toom','meliorasiya','suvarma'
].map(x=>String(x).toLocaleLowerCase('az-AZ')));
function reviewFold(v=''){return String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKC').replace(/\s+/g,' ').trim();}
function organizationTokens(row){
  return reviewFold(row?.organizations?.short_name||'').split(/\s+/).filter(x=>x.length>=3);
}
function isProtectedReviewTerm(term,row){
  const t=reviewFold(term);
  if(!t) return true;
  if(t.split(/\s+/).length>1) return false;
  return REVIEW_PROTECTED.has(t) || organizationTokens(row).includes(t);
}
function suggestedReviewTerm(row){
  const hay=reviewFold([row?.title,row?.summary,row?.original_text].filter(Boolean).join(' '));
  const water=REVIEW_WATER_PHRASES.find(x=>hay.includes(reviewFold(x)));
  const noise=REVIEW_NOISE_RULES.find(([needle])=>hay.includes(needle));
  if(water) return water;
  if(noise) return noise[1];
  const title=reviewFold(row?.title||'').replace(/[^\p{L}\p{N}\s-]/gu,' ');
  const stop=new Set(['bakıda','baki','rayonu','rayonunda','şəhərində','şəhəri','haqqında','üçün','olan','ilə','və','bir','bu','yeni','edib','edildi','olub','var',...organizationTokens(row)]);
  const words=title.split(/\s+/).filter(x=>x.length>=5&&!stop.has(x)&&!REVIEW_WATER_RE.test(x));
  const pair=words.slice(0,2).join(' ');
  return pair || words[0] || '';
}
async function renderRelevanceReview(){
  const el=document.querySelector('#relevance-review-list');
  if(!el) return;
  el.innerHTML='<div class="empty compact">Uyğunluq namizədləri yoxlanılır…</div>';
  const excludes=await loadGlobalExcludes();
  const {data,error}=await supabase.from('mentions')
    .select('id,title,summary,original_text,raw_payload,source_platform,relevance_score,published_at,detected_at,organizations(short_name)')
    .gt('relevance_score',0).lte('relevance_score',75)
    .order('detected_at',{ascending:false}).limit(80);
  if(error){el.innerHTML=`<div class="empty compact">${escapeHtml(error.message)}</div>`;return;}
  const rows=(data||[]).filter(row=>{
    if(isMentionExcluded(row,excludes) || ['kept','ignored','auto-kept','auto-blocked','auto-ignored','auto-reviewed'].includes(String(row?.raw_payload?.admin_review_status||''))) return false;
    const kind=String(row?.raw_payload?.kind||'').toLowerCase();
    if(kind.includes('comment')){
      const ownText=reviewFold([row?.original_text,row?.summary].filter(Boolean).join(' '));
      // Aidiyyəti videonun hər ümumi rəyi admin yoxlama siyahısını doldurmasın.
      // Şərhin özündə su/meliorasiya/infrastruktur siqnalı varsa saxlanılır.
      if(!REVIEW_WATER_RE.test(ownText)) return false;
    }
    return true;
  }).slice(0,24);
  if(!rows.length){el.innerHTML='<div class="empty compact">Hazırda ayrıca yoxlanmalı material yoxdur.</div>';return;}
  el.innerHTML=rows.map(row=>{
    const term=suggestedReviewTerm(row);
    const body=row.original_text||row.summary||'Əlavə mətn yoxdur.';
    return `<details class="relevance-review-item" data-review-id="${row.id}"><summary><span class="review-title"><strong>${escapeHtml(row.title||'Adsız material')}</strong><small>${escapeHtml(row.organizations?.short_name||'Qlobal')} • ${escapeHtml(row.source_platform||'Web')} • ${Number(row.relevance_score||0)}% • ${fmtDate(row.published_at||row.detected_at)}</small></span><span class="review-chevron">⌄</span></summary><div class="review-body"><p>${escapeHtml(body)}</p><div class="review-action-row"><div class="field"><label>Təklif olunan qlobal söz / fraza</label><input class="input" data-review-term value="${escapeHtml(term)}" placeholder="Məs: subartezian quyusu"></div><div class="review-action-buttons"><button class="btn success" type="button" data-review-keep="${row.id}">Gərəkli kimi əlavə et</button><button class="btn ghost" type="button" data-review-ignore="${row.id}">Görməzdən gəl</button><button class="btn danger" type="button" data-review-block="${row.id}">Gərəksiz kimi blokla</button></div></div></div></details>`;
  }).join('');

  el.querySelectorAll('[data-review-keep]').forEach(btn=>btn.addEventListener('click',async()=>{
    const item=btn.closest('[data-review-id]');
    const row=(data||[]).find(x=>String(x.id)===String(btn.dataset.reviewKeep));
    const term=item?.querySelector('[data-review-term]')?.value?.trim()||'';
    if(term.length<3) return toast('Açar söz ən az 3 simvol olmalıdır.','error');
    if(isProtectedReviewTerm(term,row) && term.split(/\s+/).length===1) return toast('Rayon/təşkilat adını tək söz kimi əlavə etmə. Daha konkret mövzu frazası yaz.','error');
    const ok=await confirmDialog({title:'Gərəkli açar söz əlavə edilsin?',message:`“${term}” qlobal Monitorinq açar sözləri bankına əlavə ediləcək.`,confirmText:'Bəli, əlavə et',cancelText:'Xeyr'});
    if(!ok) return;
    btn.disabled=true;
    const existing=await supabase.from('keywords').select('id').is('organization_id',null).eq('kind','phrase').ilike('value',term).limit(1).maybeSingle();
    let insertError=null;
    if(!existing.data){
      const res=await supabase.from('keywords').insert({organization_id:null,value:term,kind:'phrase',is_active:true});
      insertError=res.error;
    }
    btn.disabled=false;
    if(insertError && insertError.code!=='23505') return toast(insertError.message,'error');
    const reviewPatch={...(row?.raw_payload||{}),admin_review_status:'kept',admin_review_at:new Date().toISOString(),admin_review_term:term};
    const mark=await supabase.from('mentions').update({raw_payload:reviewPatch}).eq('id',btn.dataset.reviewKeep);
    if(mark.error){btn.disabled=false;return toast(mark.error.message,'error');}
    toast(`“${term}” qlobal monitorinq açar sözlərinə əlavə edildi.`,'success');
    await loadKeywordStats(); renderKeywords(); renderRelevanceReview();
  }));


  el.querySelectorAll('[data-review-ignore]').forEach(btn=>btn.addEventListener('click',async()=>{
    const row=(data||[]).find(x=>String(x.id)===String(btn.dataset.reviewIgnore));
    btn.disabled=true;
    const reviewPatch={...(row?.raw_payload||{}),admin_review_status:'ignored',admin_review_at:new Date().toISOString()};
    const update=await supabase.from('mentions').update({raw_payload:reviewPatch}).eq('id',btn.dataset.reviewIgnore);
    btn.disabled=false;
    if(update.error) return toast(update.error.message,'error');
    toast('Material yoxlama siyahısından gizlədildi. Monitorinq nəticəsinin özü dəyişdirilmədi.','success');
    renderRelevanceReview();
  }));

  el.querySelectorAll('[data-review-block]').forEach(btn=>btn.addEventListener('click',async()=>{
    const item=btn.closest('[data-review-id]');
    const row=(data||[]).find(x=>String(x.id)===String(btn.dataset.reviewBlock));
    const term=item?.querySelector('[data-review-term]')?.value?.trim()||'';
    if(term.length<3) return toast('Filtr sözü ən az 3 simvol olmalıdır.','error');
    if(isProtectedReviewTerm(term,row)) return toast('Bu söz rayon/təşkilat/mövzu üçün qorunan sözdür. Təkcə bunu bloklamaq düzgün nəticələri də gizlədə bilər; daha konkret əlaqəsiz fraza yaz.','error');
    const ok=await confirmDialog({title:'Gərəksiz material bloklansın?',message:`“${term}” qlobal Axtarılmamalı sözlər bankına əlavə ediləcək və bu material uyğun olmayan qeyd kimi gizlədiləcək.`,confirmText:'Bəli, blokla',cancelText:'Xeyr',tone:'danger'});
    if(!ok) return;
    btn.disabled=true;
    const existing=await supabase.from('keywords').select('id').is('organization_id',null).eq('kind','exclude').ilike('value',term).limit(1).maybeSingle();
    let insertError=null;
    if(!existing.data){
      const res=await supabase.from('keywords').insert({organization_id:null,value:term,kind:'exclude',is_active:true});
      insertError=res.error;
    }
    if(insertError && insertError.code!=='23505'){btn.disabled=false;return toast(insertError.message,'error');}
    const update=await supabase.from('mentions').update({relevance_score:0}).eq('id',btn.dataset.reviewBlock);
    btn.disabled=false;
    if(update.error) return toast(update.error.message,'error');
    resetGlobalExcludeCache();
    toast(`“${term}” qlobal filtrə əlavə edildi və material bloklandı.`,'success');
    await loadKeywordStats(); renderKeywords(); renderRelevanceReview();
  }));
}

function auditActor(row) {
  const actor = users.find(u => u.id === row.actor_profile_id || u.auth_user_id === row.actor_profile_id);
  const name = actor ? userName(actor) : (row.actor_email || 'Sistem');
  const email = row.actor_email || actor?.email || '';
  return { name, email };
}

function auditTarget(row) {
  const target = users.find(u => u.id === row.entity_id || u.auth_user_id === row.entity_id);
  if (target) return `${userName(target)}${target.email ? ` • ${target.email}` : ''}`;
  const d = row.details || {};
  if (d.email) return `${d.email}${d.role ? ` • ${ROLE_LABELS[d.role] || d.role}` : ''}`;
  if (row.entity_type || row.entity_id) return `${row.entity_type || 'qeyd'}${row.entity_id ? ` • ${row.entity_id}` : ''}`;
  return '—';
}

function auditDetails(row) {
  const d = row.details && typeof row.details === 'object' ? row.details : {};
  const parts = [];
  if (d.email) parts.push(`E-mail: ${d.email}`);
  if (d.role) parts.push(`Rol: ${ROLE_LABELS[d.role] || d.role}`);
  if (d.from || d.to) parts.push(`Dəyişiklik: ${d.from || '—'} → ${d.to || '—'}`);
  if (d.status) parts.push(`Status: ${d.status}`);
  return parts.join(' • ') || 'Əlavə məlumat qeydə alınmayıb.';
}

function renderAudit() {
  const el = document.querySelector('#audit-list');
  if (!el) return;

  if (!auditRows.length) {
    el.innerHTML = '<div class="empty">Audit qeydi yoxdur.</div>';
    return;
  }

  el.innerHTML = `
    <div class="audit-table-wrap">
      <table class="audit-table">
        <thead>
          <tr>
            <th>Əməliyyat</th>
            <th>Kim</th>
            <th>Hədəf</th>
            <th>Nə vaxt</th>
          </tr>
        </thead>
        <tbody>
          ${auditRows.map(x => {
            const actor = auditActor(x);
            const actorText = actor.email && actor.email !== actor.name
              ? `${escapeHtml(actor.name)}<small>${escapeHtml(actor.email)}</small>`
              : escapeHtml(actor.name);
            return `
              <tr>
                <td>
                  <div class="audit-action-cell">
                    <span class="audit-icon">✓</span>
                    <div>
                      <strong>${escapeHtml(x.action || 'Sistem əməliyyatı')}</strong>
                      <small>${escapeHtml(auditDetails(x))}</small>
                    </div>
                  </div>
                </td>
                <td>${actorText}</td>
                <td>${escapeHtml(auditTarget(x))}</td>
                <td><time>${fmtDate(x.created_at)}</time></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function bindDynamicActions() {
  document.querySelectorAll('[data-keyword-delete]').forEach(btn=>{
    if (btn.dataset.bound) return;
    btn.dataset.bound='1';
    btn.addEventListener('click', async ()=>{
      const mode = btn.dataset.keywordDeleteMode || 'positive';
      const isExclude = mode === 'exclude';
      const question = isExclude ? 'Bu axtarılmamalı sözü filtrdən silmək istəyirsiniz?' : 'Bu monitorinq açar sözünü silmək istəyirsiniz?';
      if (!await confirmDialog({title:'Silinmə təsdiqi',message:question,confirmText:'Bəli, sil',cancelText:'Xeyr',tone:'danger'})) return;
      btn.disabled = true;
      const { error } = await supabase.from('keywords').delete().eq('id',btn.dataset.keywordDelete);
      btn.disabled = false;
      toast(error ? error.message : (isExclude ? 'Filtr silindi' : 'Açar söz silindi'), error ? 'error' : 'success');
      if (!error) await refresh();
    });
  });

  document.querySelectorAll('[data-source-delete]').forEach(btn=>{
    if (btn.dataset.bound) return;
    btn.dataset.bound='1';
    btn.addEventListener('click', async ()=>{
      if (!await confirmDialog({title:'Mənbə silinsin?',message:'Bu izlənilən mənbə qlobal mənbə hovuzundan silinəcək.',confirmText:'Bəli, sil',cancelText:'Xeyr',tone:'danger'})) return;
      btn.disabled = true;
      const { error } = await supabase.from('sources').delete().eq('id',btn.dataset.sourceDelete);
      btn.disabled = false;
      toast(error ? error.message : 'Mənbə silindi', error ? 'error' : 'success');
      if (!error) { await loadSourceIndex(); renderSources(); bindDynamicActions(); }
    });
  });

  document.querySelectorAll('[data-alias-delete]').forEach(btn=>{
    if (btn.dataset.bound) return;
    btn.dataset.bound='1';
    btn.addEventListener('click', async ()=>{
      if (!await confirmDialog({title:'Ad variantı silinsin?',message:'Seçilmiş təşkilat ad variantı reyestrdən silinəcək.',confirmText:'Bəli, sil',cancelText:'Xeyr',tone:'danger'})) return;
      btn.disabled = true;
      const { error } = await supabase.from('organization_aliases').delete().eq('id',btn.dataset.aliasDelete);
      btn.disabled = false;
      toast(error ? error.message : 'Ad variantı silindi', error ? 'error' : 'success');
      if (!error) await refresh();
    });
  });

  document.querySelectorAll('[data-org-toggle]').forEach(b => b.onclick = () => toggleOrg(b.dataset.orgToggle));
  document.querySelectorAll('[data-org-delete]').forEach(b => b.onclick = () => deleteOrganization(b.dataset.orgDelete));
  document.querySelectorAll('[data-org-edit]').forEach(b => b.onclick = () => modal('org', { organization_id:b.dataset.orgEdit }));
  document.querySelectorAll('[data-user-edit]').forEach(b => b.onclick = () => modal('user', { user_id:b.dataset.userEdit }));
  document.querySelectorAll('[data-user-toggle]').forEach(b => b.onclick = () => toggleUser(b.dataset.userToggle, b.dataset.active === 'true'));
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => resetPassword(b.dataset.reset));
  const fullRefilterBtn=document.querySelector('#full-refilter-btn');
  if(fullRefilterBtn && !fullRefilterBtn.dataset.bound){fullRefilterBtn.dataset.bound='1';fullRefilterBtn.addEventListener('click',runFullDatabaseRefilter);}
  const reviewSieveBtn=document.querySelector('#review-auto-sieve-btn');
  if(reviewSieveBtn && !reviewSieveBtn.dataset.bound){reviewSieveBtn.dataset.bound='1';reviewSieveBtn.addEventListener('click',runReviewAutoSieve);}
  const radarStart=document.querySelector('#network-radar-start');
  if(radarStart && !radarStart.dataset.bound){radarStart.dataset.bound='1';radarStart.addEventListener('click',runNetworkRadarScan);}
  const radarStop=document.querySelector('#network-radar-stop');
  if(radarStop && !radarStop.dataset.bound){radarStop.dataset.bound='1';radarStop.addEventListener('click',()=>{networkRadarStopRequested=true;});}
  document.querySelectorAll('[data-modal]').forEach(b => b.onclick = () => modal(b.dataset.modal));
}

async function toggleOrg(id) {
  const org = orgs.find(x => x.id === id);
  if (!org) return;
  const next = ['suspended','archived'].includes(org.service_status) ? 'active' : 'suspended';
  const affected = users.filter(u => u.organization_id === id && u.is_active).length;
  const msg = next === 'suspended'
    ? `${org.short_name} üzrə xidmət dayandırılsın? ${affected} aktiv istifadəçi təşkilat açılana qədər sistemə daxil ola bilməyəcək. Məlumatlar silinməyəcək.`
    : `${org.short_name} üzrə xidmət aktivləşdirilsin? Təşkilatın aktiv istifadəçiləri yenidən sistemə daxil ola biləcək.`;
  if (!await confirmDialog({title:next==='suspended'?'Xidmət dayandırılsın?':'Xidmət aktivləşdirilsin?',message:msg,confirmText:next==='suspended'?'Bəli, dayandır':'Bəli, aktivləşdir',cancelText:'Xeyr',tone:next==='suspended'?'danger':'default'})) return;
  const { error } = await supabase.from('organizations').update({ service_status: next }).eq('id', id);
  toast(error ? error.message : `Təşkilat ${next === 'active' ? 'aktivləşdirildi' : 'dayandırıldı'}`, error ? 'error' : 'success');
  if (!error) await refresh();
}

async function deleteOrganization(id) {
  const org = orgs.find(x => x.id === id);
  if (!org) return;
  const attachedUsers = users.filter(u => u.organization_id === id).length;
  const extra = attachedUsers ? ` Bu təşkilata bağlı ${attachedUsers} istifadəçi var; əvvəl onları başqa təşkilata köçürmək və ya silmək lazımdır.` : '';
  const ok = await confirmDialog({
    title:'Təşkilat birdəfəlik silinsin?',
    message:`${org.short_name} reyestrdən, ona aid monitorinq nəticələri, ad variantları və təşkilata xüsusi mənbə/açar sözlərdən birdəfəlik silinəcək. Bundan sonra worker bu təşkilatı axtarmayacaq.${extra}`,
    confirmText:'Bəli, birdəfəlik sil', cancelText:'Xeyr', tone:'danger'
  });
  if (!ok) return;
  const { data, error } = await invokeBackend('monitor-worker', { mode:'delete_organization', organization_id:id });
  if (error) return toast(error.message,'error');
  if (!data?.ok) return toast(data?.error || 'Təşkilatı silmək mümkün olmadı.','error');
  toast(`${org.short_name} və ona aid monitorinq məlumatları silindi.`,'success');
  await refresh();
}

function setSieveButtonState(btn, progress, text) {
  if(!btn) return;
  const pct=Math.max(0,Math.min(100,Number(progress||0)));
  btn.style.setProperty('--sieve-progress',`${pct}%`);
  const label=btn.querySelector('.sieve-label'); if(label && text) label.textContent=text;
}

async function runFullDatabaseRefilter() {
  const btn=document.querySelector('#full-refilter-btn');
  if(!btn || btn.disabled) return;
  const ok=await confirmDialog({
    title:'Bütün baza ələkdən keçirilsin?',
    message:'Bütün təşkilatların saxlanmış nəticələri cari Monitorinq açar sözləri və Axtarılmamalı sözlər bankı ilə yenidən yoxlanacaq. YouTube şərhlərinin öz mətni də filtrə salınacaq. Uyğunsuz qeydlər silinməyəcək, görünməz ediləcək; uyğun qeydlər saxlanacaq.',
    confirmText:'Bəli, süzgəcdən keçir',cancelText:'Xeyr'
  });
  if(!ok) return;
  btn.disabled=true; setSieveButtonState(btn,2,'Ələk hazırlanır…');
  let checked=0, filtered=0, failed=0;
  try{
    const activeOrgs=sortedOrganizations(orgs).filter(o=>o.service_status!=='archived');
    for(let i=0;i<activeOrgs.length;i++){
      const org=activeOrgs[i]; let before=null, pages=0;
      setSieveButtonState(btn,Math.max(3,Math.round((i/Math.max(1,activeOrgs.length))*100)),`Ələnir ${i+1}/${activeOrgs.length}: ${org.short_name}`);
      while(pages<30){
        const {data,error}=await invokeBackend('monitor-worker',{mode:'existing_refilter',organization_id:org.id,refilter_before:before,refilter_limit:500});
        if(error || !data?.ok){failed++;break;}
        checked+=Number(data.checked||0); filtered+=Number(data.filtered_out||0); pages++;
        if(!data.next_before || Number(data.checked||0)<500) break;
        before=data.next_before;
      }
    }
    setSieveButtonState(btn,100,'Ələk tamamlandı');
    toast(`Süzgəc tamamlandı: ${checked} qeyd yoxlandı, ${filtered} uyğunsuz qeyd gizlədildi${failed?`, ${failed} təşkilatda xəta oldu`:''}.`,failed?'error':'success');
    resetGlobalExcludeCache(); await renderRelevanceReview();
  }finally{
    setTimeout(()=>{btn.disabled=false;setSieveButtonState(btn,0,'Bütün bazanı ələkdən keçir');},900);
  }
}

async function runReviewAutoSieve(event) {
  event?.preventDefault?.(); event?.stopPropagation?.();
  const btn=document.querySelector('#review-auto-sieve-btn'); if(!btn||btn.disabled)return;
  btn.disabled=true; setSieveButtonState(btn,3,'Tövsiyələr ələnir…');
  let checked=0,filtered=0,learnedPositive=0,learnedExclude=0,failed=0;
  try{
    const activeOrgs=sortedOrganizations(orgs).filter(o=>o.service_status!=='archived');
    for(let i=0;i<activeOrgs.length;i++){
      const org=activeOrgs[i];
      setSieveButtonState(btn,Math.round(((i+1)/Math.max(1,activeOrgs.length))*100),`${i+1}/${activeOrgs.length} • ${org.short_name}`);
      const {data,error}=await invokeBackend('monitor-worker',{mode:'review_auto_sieve',organization_id:org.id,refilter_limit:800});
      if(error||!data?.ok){failed++;continue;}
      checked+=Number(data.checked||0); filtered+=Number(data.filtered_out||0);
      learnedPositive+=Number(data.positive_added||0); learnedExclude+=Number(data.exclude_added||0);
    }
    setSieveButtonState(btn,100,'Tövsiyələr təmizləndi');
    resetGlobalExcludeCache(); await refresh(); await renderRelevanceReview();
    toast(`Uyğunluq siyahısı yeniləndi: ${checked} qeyd yoxlandı, ${filtered} qeyd kənarlaşdırıldı, ${learnedPositive} yeni açar söz, ${learnedExclude} yeni filtr əlavə edildi${failed?`, ${failed} təşkilatda xəta oldu`:''}.`,failed?'error':'success');
  } finally {
    setTimeout(()=>{btn.disabled=false;setSieveButtonState(btn,0,'Tövsiyələri avtomatik ələkdən keçir');},900);
  }
}

async function toggleUser(id, active) {
  const target = users.find(x => x.id === id);
  if (!target) return;
  if (!await confirmDialog({title:active?'İstifadəçi bloklansın?':'İstifadəçi aktivləşdirilsin?',message:`${userName(target)} hesabının statusu dəyişdiriləcək.`,confirmText:active?'Bəli, blokla':'Bəli, aktivləşdir',cancelText:'Xeyr',tone:active?'danger':'default'})) return;
  const { error } = await supabase.from('profiles').update({ is_active: !active }).eq('id', id);
  toast(error ? error.message : 'İstifadəçi statusu yeniləndi', error ? 'error' : 'success');
  if (!error) await refresh();
}

async function invokeBackend(name, body) {
  const call = async (forceRefresh=false) => {
    let session=null;
    if(forceRefresh){
      const refreshed=await supabase.auth.refreshSession();
      session=refreshed?.data?.session||null;
    }else{
      const current=await supabase.auth.getSession();
      session=current?.data?.session||null;
    }
    const headers=session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{ };
    return supabase.functions.invoke(name,{body,headers});
  };
  let {data,error}=await call(false);
  const status=Number(error?.context?.status||error?.status||0);
  // Uzun admin əməliyyatlarında JWT müddəti bitə bilər. 401/403 olduqda sessiyanı
  // bir dəfə yeniləyib eyni əməliyyatı təkrar edirik; beləliklə ələk zamanı ardıcıl 403 yaranmır.
  if(error && (status===401||status===403||/jwt|unauthorized|forbidden|403|401/i.test(String(error?.message||'')))){
    const current=await supabase.auth.getSession();
    const session=current?.data?.session||null;
    if(session?.access_token){
      const retry=await supabase.functions.invoke(name,{body,headers:{Authorization:`Bearer ${session.access_token}`}});
      data=retry.data; error=retry.error;
    }
  }
  if (error) {
    const raw = `${error.message || ''} ${error.context?.status || ''}`.toLowerCase();
    if (raw.includes('404') || raw.includes('not found') || raw.includes('failed to send')) {
      return { data:null, error:new Error('Sistem xidməti hazırda əlçatan deyil. Bir neçə saniyə sonra yenidən yoxlayın.') };
    }
  }
  return { data, error };
}

async function resetPassword(authUserId) {
  const p = await promptDialog({title:'Müvəqqəti şifrə',message:'İstifadəçi üçün ən az 8 simvoldan ibarət yeni müvəqqəti şifrə təyin et.',label:'Yeni şifrə',placeholder:'Ən az 8 simvol',confirmText:'Şifrəni yenilə',type:'password'});
  if (!p) return;
  if (p.length < 8) return toast('Şifrə ən az 8 simvol olmalıdır', 'error');
  const { data, error } = await invokeBackend('admin-users', { action:'reset_password', auth_user_id:authUserId, password:p });
  toast(error ? error.message : (data?.message || 'Şifrə yeniləndi'), error ? 'error' : 'success');
}

function positionOptionsForOrg(orgId, selected='') {
  const candidates = positions.filter(p => !p.organization_id || p.organization_id === orgId);
  const byName = new Map();
  for (const p of candidates) {
    const key = String(p.name || '').trim().toLocaleLowerCase('az-AZ');
    const old = byName.get(key);
    if (!old || (p.organization_id === orgId && old.organization_id !== orgId) || p.id === selected) byName.set(key, p);
  }
  return '<option value="">Seçilməyib</option>' + [...byName.values()]
    .sort((a,b) => String(a.name).localeCompare(String(b.name), 'az'))
    .map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
}

function modal(type, preset={}) {
  if (type === 'org') {
    const editing = preset.organization_id ? orgs.find(o => o.id === preset.organization_id) : null;
    const title = editing ? 'Təşkilatı redaktə et' : 'Yeni təşkilat';
    const submitLabel = editing ? 'Dəyişiklikləri yadda saxla' : 'Təşkilat yarat';
    const typeValue = editing?.organization_type || 'district';
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="org-form" data-org-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">Təşkilat kataloqu</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Tam adı</label><input class="input" id="org-name" value="${escapeHtml(editing?.name || '')}" required></div><div class="field"><label>Qısa adı</label><input class="input" id="org-short" value="${escapeHtml(editing?.short_name || '')}" required></div><div class="field"><label>Təşkilat növü</label><select class="select" id="org-type"><option value="district" ${typeValue==='district'?'selected':''}>Rayon idarəsi</option><option value="regional_unit" ${typeValue==='regional_unit'?'selected':''}>Regional vahid</option><option value="special_unit" ${typeValue==='special_unit'?'selected':''}>Xüsusi idarə</option><option value="central_service" ${typeValue==='central_service'?'selected':''}>Mərkəzi xidmət</option></select></div><div class="field"><label>Rayon / ərazi</label><select class="select" id="org-district"><option value="">Mərkəzi / rayonsuz</option>${districts.map(d=>`<option value="${d.id}" ${editing?.district_id===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label>Xidmət statusu</label><select class="select" id="org-status"><option value="active" ${editing?.service_status==='active'?'selected':''}>Aktiv</option><option value="grace" ${editing?.service_status==='grace'?'selected':''}>Möhlət</option><option value="suspended" ${editing?.service_status==='suspended'?'selected':''}>Dayandırılıb</option><option value="archived" ${editing?.service_status==='archived'?'selected':''}>Arxiv</option></select></div><div class="field field-toggle"><label>Rayon üzrə geniş monitorinq</label><label class="switch-row"><input type="checkbox" id="org-district-wide" ${editing?.show_district_wide!==false?'checked':''}><span class="switch-ui"></span><span>Təşkilatın rayonuna aid ümumi su və meliorasiya materiallarını da göstər</span></label></div></div><div class="modal-note">Ad, qısa ad, təşkilat növü və rayon gələcək struktur dəyişikliklərində buradan yenilənə bilər. Köhnə və alternativ adlar ayrıca “Təşkilat ad variantları” bölməsində idarə olunur.</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    document.querySelector('#org-form').onsubmit = saveOrg;
  } else {
    const editing = preset.user_id ? users.find(u => u.id === preset.user_id) : null;
    if (editing?.system_role === 'super_admin') return toast('Super Admin sistem hesabı redaktə edilə bilməz.', 'error');
    const defaultScope = editing?.access_scope || preset.access_scope || 'organization';
    const defaultOrg = editing?.organization_id || preset.organization_id || orgs.find(o => String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'))?.id || '';
    const posOptions = positionOptionsForOrg(defaultOrg, editing?.position_id || preset.position_id || '');
    const title = editing ? 'İstifadəçini redaktə et' : 'Yeni istifadəçi';
    const submitLabel = editing ? 'Dəyişiklikləri yadda saxla' : 'Hesab yarat';
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="user-form" data-user-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">Giriş və məlumat əhatəsi</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Ad</label><input class="input" id="u-first" value="${escapeHtml(editing?.first_name || preset.first_name || '')}" required></div><div class="field"><label>Soyad</label><input class="input" id="u-last" value="${escapeHtml(editing?.last_name || preset.last_name || '')}" required></div><div class="field"><label>E-mail</label><input class="input" id="u-email" type="email" value="${escapeHtml(editing?.email || '')}" autocomplete="off" ${editing ? 'readonly title="E-mail təhlükəsizlik səbəbilə ayrıca dəyişdirilir"' : 'required'}></div>${editing ? '' : '<div class="field"><label>Müvəqqəti şifrə</label><input class="input" id="u-pass" type="password" minlength="8" autocomplete="new-password" required></div>'}<div class="field"><label>Məlumat əhatəsi</label><select class="select" id="u-scope"><option value="organization" ${defaultScope!=='all'?'selected':''}>Yalnız seçilən təşkilat</option><option value="all" ${defaultScope==='all'?'selected':''}>Bütün sistem / Nazirlik</option></select></div><div class="field"><label>Təşkilat</label><select class="select" id="u-org"><option value="">Mərkəzi / təşkilatsız</option>${sortedOrganizations().map(o=>`<option value="${o.id}" ${o.id===defaultOrg?'selected':''}>${escapeHtml(o.short_name)}</option>`).join('')}</select></div><div class="field"><label>Vəzifə</label><select class="select" id="u-position">${posOptions}</select></div><div class="field"><label>Sistem rolu</label><select class="select" id="u-role"><option value="organization_admin" ${(editing?.system_role || preset.system_role)==='organization_admin'?'selected':''}>Təşkilat admini</option><option value="manager" ${(editing?.system_role || preset.system_role)==='manager'?'selected':''}>Menecer</option><option value="analyst" ${(editing?.system_role || preset.system_role)==='analyst'?'selected':''}>Analitik</option><option value="viewer" ${(editing?.system_role || preset.system_role)==='viewer'?'selected':''}>Baxış</option></select></div></div><div class="modal-note">“Bütün sistem / Nazirlik” seçildikdə istifadəçi bütün təşkilatların nəticələrini görür və təşkilat filtrindən istifadə edir. “Yalnız seçilən təşkilat” seçildikdə profilə bağlanan idarənin məlumatları avtomatik göstərilir.</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    const orgSelect = document.querySelector('#u-org');
    const scopeSelect = document.querySelector('#u-scope');
    const positionSelect = document.querySelector('#u-position');
    const syncScope = () => {
      const central = scopeSelect.value === 'all';
      orgSelect.disabled = central;
      if (central) {
        orgSelect.value = '';
        positionSelect.innerHTML = positionOptionsForOrg('');
      } else {
        if (!orgSelect.value && defaultOrg) orgSelect.value = defaultOrg;
        positionSelect.innerHTML = positionOptionsForOrg(orgSelect.value, editing?.position_id || '');
      }
    };
    orgSelect.onchange = () => { positionSelect.innerHTML = positionOptionsForOrg(orgSelect.value); };
    scopeSelect.onchange = syncScope;
    syncScope();
    document.querySelector('#user-form').onsubmit = editing ? updateUser : createUser;
  }
  document.querySelector('#close-modal').onclick = closeModal;
  document.querySelector('#cancel-modal').onclick = closeModal;
  document.querySelector('#modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };
}

function closeModal() { document.querySelector('#modal-root').innerHTML = ''; }

async function saveOrg(e) {
  e.preventDefault();
  const orgId = e.currentTarget.dataset.orgId || '';
  const row = {
    name: document.querySelector('#org-name').value.trim(),
    short_name: document.querySelector('#org-short').value.trim(),
    district_id: document.querySelector('#org-district').value || null,
    organization_type: document.querySelector('#org-type').value,
    service_status: document.querySelector('#org-status').value,
    show_district_wide: document.querySelector('#org-district-wide')?.checked !== false
  };
  const query = orgId ? supabase.from('organizations').update(row).eq('id', orgId) : supabase.from('organizations').insert(row);
  const { error } = await query;
  toast(error ? error.message : (orgId ? 'Təşkilat məlumatları yeniləndi' : 'Təşkilat yaradıldı'), error ? 'error' : 'success');
  if (!error) { closeModal(); await refresh(); location.hash = 'organizations'; route(); }
}

async function updateUser(e) {
  e.preventDefault();
  const id = e.currentTarget.dataset.userId;
  const target = users.find(u => u.id === id);
  if (!target || target.system_role === 'super_admin') return toast('Super Admin sistem hesabı dəyişdirilə bilməz.', 'error');
  const access_scope = document.querySelector('#u-scope').value;
  const organization_id = access_scope === 'all' ? null : (document.querySelector('#u-org').value || null);
  if (access_scope !== 'all' && !organization_id) return toast('Təşkilat səviyyəli istifadəçi üçün təşkilat seçilməlidir.', 'error');
  const row = {
    first_name:document.querySelector('#u-first').value.trim(),
    last_name:document.querySelector('#u-last').value.trim(),
    access_scope,
    organization_id,
    position_id:document.querySelector('#u-position').value || null,
    system_role:document.querySelector('#u-role').value
  };
  const { error } = await supabase.from('profiles').update(row).eq('id', id).neq('system_role', 'super_admin');
  toast(error ? error.message : 'İstifadəçi məlumatları yeniləndi', error ? 'error' : 'success');
  if (!error) { closeModal(); await refresh(); location.hash = 'users'; route(); }
}

async function createUser(e) {
  e.preventDefault();
  const access_scope = document.querySelector('#u-scope').value;
  const organization_id = access_scope === 'all' ? null : (document.querySelector('#u-org').value || null);
  if (access_scope !== 'all' && !organization_id) return toast('Təşkilat səviyyəli istifadəçi üçün təşkilat seçilməlidir.', 'error');
  const body = {
    action:'create',
    email:document.querySelector('#u-email').value.trim(),
    password:document.querySelector('#u-pass').value,
    first_name:document.querySelector('#u-first').value.trim(),
    last_name:document.querySelector('#u-last').value.trim(),
    access_scope,
    organization_id,
    position_id:document.querySelector('#u-position').value || null,
    system_role:document.querySelector('#u-role').value
  };
  const { data, error } = await invokeBackend('admin-users', body);
  const message = error ? error.message : (data?.error || data?.message || 'İstifadəçi yaradıldı');
  toast(message, error || data?.ok === false ? 'error' : 'success');
  if (!error && data?.ok !== false) { closeModal(); await refresh(); location.hash = 'users'; route(); }
}

async function insertMissing(table, existingRows, rows, match) {
  const missing = rows.filter(row => !existingRows.some(old => match(old,row)));
  if (!missing.length) return { count:0, error:null };
  const { error } = await supabase.from(table).insert(missing);
  return { count: error ? 0 : missing.length, error };
}

async function loadOrganizationKeywordValues(organizationId) {
  const values = [];
  const pageSize = 1000;
  for (let from = 0; from < 12000; from += pageSize) {
    const { data, error } = await supabase
      .from('keywords')
      .select('value,kind')
      .eq('organization_id', organizationId)
      .neq('kind', 'exclude')
      .order('created_at', { ascending:true })
      .range(from, from + pageSize - 1);
    if (error) return { values:[], error };
    const batch = data || [];
    values.push(...batch.map(x => String(x.value || '')));
    if (batch.length < pageSize) break;
  }
  return { values, error:null };
}

async function configureBarda() {
  const org = orgs.find(o => String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  const district = districts.find(d => String(d.name||'').toLocaleLowerCase('az-AZ') === 'bərdə');
  if (!org || !district) return toast('Bərdə SMSİİ təşkilatı və Bərdə rayonu tapılmalıdır.', 'error');

  const desiredPositions = ['İdarə rəisi','İdarə rəisinin müavini','Baş mühəndis','Mətbuat üzrə məsul şəxs','Operator'];
  const desiredAliases = [
    ['Bərdə SMSİİ','short'],['Bərdə SMSII','ascii_short'],['Berde SMSII','ascii_short'],
    ['Bərdə Su Meliorasiya Sistemlərinin İstismarı İdarəsi','current'],
    ['Bərdə Suvarma Sistemlərinin İstismarı İdarəsi','legacy'],
    ['Bərdə Suvarma Sistemləri İdarəsi','legacy'],['Bərdə Suvarma İdarəsi','legacy'],
    ['Bərdə Subartezian Quyularının İstismarı İdarəsi','legacy']
  ];
  let changed = 0;
  const orgPatch = { district_id:district.id, organization_type:'district', service_status:'active' };
  const { error:orgError } = await supabase.from('organizations').update(orgPatch).eq('id',org.id);
  if (orgError) return toast(orgError.message,'error');

  const pRes = await insertMissing('positions', positions, desiredPositions.map(name=>({name,organization_id:org.id})), (a,b)=>a.name===b.name && (a.organization_id===b.organization_id || !a.organization_id));
  if (pRes.error) return toast(pRes.error.message,'error');
  changed += pRes.count;

  const existing = new Set(aliases.filter(a=>a.organization_id===org.id).map(a=>String(a.alias||'').trim().toLocaleLowerCase('az-AZ')));
  for (const [alias,alias_type] of desiredAliases) {
    if (existing.has(alias.toLocaleLowerCase('az-AZ'))) continue;
    const { error } = await supabase.from('organization_aliases').insert({organization_id:org.id,alias,alias_type,is_active:true});
    if (error && error.code !== '23505') return toast(error.message,'error');
    if (!error) changed++;
  }
  toast(changed ? `Bərdə SMSİİ qlobal monitorinq üçün hazırlandı: ${changed} yeni qeyd.` : 'Bərdə SMSİİ qlobal monitorinq üçün artıq hazırdır.', 'success');
  await refresh();
}

async function renderBardaStatus() {
  const el = document.querySelector('#barda-status');
  const globalEl = document.querySelector('#global-status');
  if (!el && !globalEl) return;
  const globalStats = keywordStats[0] || {positive_count:0,excluded_count:0};
  const activeOrgs=orgs.filter(o=>o.service_status==='active').length;
  const archivedOrgs=orgs.filter(o=>o.service_status==='archived').length;
  const activeSources=sourceIndex.filter(s=>s.is_active!==false).length;
  if(globalEl) globalEl.innerHTML=[
    `<span class="badge ok">${activeOrgs} aktiv təşkilat</span>`,
    `<span class="badge info">${archivedOrgs} arxiv təşkilat</span>`,
    `<span class="badge info">${activeSources} qlobal mənbə</span>`,
    `<span class="badge info">${globalStats.positive_count} açar söz</span>`,
    `<span class="badge warn">${globalStats.excluded_count} filtr</span>`
  ].join(' ');
  const org = orgs.find(o => String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  if (!org) { el.innerHTML = '<span class="badge danger">Bərdə SMSİİ tapılmadı</span>'; return; }
  const hasDirector = positions.some(p => p.name === 'İdarə rəisi' && (!p.organization_id || p.organization_id === org.id));
  const webSources = sourceIndex.filter(s => ['web','rss'].some(kind=>String(s.platform||'').toLowerCase().includes(kind)) && s.is_active !== false);
  const bits = [
    statusBadge(org.service_status),
    hasDirector ? '<span class="badge ok">Vəzifələr hazırdır</span>' : '<span class="badge warn">Vəzifə tamamlanmalıdır</span>',
    webSources.length ? `<span class="badge ok">Qlobal Web mənbələri (${webSources.length})</span>` : '<span class="badge warn">Qlobal Web mənbəsi əlavə edilməlidir</span>',
    `<span class="badge info">Qlobal söz bankı: ${globalStats.positive_count} / filtr ${globalStats.excluded_count}</span>`,
    webSources.length ? '<span class="badge info">RSS avtomatik aşkarlanır</span>' : ''
  ].filter(Boolean);
  el.innerHTML = bits.join(' ');

  const recentCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const [web, youtube, latest, recentWeb, oldestWeb] = await Promise.all([
    supabase.from('mentions').select('id',{count:'exact',head:true}).eq('organization_id',org.id).in('source_platform',['Web','Google News']).gt('relevance_score',0),
    supabase.from('mentions').select('id',{count:'exact',head:true}).eq('organization_id',org.id).ilike('source_platform','youtube').gt('relevance_score',0),
    supabase.from('mentions').select('detected_at').eq('organization_id',org.id).gt('relevance_score',0).order('detected_at',{ascending:false}).limit(1).maybeSingle(),
    supabase.from('mentions').select('id',{count:'exact',head:true}).eq('organization_id',org.id).in('source_platform',['Web','Google News']).gt('relevance_score',0).gte('published_at',recentCutoff),
    supabase.from('mentions').select('published_at').eq('organization_id',org.id).in('source_platform',['Web','Google News']).gt('relevance_score',0).not('published_at','is',null).order('published_at',{ascending:true}).limit(1).maybeSingle()
  ]);
  if (!web.error && !youtube.error) {
    const last = latest?.data?.detected_at ? fmtDate(latest.data.detected_at) : '—';
    const totalWeb = Number(web.count || 0);
    const currentWeb = recentWeb?.error ? 0 : Number(recentWeb.count || 0);
    const archiveWeb = Math.max(0, totalWeb - currentWeb);
    const oldest = oldestWeb?.data?.published_at ? fmtDate(oldestWeb.data.published_at) : '—';
    const currentYear = new Date().getFullYear();
    el.insertAdjacentHTML('beforeend', `<span class="badge info">Bərdə nəticəsi: Web ${totalWeb} / YouTube ${youtube.count||0}</span><span class="badge info">Web arxiv: ${archiveWeb} / son 90 gün: ${currentWeb}</span><span class="badge info">Ən köhnə Web: ${escapeHtml(oldest)}</span><span class="badge info">Son yeni nəticə: ${escapeHtml(last)}</span><span class="badge ok">Əsas Web backfill: 2020–${currentYear}</span><span class="badge ok">Tarixi arxiv: 2000–2019</span>`);
  }
}



let networkRadarStopRequested=false;
let networkRadarRunning=false;
let networkRadarStartedAt=0;
let networkRadarTimer=null;

function radarTime(ms){
  const total=Math.max(0,Math.floor(ms/1000));
  const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;
  return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function renderNetworkRadarIdle(){
  const total=document.querySelector('#radar-org-total');
  if(total) total.textContent=String(sortedOrganizations(orgs).filter(o=>['active','grace'].includes(o.service_status)).length);
}
function radarSetProgress(done,total,found,current='',source=''){
  const pct=total?Math.min(100,Math.round(done/total*100)):0;
  const set=(id,v)=>{const e=document.querySelector(id);if(e)e.textContent=String(v)};
  set('#radar-percent',`${pct}%`);set('#radar-org-done',done);set('#radar-org-total',total);set('#radar-found',found);
  if(current)set('#radar-current-org',current); if(source)set('#radar-current-source',source);
  const state=document.querySelector('#radar-state');if(state)state.textContent=networkRadarRunning?'Skan edilir':(pct===100?'Tamamlandı':'Hazır');
}
function radarAddBlip(name,index,total,tone='ok'){
  const box=document.querySelector('#radar-blips');if(!box)return;
  const angle=((index*137.5)%360)*Math.PI/180;
  const radius=18+((index*29)%30);
  const x=50+Math.cos(angle)*radius,y=50+Math.sin(angle)*radius;
  const dot=document.createElement('span');dot.className=`radar-blip ${tone}`;dot.style.left=`${x}%`;dot.style.top=`${y}%`;dot.innerHTML=`<i></i><small>${escapeHtml(name)}</small>`;box.appendChild(dot);
  while(box.children.length>22)box.firstElementChild?.remove();
}
function radarFeed(name,data,error){
  const feed=document.querySelector('#radar-feed');if(!feed)return;
  if(feed.querySelector('.empty'))feed.innerHTML='';
  const details=Array.isArray(data?.details)?data.details:[];
  const inserted=Number(data?.new_mentions ?? data?.inserted ?? details.reduce((n,d)=>n+Number(d?.inserted||0),0));
  const found=details.reduce((n,d)=>n+Number(d?.videos_found||d?.found||d?.comments_accepted||0),0);
  const row=document.createElement('div');row.className=`radar-feed-row ${error?'error':inserted?'hit':''}`;
  row.innerHTML=`<span>${error?'×':inserted?'●':'○'}</span><div><strong>${escapeHtml(name)}</strong><small>${error?escapeHtml(error.message||String(error)):`Yoxlanıldı: ${found} • Yeni: ${inserted}`}</small></div><b>${inserted}</b>`;
  feed.prepend(row);while(feed.children.length>40)feed.lastElementChild?.remove();
  return inserted;
}
async function runNetworkRadarScan(){
  if(networkRadarRunning)return;
  const active=sortedOrganizations(orgs).filter(o=>['active','grace'].includes(o.service_status));
  if(!active.length)return toast('Skan ediləcək aktiv təşkilat yoxdur.','error');
  const ok=await confirmDialog({title:'Tam şəbəkə skanı başlasın?',message:`${active.length} aktiv təşkilat növbə ilə YouTube və Web/RSS/q xəbər mənbələrində dərin yoxlanacaq. Bu proses uzun çəkə bilər; admin səhifəsini açıq saxla. Tapılan real nəticələr dərhal uyğun təşkilata yazılacaq.`,confirmText:'Bəli, skanı başlat',cancelText:'Xeyr'});
  if(!ok)return;
  networkRadarRunning=true;networkRadarStopRequested=false;networkRadarStartedAt=Date.now();
  const card=document.querySelector('#network-radar-card'),start=document.querySelector('#network-radar-start'),stop=document.querySelector('#network-radar-stop'),visual=document.querySelector('#radar-visual'),feed=document.querySelector('#radar-feed');
  card?.classList.add('is-scanning');visual?.classList.add('is-scanning');if(start)start.disabled=true;stop?.classList.remove('hidden');if(feed)feed.innerHTML='';
  let done=0,foundTotal=0;
  networkRadarTimer=setInterval(()=>{const e=document.querySelector('#radar-elapsed');if(e)e.textContent=radarTime(Date.now()-networkRadarStartedAt)},1000);
  try{
    for(let i=0;i<active.length;i++){
      if(networkRadarStopRequested)break;
      const org=active[i];radarSetProgress(done,active.length,foundTotal,org.short_name,'YouTube + Web/RSS + qlobal xəbər mənbələri yoxlanır…');
      const {data,error}=await invokeBackend('monitor-worker',{organization_id:org.id,mode:'scheduled',force_youtube:true,youtube_query_limit:4,edge_news_probe:true,refilter_existing:true,verify_existing:true,debug:false});
      const added=radarFeed(org.short_name,data,error);foundTotal+=Number(added||0);done++;
      radarAddBlip(org.short_name,i,active.length,error?'error':added?'hit':'ok');radarSetProgress(done,active.length,foundTotal,org.short_name,error?'Xəta oldu, növbəti təşkilata keçilir':`Tamamlandı • yeni ${Number(added||0)}`);
      await new Promise(r=>setTimeout(r,350));
    }
  }finally{
    networkRadarRunning=false;clearInterval(networkRadarTimer);networkRadarTimer=null;card?.classList.remove('is-scanning');visual?.classList.remove('is-scanning');if(start)start.disabled=false;stop?.classList.add('hidden');
    const elapsed=document.querySelector('#radar-elapsed');if(elapsed)elapsed.textContent=radarTime(Date.now()-networkRadarStartedAt);
    const state=document.querySelector('#radar-state');if(state)state.textContent=networkRadarStopRequested?'Dayandırıldı':'Tamamlandı';
    const current=document.querySelector('#radar-current-source');if(current)current.textContent=networkRadarStopRequested?'Skan istifadəçi tərəfindən dayandırıldı.':'Dərin skan tamamlandı. Worker növbəti avtomatik run-larda nəticələri yeniləməyə davam edəcək.';
    toast(networkRadarStopRequested?`Skan dayandırıldı. ${done}/${active.length} təşkilat yoxlanıldı.`:`Şəbəkə skanı tamamlandı. ${done} təşkilat yoxlanıldı, ${foundTotal} yeni nəticə yazıldı.`,networkRadarStopRequested?'info':'success');
  }
}

async function runMonitorNow() {
  const btn = document.querySelector('#run-monitor');
  if (!btn) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Monitorinq işləyir…';
  const bardaOrg=orgs.find(o=>String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  const cleanup = await invokeBackend('monitor-worker', { organization_id:bardaOrg?.id||null, mode:'existing_refilter' });
  if (cleanup.error || cleanup.data?.ok === false) {
    btn.disabled = false; btn.textContent = old;
    return toast(cleanup.error?.message || cleanup.data?.error || 'Mövcud nəticələrin filtr yoxlaması işə salınmadı', 'error');
  }
  const { data, error } = await invokeBackend('monitor-worker', { organization_id:bardaOrg?.id||null, mode:'scheduled', quick_youtube_comments:true, browser_quick:true, refilter_existing:false, verify_existing:false, youtube_query_limit:1 });
  btn.disabled = false;
  btn.textContent = old;
  if (error || data?.ok === false) return toast(error?.message || data?.error || 'Monitorinq işə salınmadı', 'error');
  toast(`Sürətli yoxlama tamamlandı. Köhnə nəticələr yenidən süzüldü, ${data?.new_mentions || 0} yeni nəticə tapıldı.`, 'success');
  await renderBardaStatus();
}

document.querySelector('#position-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('positions').insert({name:document.querySelector('#position-name').value.trim(),organization_id:document.querySelector('#position-org').value||null}); toast(error?error.message:'Vəzifə əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#district-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('districts').insert({name:document.querySelector('#district-name').value.trim()}); toast(error?error.message:'Rayon əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#village-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('villages').insert({district_id:document.querySelector('#village-district').value,name:document.querySelector('#village-name').value.trim()}); toast(error?error.message:'Kənd əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#keyword-form').onsubmit = async e => {
  e.preventDefault();
  const value=document.querySelector('#keyword-value').value.trim();
  if (!value) return;
  const existing=await supabase.from('keywords').select('id').is('organization_id',null).neq('kind','exclude').ilike('value',value).limit(1).maybeSingle();
  if(existing?.data?.id) return toast('Bu qlobal açar söz artıq mövcuddur.','info');
  const { error } = await supabase.from('keywords').insert({organization_id:null,value,kind:'phrase',is_active:true});
  toast(error?.code==='23505'?'Bu qlobal açar söz artıq mövcuddur.':(error?.message||'Qlobal açar söz əlavə edildi'),error?'error':'success');
  if(!error){e.target.reset();await refresh();}
};
document.querySelector('#exclude-form').onsubmit = async e => {
  e.preventDefault();
  const value = document.querySelector('#exclude-value').value.trim();
  if (!value) return;
  const existing=await supabase.from('keywords').select('id').is('organization_id',null).eq('kind','exclude').ilike('value',value).limit(1).maybeSingle();
  if(existing?.data?.id) return toast('Bu qlobal filtr artıq mövcuddur.','info');
  const { error } = await supabase.from('keywords').insert({organization_id:null,value,kind:'exclude',is_active:true});
  toast(error?.code==='23505'?'Bu qlobal filtr artıq mövcuddur.':(error?.message||'Qlobal axtarılmamalı söz əlavə edildi'), error ? 'error' : 'success');
  if (!error) { resetGlobalExcludeCache(); e.target.reset(); await refresh(); toast('Filtr görünüşlərdə dərhal tətbiq olunur; bazadakı köhnə qeydlər növbəti worker yoxlamasında təsdiqlənəcək.','success'); }
};
document.querySelector('#source-form').onsubmit = async e => {
  e.preventDefault();
  const platform = document.querySelector('#source-platform').value.trim();
  const url = document.querySelector('#source-url').value.trim();
  const googleNews = url.includes('news.google.com/rss/');
  const urlNoSlash = url.replace(/\/+$/,'');
  let duplicateQuery = supabase.from('sources').select('id',{count:'exact',head:true});
  duplicateQuery = googleNews ? duplicateQuery.ilike('url','%news.google.com/rss/%') : duplicateQuery.in('url',[urlNoSlash,`${urlNoSlash}/`]);
  const duplicateResult = await duplicateQuery;
  if (duplicateResult.error) return toast(duplicateResult.error.message,'error');
  if ((duplicateResult.count || 0) > 0) return toast(googleNews ? 'Qlobal Google News RSS artıq mövcuddur.' : 'Bu qlobal mənbə artıq mövcuddur.', 'error');
  const { error } = await supabase.from('sources').insert({organization_id:null,platform,url,is_active:true});
  toast(error ? error.message : 'Qlobal mənbə əlavə edildi',error?'error':'success');
  if(!error){e.target.reset();await refresh();}
};
document.querySelector('#alias-form').onsubmit = async e => {
  e.preventDefault();
  const organization_id=document.querySelector('#alias-org').value;
  const alias=document.querySelector('#alias-value').value.trim();
  const alias_type=document.querySelector('#alias-type').value;
  if(!organization_id||!alias) return;
  const {error}=await supabase.from('organization_aliases').insert({organization_id,alias,alias_type,is_active:true});
  toast(error?.code==='23505'?'Bu ad variantı artıq mövcuddur.':(error?.message||'Ad variantı əlavə edildi'),error?'error':'success');
  if(!error){e.target.reset();await refresh();}
};

document.querySelector('#configure-barda').onclick = configureBarda;
document.querySelector('#run-monitor').onclick = runMonitorNow;

await refresh();
route();
