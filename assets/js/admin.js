import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, money, toast, getCachedProfile, showPageLoader, hidePageLoader } from './core.js';

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

const STATUS_LABELS = { active: 'Aktiv', grace: 'Möhlət', suspended: 'Dayandırılıb', archived: 'Arxiv' };
const ROLE_LABELS = { super_admin: 'Super Admin', organization_admin: 'Təşkilat admini', manager: 'Menecer', analyst: 'Analitik', viewer: 'Baxış' };

function currentView() {
  const value = location.hash.replace('#','').trim();
  return ['organizations','users','catalogs','monitoring','billing','audit'].includes(value) ? value : 'dashboard';
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
  const targets = [
    ...orgs.map(o => ({ organization_id:o.id, name:o.short_name || o.name || 'Təşkilat' })),
    { organization_id:null, name:'Qlobal' }
  ];

  const jobs = [];
  for (const target of targets) {
    let positive = supabase.from('keywords').select('id', { count:'exact', head:true }).neq('kind','exclude');
    let excluded = supabase.from('keywords').select('id', { count:'exact', head:true }).eq('kind','exclude');
    if (target.organization_id) {
      positive = positive.eq('organization_id', target.organization_id);
      excluded = excluded.eq('organization_id', target.organization_id);
    } else {
      positive = positive.is('organization_id', null);
      excluded = excluded.is('organization_id', null);
    }
    jobs.push(Promise.all([positive, excluded]).then(([p,e]) => ({
      ...target,
      positive_count: p.error ? 0 : (p.count || 0),
      excluded_count: e.error ? 0 : (e.count || 0),
      error: p.error || e.error || null
    })));
  }

  const rows = await Promise.all(jobs);
  const firstError = rows.find(x => x.error)?.error;
  if (firstError) toast(firstError.message, 'error');
  keywordStats = rows;
}

async function refresh() {
  const results = await Promise.all([
    supabase.from('organizations').select('*,districts(name)').order('created_at'),
    supabase.from('profiles').select('*,organizations(short_name),positions(name)').order('created_at',{ascending:false}),
    supabase.from('positions').select('*').order('name'),
    supabase.from('districts').select('*,villages(*)').order('name'),
    supabase.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(100)
  ]);

  const [o,u,p,d,a] = results;
  const fatal = results.find(r => r.error);
  if (fatal?.error) toast(fatal.error.message, 'error');

  orgs = o.data || [];
  users = u.data || [];
  positions = p.data || [];
  districts = d.data || [];
  keywords = []; // Minlərlə açar sözü səhifə açılan kimi RAM-a yükləmirik.
  sources = [];
  auditRows = a.data || [];

  await Promise.all([loadKeywordStats(), loadSourceIndex()]);

  renderMetrics();
  renderOrgs();
  renderUsers();
  renderCatalogs();
  renderKeywords();
  renderSources();
  renderBilling();
  renderAudit();
  fillSelects();
  renderBardaStatus();
  bindDynamicActions();
}

function renderMetrics() {
  const active = orgs.filter(x => x.service_status === 'active').length;
  const suspended = orgs.filter(x => x.service_status === 'suspended').length;
  const orgUsers = users.filter(x => x.system_role !== 'super_admin').length;
  const portfolio = orgs.reduce((sum,x)=>sum+Number(x.monthly_price||0),0);
  const items = [
    ['Aktiv təşkilat', active, '●', 'ok'],
    ['Dayandırılıb', suspended, 'Ⅱ', suspended ? 'danger' : 'muted'],
    ['İstifadəçilər', orgUsers, '👥', 'info'],
    ['Aylıq portfel', money(portfolio), '₼', 'gold']
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

function renderOrgs() {
  const desktop = document.querySelector('#org-body');
  const mobile = document.querySelector('#org-mobile-list');
  if (!desktop || !mobile) return;
  desktop.innerHTML = orgs.map(o => `
    <tr>
      <td><strong>${escapeHtml(o.short_name)}</strong><br><span class="muted table-sub">${escapeHtml(o.name)}</span></td>
      <td>${escapeHtml(o.districts?.name || '—')}</td>
      <td>${statusBadge(o.service_status)}</td>
      <td>${money(o.monthly_price)}</td>
      <td>${o.next_payment_at ? fmtDate(o.next_payment_at) : '—'}</td>
      <td><div class="inline-actions"><button class="btn ghost btn-sm" data-org-edit="${o.id}">Redaktə et</button><button class="btn secondary btn-sm" data-org-toggle="${o.id}">${o.service_status === 'suspended' ? 'Aktivləşdir' : 'Dayandır'}</button></div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">Təşkilat yoxdur.</td></tr>';

  mobile.innerHTML = orgs.map(o => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(o.short_name)}</strong><small>${escapeHtml(o.name)}</small></div>${statusBadge(o.service_status)}</div>
      <div class="record-grid"><div><span>Rayon</span><b>${escapeHtml(o.districts?.name || '—')}</b></div><div><span>Aylıq</span><b>${money(o.monthly_price)}</b></div><div><span>Növbəti ödəniş</span><b>${o.next_payment_at ? fmtDate(o.next_payment_at) : '—'}</b></div></div>
      <div class="record-actions two"><button class="btn ghost" data-org-edit="${o.id}">Redaktə et</button><button class="btn secondary" data-org-toggle="${o.id}">${o.service_status === 'suspended' ? 'Xidməti aktivləşdir' : 'Xidməti dayandır'}</button></div>
    </article>`).join('') || '<div class="empty">Təşkilat yoxdur.</div>';
}

function userName(u) {
  const full = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  return full || u.email || 'İstifadəçi';
}

function renderUsers() {
  const desktop = document.querySelector('#user-body');
  const mobile = document.querySelector('#user-mobile-list');
  if (!desktop || !mobile) return;
  desktop.innerHTML = users.map(u => `
    <tr>
      <td><strong>${escapeHtml(userName(u))}</strong><br><span class="muted table-sub">${escapeHtml(u.email || '')}</span></td>
      <td>${escapeHtml(u.organizations?.short_name || 'Sistem')}</td>
      <td>${escapeHtml(u.positions?.name || '—')}</td>
      <td>${escapeHtml(ROLE_LABELS[u.system_role] || u.system_role || '—')}</td>
      <td><span class="badge ${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Aktiv' : 'Deaktiv'}</span></td>
      <td>${u.system_role !== 'super_admin' ? `<div class="inline-actions"><button class="btn ghost btn-sm" data-user-edit="${u.id}">Redaktə et</button><button class="btn secondary btn-sm" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Blokla' : 'Aktiv et'}</button><button class="btn ghost btn-sm" data-reset="${u.auth_user_id}">Şifrə</button></div>` : '<span class="badge info">Qorunan hesab</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">İstifadəçi yoxdur.</td></tr>';

  mobile.innerHTML = users.map(u => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(userName(u))}</strong><small>${escapeHtml(u.email || '')}</small></div><span class="badge ${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Aktiv' : 'Deaktiv'}</span></div>
      <div class="record-grid"><div><span>Təşkilat</span><b>${escapeHtml(u.organizations?.short_name || 'Sistem')}</b></div><div><span>Vəzifə</span><b>${escapeHtml(u.positions?.name || '—')}</b></div><div><span>Rol</span><b>${escapeHtml(ROLE_LABELS[u.system_role] || u.system_role || '—')}</b></div></div>
      ${u.system_role !== 'super_admin' ? `<div class="record-actions"><button class="btn ghost" data-user-edit="${u.id}">Redaktə et</button><button class="btn secondary" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Blokla' : 'Aktiv et'}</button><button class="btn ghost" data-reset="${u.auth_user_id}">Şifrə</button></div>` : '<div class="record-actions"><span class="badge info">Super Admin qorunur</span></div>'}
    </article>`).join('') || '<div class="empty">İstifadəçi yoxdur.</div>';
}

function fillSelects() {
  const orgOptions = '<option value="">Seçin</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
  ['#keyword-org','#exclude-org','#source-org'].forEach(sel => { const el = document.querySelector(sel); if (el) el.innerHTML = orgOptions; });
  const posOrg = document.querySelector('#position-org');
  if (posOrg) posOrg.innerHTML = '<option value="">Qlobal</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
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
  if (l) l.innerHTML = districts.map(d => `
    <details class="location-row location-group"><summary class="location-title"><strong>${escapeHtml(d.name)}</strong><span>${(d.villages || []).length} məntəqə</span></summary><div class="location-values location-values-grid">${(d.villages || []).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'az')).map(v => `<span>${escapeHtml(v.name)}</span>`).join('') || '<em>Kənd əlavə edilməyib</em>'}</div></details>`).join('') || '<div class="empty">Rayon yoxdur.</div>';
}

function keywordGroupSummary(stat, mode) {
  const count = mode === 'exclude' ? stat.excluded_count : stat.positive_count;
  if (!count) return '';
  const orgKey = stat.organization_id || '';
  const css = mode === 'exclude' ? 'keyword-group exclusion-group' : 'keyword-group';
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

function sourceGroupSummary(org) {
  const rows = sourceIndex.filter(x => x.organization_id === org.id);
  const counts = new Map();
  for (const row of rows) {
    const key = normalizeSourcePlatform(row.platform);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const order = ['youtube','facebook','instagram','tiktok','linkedin','x','web','digər'];
  const platformGroups = order.filter(key => counts.get(key)).map(key => `
    <details class="source-platform-group" data-source-platform-group data-org-id="${org.id}" data-platform-key="${key}" data-total="${counts.get(key)}">
      <summary><span><strong>${sourcePlatformLabel(key)}</strong><small>${counts.get(key)} mənbə</small></span><span class="badge info">${counts.get(key)}</span></summary>
      <div class="source-platform-body" data-source-platform-body><div class="empty compact">Açdıqda yüklənəcək.</div></div>
    </details>`).join('');
  return `<details class="keyword-group source-org-group" data-source-org-group>
    <summary><span><strong>${escapeHtml(org.short_name || org.name || 'Təşkilat')}</strong><small>${rows.length} izlənilən mənbə</small></span><span class="badge info">${rows.length}</span></summary>
    <div class="source-org-body">${platformGroups || '<div class="empty compact">Mənbə yoxdur.</div>'}</div>
  </details>`;
}

function renderSources() {
  const el = document.querySelector('#source-list');
  if (!el) return;
  const groups = orgs.filter(o => sourceIndex.some(x => x.organization_id === o.id));
  el.innerHTML = groups.map(sourceGroupSummary).join('') || '<div class="empty compact">Mənbə yoxdur.</div>';

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

  const orgId = group.dataset.orgId;
  const platformKey = group.dataset.platformKey;
  const actualPlatforms = [...new Set(sourceIndex
    .filter(x => x.organization_id === orgId && normalizeSourcePlatform(x.platform) === platformKey)
    .map(x => String(x.platform || 'Web')))].filter(Boolean);

  let q = supabase.from('sources')
    .select('id,organization_id,platform,url,is_active,created_at')
    .eq('organization_id',orgId)
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
      <div class="source-item-main"><a target="_blank" rel="noopener" href="${escapeHtml(rawUrl || '#')}">${escapeHtml(rawUrl || 'URL yoxdur')}</a><small>${escapeHtml(x.platform || sourcePlatformLabel(platformKey))}</small></div>
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

function renderBilling() {
  const el = document.querySelector('#billing-list');
  if (!el) return;
  el.innerHTML = orgs.map(o => `
    <article class="billing-card"><div class="record-head"><div><strong>${escapeHtml(o.short_name)}</strong><small>${escapeHtml(o.name)}</small></div>${statusBadge(o.service_status)}</div><div class="billing-amount">${money(o.monthly_price)}</div><div class="record-grid"><div><span>Növbəti ödəniş</span><b>${o.next_payment_at ? fmtDate(o.next_payment_at) : 'Təyin edilməyib'}</b></div><div><span>Rayon</span><b>${escapeHtml(o.districts?.name || '—')}</b></div></div><div class="record-actions two"><button class="btn ghost" data-org-edit="${o.id}">Məlumatları redaktə et</button><button class="btn ${o.service_status === 'suspended' ? '' : 'secondary'}" data-org-toggle="${o.id}">${o.service_status === 'suspended' ? 'Xidməti aktivləşdir' : 'Xidməti dayandır'}</button></div></article>`).join('') || '<div class="empty">Abunə qeydi yoxdur.</div>';
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
      if (!confirm(question)) return;
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
      if (!confirm('Bu izlənilən mənbəni silmək istəyirsiniz?')) return;
      btn.disabled = true;
      const { error } = await supabase.from('sources').delete().eq('id',btn.dataset.sourceDelete);
      btn.disabled = false;
      toast(error ? error.message : 'Mənbə silindi', error ? 'error' : 'success');
      if (!error) { await loadSourceIndex(); renderSources(); bindDynamicActions(); }
    });
  });

  document.querySelectorAll('[data-org-toggle]').forEach(b => b.onclick = () => toggleOrg(b.dataset.orgToggle));
  document.querySelectorAll('[data-org-edit]').forEach(b => b.onclick = () => modal('org', { organization_id:b.dataset.orgEdit }));
  document.querySelectorAll('[data-user-edit]').forEach(b => b.onclick = () => modal('user', { user_id:b.dataset.userEdit }));
  document.querySelectorAll('[data-user-toggle]').forEach(b => b.onclick = () => toggleUser(b.dataset.userToggle, b.dataset.active === 'true'));
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => resetPassword(b.dataset.reset));
  document.querySelectorAll('[data-modal]').forEach(b => b.onclick = () => modal(b.dataset.modal));
}

async function toggleOrg(id) {
  const org = orgs.find(x => x.id === id);
  if (!org) return;
  const next = org.service_status === 'suspended' ? 'active' : 'suspended';
  const affected = users.filter(u => u.organization_id === id && u.is_active).length;
  const msg = next === 'suspended'
    ? `${org.short_name} üzrə xidmət dayandırılsın? ${affected} aktiv istifadəçi təşkilat açılana qədər sistemə daxil ola bilməyəcək. Məlumatlar silinməyəcək.`
    : `${org.short_name} üzrə xidmət aktivləşdirilsin? Təşkilatın aktiv istifadəçiləri yenidən sistemə daxil ola biləcək.`;
  if (!confirm(msg)) return;
  const { error } = await supabase.from('organizations').update({ service_status: next }).eq('id', id);
  toast(error ? error.message : `Təşkilat ${next === 'active' ? 'aktivləşdirildi' : 'dayandırıldı'}`, error ? 'error' : 'success');
  if (!error) await refresh();
}

async function toggleUser(id, active) {
  const target = users.find(x => x.id === id);
  if (!target) return;
  if (!confirm(`${userName(target)} hesabı ${active ? 'bloklansın' : 'aktivləşdirilsin'}?`)) return;
  const { error } = await supabase.from('profiles').update({ is_active: !active }).eq('id', id);
  toast(error ? error.message : 'İstifadəçi statusu yeniləndi', error ? 'error' : 'success');
  if (!error) await refresh();
}

async function invokeBackend(name, body) {
  const { data:{ session } } = await supabase.auth.getSession();
  const headers = session?.access_token ? { Authorization:`Bearer ${session.access_token}` } : {};
  const { data, error } = await supabase.functions.invoke(name, { body, headers });
  if (error) {
    const raw = `${error.message || ''} ${error.context?.status || ''}`.toLowerCase();
    if (raw.includes('404') || raw.includes('not found') || raw.includes('failed to send')) {
      return { data:null, error:new Error('Sistem xidməti hazırda əlçatan deyil. Bir neçə saniyə sonra yenidən yoxlayın.') };
    }
  }
  return { data, error };
}

async function resetPassword(authUserId) {
  const p = prompt('Yeni müvəqqəti şifrə (ən az 8 simvol):');
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
    const eyebrow = editing ? 'Müştəri məlumatları' : 'Yeni müştəri';
    const submitLabel = editing ? 'Dəyişiklikləri yadda saxla' : 'Təşkilat yarat';
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="org-form" data-org-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Tam adı</label><input class="input" id="org-name" value="${escapeHtml(editing?.name || '')}" required></div><div class="field"><label>Qısa adı</label><input class="input" id="org-short" value="${escapeHtml(editing?.short_name || '')}" required></div><div class="field"><label>Rayon</label><select class="select" id="org-district">${districts.map(d=>`<option value="${d.id}" ${editing?.district_id===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label>Aylıq xidmət (AZN)</label><input class="input" id="org-price" type="number" min="0" step="0.01" value="${Number(editing?.monthly_price || 0)}"></div><div class="field"><label>Növbəti ödəniş</label><input class="input" id="org-next" type="date" value="${editing?.next_payment_at ? String(editing.next_payment_at).slice(0,10) : ''}"></div><div class="field"><label>Xidmət statusu</label><select class="select" id="org-status"><option value="active" ${editing?.service_status==='active'?'selected':''}>Aktiv</option><option value="grace" ${editing?.service_status==='grace'?'selected':''}>Möhlət</option><option value="suspended" ${editing?.service_status==='suspended'?'selected':''}>Dayandırılıb</option><option value="archived" ${editing?.service_status==='archived'?'selected':''}>Arxiv</option></select></div><div class="field field-toggle"><label>Rayon üzrə geniş monitorinq</label><label class="switch-row"><input type="checkbox" id="org-district-wide" ${editing?.show_district_wide!==false?'checked':''}><span class="switch-ui"></span><span>Suvarma və su təsərrüfatına aid rayon məlumatlarını göstər</span></label></div></div><div class="modal-note">Aylıq qiymət, növbəti ödəniş, rayon və xidmət statusu buradan dəyişdirilir. Təşkilat dayandırıldıqda ona bağlı bütün aktiv istifadəçilərin girişinə avtomatik maneə qoyulur.</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    document.querySelector('#org-form').onsubmit = saveOrg;
  } else {
    const editing = preset.user_id ? users.find(u => u.id === preset.user_id) : null;
    if (editing?.system_role === 'super_admin') return toast('Super Admin sistem hesabı redaktə edilə bilməz.', 'error');
    const defaultOrg = editing?.organization_id || preset.organization_id || orgs.find(o => o.short_name?.toLowerCase().includes('bərdə'))?.id || orgs[0]?.id || '';
    const posOptions = positionOptionsForOrg(defaultOrg, editing?.position_id || preset.position_id || '');
    const title = editing ? 'İstifadəçini redaktə et' : 'Yeni istifadəçi';
    const submitLabel = editing ? 'Dəyişiklikləri yadda saxla' : 'Hesab yarat';
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="user-form" data-user-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">Təşkilat hesabı</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Ad</label><input class="input" id="u-first" value="${escapeHtml(editing?.first_name || preset.first_name || '')}" required></div><div class="field"><label>Soyad</label><input class="input" id="u-last" value="${escapeHtml(editing?.last_name || preset.last_name || '')}" required></div><div class="field"><label>E-mail</label><input class="input" id="u-email" type="email" value="${escapeHtml(editing?.email || '')}" autocomplete="off" ${editing ? 'readonly title="E-mail təhlükəsizlik səbəbilə ayrıca dəyişdirilir"' : 'required'}></div>${editing ? '' : '<div class="field"><label>Müvəqqəti şifrə</label><input class="input" id="u-pass" type="password" minlength="8" autocomplete="new-password" required></div>'}<div class="field"><label>Təşkilat</label><select class="select" id="u-org" required>${orgs.map(o=>`<option value="${o.id}" ${o.id===defaultOrg?'selected':''}>${escapeHtml(o.short_name)}</option>`).join('')}</select></div><div class="field"><label>Vəzifə</label><select class="select" id="u-position">${posOptions}</select></div><div class="field"><label>Sistem rolu</label><select class="select" id="u-role"><option value="organization_admin" ${(editing?.system_role || preset.system_role)==='organization_admin'?'selected':''}>Təşkilat admini</option><option value="manager" ${(editing?.system_role || preset.system_role)==='manager'?'selected':''}>Menecer</option><option value="analyst" ${(editing?.system_role || preset.system_role)==='analyst'?'selected':''}>Analitik</option><option value="viewer" ${(editing?.system_role || preset.system_role)==='viewer'?'selected':''}>Baxış</option></select></div></div><div class="modal-note">${editing ? 'Ad, soyad, təşkilat, vəzifə və rol yenilənə bilər. E-mail dəyişdirilmir; şifrə ayrıca “Şifrə” düyməsindən dəyişdirilir.' : 'Hesab yalnız seçilən təşkilatın məlumatlarını görəcək. Təşkilat xidməti dayandırılarsa bu hesab da avtomatik bloklanacaq.'}</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    const orgSelect = document.querySelector('#u-org');
    orgSelect.onchange = () => { document.querySelector('#u-position').innerHTML = positionOptionsForOrg(orgSelect.value); };
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
    monthly_price: Number(document.querySelector('#org-price').value || 0),
    next_payment_at: document.querySelector('#org-next').value || null,
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
  const row = {
    first_name:document.querySelector('#u-first').value.trim(),
    last_name:document.querySelector('#u-last').value.trim(),
    organization_id:document.querySelector('#u-org').value,
    position_id:document.querySelector('#u-position').value || null,
    system_role:document.querySelector('#u-role').value
  };
  const { error } = await supabase.from('profiles').update(row).eq('id', id).neq('system_role', 'super_admin');
  toast(error ? error.message : 'İstifadəçi məlumatları yeniləndi', error ? 'error' : 'success');
  if (!error) { closeModal(); await refresh(); location.hash = 'users'; route(); }
}

async function createUser(e) {
  e.preventDefault();
  const body = {
    action:'create',
    email:document.querySelector('#u-email').value.trim(),
    password:document.querySelector('#u-pass').value,
    first_name:document.querySelector('#u-first').value.trim(),
    last_name:document.querySelector('#u-last').value.trim(),
    organization_id:document.querySelector('#u-org').value,
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
  const org = orgs.find(o => ['bərdə smsii','bərdə smsİİ','bərdə smsii'].includes(String(o.short_name||'').toLocaleLowerCase('az-AZ')) || String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  const district = districts.find(d => String(d.name||'').toLocaleLowerCase('az-AZ') === 'bərdə');
  if (!org || !district) return toast('Bərdə SMSİİ təşkilatı və Bərdə rayonu tapılmalıdır.', 'error');

  const desiredPositions = ['İdarə rəisi','İdarə rəisinin müavini','Baş mühəndis','Mətbuat üzrə məsul şəxs','Operator'];
  const desiredKeywords = ['Bərdə SMSİİ','Bərdə SMSII','Bərdə Suvarma Sistemlərinin İstismarı İdarəsi','Bərdə Suvarma İdarəsi','Bərdə suvarma','Bərdə kanal','Bərdə arx','Bərdə fermer su','su gəlmir','su çatışmazlığı','suvarma suyu verilmir'];
  let changed = 0;

  const orgPatch = {};
  if (org.district_id !== district.id) orgPatch.district_id = district.id;
  if (org.service_status !== 'active') orgPatch.service_status = 'active';
  if (Object.keys(orgPatch).length) {
    const { error } = await supabase.from('organizations').update(orgPatch).eq('id', org.id);
    if (error) return toast(error.message,'error');
    changed++;
  }

  const pRes = await insertMissing('positions', positions, desiredPositions.map(name=>({name,organization_id:org.id})), (a,b)=>a.name===b.name && (a.organization_id===b.organization_id || !a.organization_id));
  if (pRes.error) return toast(pRes.error.message,'error');
  changed += pRes.count;

  // Konfiqurasiya düyməsi mövcud açar sözləri yenidən POST etməməlidir.
  // Unique index lower(trim(value)) olduğuna görə təşkilatın mövcud dəyərlərini yalnız
  // bu düymə basılanda səhifəli oxuyuruq və eyni normalizə olunmuş sözə POST etmirik.
  // Beləliklə Network/Console-da 409 duplicate sorğusu yaranmır.
  const existingKeywordResult = await loadOrganizationKeywordValues(org.id);
  if (existingKeywordResult.error) return toast(existingKeywordResult.error.message,'error');
  const existingNormalized = new Set(existingKeywordResult.values.map(value => String(value || '').trim().toLocaleLowerCase('az-AZ')));
  const missingKeywords = desiredKeywords.filter(value => !existingNormalized.has(value.trim().toLocaleLowerCase('az-AZ')));
  for (const value of missingKeywords) {
    const { error } = await supabase.from('keywords').insert({organization_id:org.id,value,kind:'phrase',is_active:true});
    if (error && error.code !== '23505') return toast(error.message,'error');
    if (!error) changed++;
  }

  toast(changed ? `Bərdə SMSİİ konfiqurasiyası tamamlandı: ${changed} dəyişiklik.` : 'Bərdə SMSİİ artıq düzgün konfiqurasiya olunub.', 'success');
  await refresh();
}

async function renderBardaStatus() {
  const el = document.querySelector('#barda-status');
  if (!el) return;
  const org = orgs.find(o => String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  if (!org) { el.innerHTML = '<span class="badge danger">Bərdə SMSİİ tapılmadı</span>'; return; }
  const hasDirector = positions.some(p => p.name === 'İdarə rəisi' && (!p.organization_id || p.organization_id === org.id));
  const webSources = sourceIndex.filter(s => s.organization_id===org.id && ['web','rss'].some(kind=>String(s.platform||'').toLowerCase().includes(kind)) && s.is_active !== false);
  const bits = [
    statusBadge(org.service_status),
    hasDirector ? '<span class="badge ok">Vəzifələr hazırdır</span>' : '<span class="badge warn">Vəzifə tamamlanmalıdır</span>',
    webSources.length ? `<span class="badge ok">Web mənbələri hazırdır (${webSources.length})</span>` : '<span class="badge warn">Web mənbəsi əlavə edilməlidir</span>',
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
    const recentStart = currentYear - 2;
    el.insertAdjacentHTML('beforeend', `<span class="badge info">Bazadakı nəticə: Web ${totalWeb} / YouTube ${youtube.count||0}</span><span class="badge info">Web arxiv: ${archiveWeb} / son 90 gün: ${currentWeb}</span><span class="badge info">Ən köhnə Web: ${escapeHtml(oldest)}</span><span class="badge info">Son yeni nəticə: ${escapeHtml(last)}</span><span class="badge ok">Prioritet Web backfill: ${recentStart}–${currentYear}</span><span class="badge ok">Tarixi arxiv backfill: 2000–${recentStart-1}</span>`);
  }
}


async function runMonitorNow() {
  const btn = document.querySelector('#run-monitor');
  if (!btn) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Monitorinq işləyir…';
  const { data, error } = await invokeBackend('monitor-worker', { mode:'manual' });
  btn.disabled = false;
  btn.textContent = old;
  if (error || data?.ok === false) return toast(error?.message || data?.error || 'Monitorinq işə salınmadı', 'error');
  toast(`Monitorinq tamamlandı: ${data?.new_mentions || 0} yeni nəticə`, 'success');
  await renderBardaStatus();
}

document.querySelector('#position-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('positions').insert({name:document.querySelector('#position-name').value.trim(),organization_id:document.querySelector('#position-org').value||null}); toast(error?error.message:'Vəzifə əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#district-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('districts').insert({name:document.querySelector('#district-name').value.trim()}); toast(error?error.message:'Rayon əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#village-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('villages').insert({district_id:document.querySelector('#village-district').value,name:document.querySelector('#village-name').value.trim()}); toast(error?error.message:'Kənd əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#keyword-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('keywords').insert({organization_id:document.querySelector('#keyword-org').value,value:document.querySelector('#keyword-value').value.trim(),kind:'phrase',is_active:true}); toast(error?error.message:'Açar söz əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#exclude-form').onsubmit = async e => {
  e.preventDefault();
  const organization_id = document.querySelector('#exclude-org').value;
  const value = document.querySelector('#exclude-value').value.trim();
  if (!value) return;
  const { error } = await supabase.from('keywords').insert({organization_id,value,kind:'exclude',is_active:true});
  const message = error?.code === '23505' ? 'Bu filtr artıq mövcuddur.' : (error?.message || 'Axtarılmamalı söz əlavə edildi');
  toast(message, error ? 'error' : 'success');
  if (!error) { e.target.reset(); await refresh(); }
};
document.querySelector('#source-form').onsubmit = async e => {
  e.preventDefault();
  const organization_id = document.querySelector('#source-org').value;
  const platform = document.querySelector('#source-platform').value.trim();
  const url = document.querySelector('#source-url').value.trim();
  const googleNews = url.includes('news.google.com/rss/');
  const urlNoSlash = url.replace(/\/+$/,'');
  let duplicateQuery = supabase.from('sources').select('id',{count:'exact',head:true}).eq('organization_id',organization_id);
  duplicateQuery = googleNews
    ? duplicateQuery.ilike('url','%news.google.com/rss/%')
    : duplicateQuery.in('url',[urlNoSlash,`${urlNoSlash}/`]);
  const duplicateResult = await duplicateQuery;
  if (duplicateResult.error) return toast(duplicateResult.error.message,'error');
  if ((duplicateResult.count || 0) > 0) return toast(googleNews ? 'Bu təşkilat üçün Google News RSS artıq mövcuddur.' : 'Bu mənbə artıq mövcuddur.', 'error');
  const { error } = await supabase.from('sources').insert({organization_id,platform,url,is_active:true});
  toast(error ? error.message : 'Mənbə əlavə edildi',error?'error':'success');
  if(!error){e.target.reset();await refresh();}
};

document.querySelector('#configure-barda').onclick = configureBarda;
document.querySelector('#run-monitor').onclick = runMonitorNow;

await refresh();
route();
