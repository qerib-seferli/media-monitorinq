import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, money, toast } from './core.js';

const ctx = await requireAuth({ superAdmin: true });
if (!ctx) throw new Error('auth');

let orgs = [];
let users = [];
let positions = [];
let districts = [];
let keywords = [];
let sources = [];
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

async function refresh() {
  const results = await Promise.all([
    supabase.from('organizations').select('*,districts(name)').order('created_at'),
    supabase.from('profiles').select('*,organizations(short_name),positions(name)').order('created_at',{ascending:false}),
    supabase.from('positions').select('*').order('name'),
    supabase.from('districts').select('*,villages(*)').order('name'),
    supabase.from('keywords').select('*,organizations(short_name)').order('created_at',{ascending:false}).limit(200),
    supabase.from('sources').select('*,organizations(short_name)').order('created_at',{ascending:false}).limit(120),
    supabase.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(100)
  ]);

  const [o,u,p,d,k,s,a] = results;
  const fatal = results.find(r => r.error);
  if (fatal?.error) toast(fatal.error.message, 'error');

  orgs = o.data || [];
  users = u.data || [];
  positions = p.data || [];
  districts = d.data || [];
  keywords = k.data || [];
  sources = s.data || [];
  auditRows = a.data || [];

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
      <td>${u.system_role !== 'super_admin' ? `<div class="inline-actions"><button class="btn secondary btn-sm" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Blokla' : 'Aktiv et'}</button><button class="btn ghost btn-sm" data-reset="${u.auth_user_id}">Şifrə</button></div>` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">İstifadəçi yoxdur.</td></tr>';

  mobile.innerHTML = users.map(u => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(userName(u))}</strong><small>${escapeHtml(u.email || '')}</small></div><span class="badge ${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Aktiv' : 'Deaktiv'}</span></div>
      <div class="record-grid"><div><span>Təşkilat</span><b>${escapeHtml(u.organizations?.short_name || 'Sistem')}</b></div><div><span>Vəzifə</span><b>${escapeHtml(u.positions?.name || '—')}</b></div><div><span>Rol</span><b>${escapeHtml(ROLE_LABELS[u.system_role] || u.system_role || '—')}</b></div></div>
      ${u.system_role !== 'super_admin' ? `<div class="record-actions two"><button class="btn secondary" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Hesabı blokla' : 'Hesabı aktiv et'}</button><button class="btn ghost" data-reset="${u.auth_user_id}">Şifrəni yenilə</button></div>` : ''}
    </article>`).join('') || '<div class="empty">İstifadəçi yoxdur.</div>';
}

function fillSelects() {
  const orgOptions = '<option value="">Seçin</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
  ['#keyword-org','#source-org'].forEach(sel => { const el = document.querySelector(sel); if (el) el.innerHTML = orgOptions; });
  const posOrg = document.querySelector('#position-org');
  if (posOrg) posOrg.innerHTML = '<option value="">Qlobal</option>' + orgs.map(o => `<option value="${o.id}">${escapeHtml(o.short_name)}</option>`).join('');
  const villageDistrict = document.querySelector('#village-district');
  if (villageDistrict) villageDistrict.innerHTML = '<option value="">Rayon seçin</option>' + districts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
}

function renderCatalogs() {
  const p = document.querySelector('#position-list');
  if (p) p.innerHTML = positions.map(x => `<span class="chip"><i></i>${escapeHtml(x.name)}${x.organization_id ? '<small>özəl</small>' : ''}</span>`).join('') || '<div class="empty compact">Vəzifə yoxdur.</div>';
  const l = document.querySelector('#location-list');
  if (l) l.innerHTML = districts.map(d => `
    <article class="location-row"><div class="location-title"><strong>${escapeHtml(d.name)}</strong><span>${(d.villages || []).length} məntəqə</span></div><div class="location-values">${(d.villages || []).map(v => `<span>${escapeHtml(v.name)}</span>`).join('') || '<em>Kənd əlavə edilməyib</em>'}</div></article>`).join('') || '<div class="empty">Rayon yoxdur.</div>';
}

function renderKeywords() {
  const el = document.querySelector('#keyword-list');
  if (!el) return;
  el.innerHTML = keywords.map(x => `<div class="list-row"><div><strong>${escapeHtml(x.value)}</strong><small>${escapeHtml(x.organizations?.short_name || '')}</small></div><span class="badge info">${escapeHtml(x.kind || 'phrase')}</span></div>`).join('') || '<div class="empty compact">Açar söz yoxdur.</div>';
}

function renderSources() {
  const el = document.querySelector('#source-list');
  if (!el) return;
  el.innerHTML = sources.map(x => `<div class="list-row source-row"><div><strong>${escapeHtml(x.platform || 'Web')}</strong><small>${escapeHtml(x.organizations?.short_name || '')}</small><a target="_blank" rel="noopener" href="${escapeHtml(x.url || '#')}">${escapeHtml(x.url || '')}</a></div><span class="badge ${x.is_active === false ? 'danger' : 'ok'}">${x.is_active === false ? 'Söndürülüb' : 'Aktiv'}</span></div>`).join('') || '<div class="empty compact">Mənbə yoxdur.</div>';
}

function renderBilling() {
  const el = document.querySelector('#billing-list');
  if (!el) return;
  el.innerHTML = orgs.map(o => `
    <article class="billing-card"><div class="record-head"><div><strong>${escapeHtml(o.short_name)}</strong><small>${escapeHtml(o.name)}</small></div>${statusBadge(o.service_status)}</div><div class="billing-amount">${money(o.monthly_price)}</div><div class="record-grid"><div><span>Növbəti ödəniş</span><b>${o.next_payment_at ? fmtDate(o.next_payment_at) : 'Təyin edilməyib'}</b></div><div><span>Rayon</span><b>${escapeHtml(o.districts?.name || '—')}</b></div></div><div class="record-actions two"><button class="btn ghost" data-org-edit="${o.id}">Məlumatları redaktə et</button><button class="btn ${o.service_status === 'suspended' ? '' : 'secondary'}" data-org-toggle="${o.id}">${o.service_status === 'suspended' ? 'Xidməti aktivləşdir' : 'Xidməti dayandır'}</button></div></article>`).join('') || '<div class="empty">Abunə qeydi yoxdur.</div>';
}

function renderAudit() {
  const el = document.querySelector('#audit-list');
  if (!el) return;
  el.innerHTML = auditRows.map(x => `<div class="list-row audit-row"><div><strong>${escapeHtml(x.action)}</strong><small>${escapeHtml(x.actor_email || 'sistem')}</small></div><time>${fmtDate(x.created_at)}</time></div>`).join('') || '<div class="empty">Audit qeydi yoxdur.</div>';
}

function bindDynamicActions() {
  document.querySelectorAll('[data-org-toggle]').forEach(b => b.onclick = () => toggleOrg(b.dataset.orgToggle));
  document.querySelectorAll('[data-org-edit]').forEach(b => b.onclick = () => modal('org', { organization_id:b.dataset.orgEdit }));
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
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const raw = `${error.message || ''} ${error.context?.status || ''}`.toLowerCase();
    if (raw.includes('404') || raw.includes('not found') || raw.includes('failed to send')) {
      return { data:null, error:new Error(`Sistem backend modulu (${name}) hələ Supabase-də aktiv deyil. Edge Functions deploy olunmalıdır.`) };
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
  return '<option value="">Seçilməyib</option>' + positions
    .filter(p => !p.organization_id || p.organization_id === orgId)
    .map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
}

function modal(type, preset={}) {
  if (type === 'org') {
    const editing = preset.organization_id ? orgs.find(o => o.id === preset.organization_id) : null;
    const title = editing ? 'Təşkilatı redaktə et' : 'Yeni təşkilat';
    const eyebrow = editing ? 'Müştəri məlumatları' : 'Yeni müştəri';
    const submitLabel = editing ? 'Dəyişiklikləri yadda saxla' : 'Təşkilat yarat';
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="org-form" data-org-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Tam adı</label><input class="input" id="org-name" value="${escapeHtml(editing?.name || '')}" required></div><div class="field"><label>Qısa adı</label><input class="input" id="org-short" value="${escapeHtml(editing?.short_name || '')}" required></div><div class="field"><label>Rayon</label><select class="select" id="org-district">${districts.map(d=>`<option value="${d.id}" ${editing?.district_id===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label>Aylıq xidmət (AZN)</label><input class="input" id="org-price" type="number" min="0" step="0.01" value="${Number(editing?.monthly_price || 0)}"></div><div class="field"><label>Növbəti ödəniş</label><input class="input" id="org-next" type="date" value="${editing?.next_payment_at ? String(editing.next_payment_at).slice(0,10) : ''}"></div><div class="field"><label>Xidmət statusu</label><select class="select" id="org-status"><option value="active" ${editing?.service_status==='active'?'selected':''}>Aktiv</option><option value="grace" ${editing?.service_status==='grace'?'selected':''}>Möhlət</option><option value="suspended" ${editing?.service_status==='suspended'?'selected':''}>Dayandırılıb</option><option value="archived" ${editing?.service_status==='archived'?'selected':''}>Arxiv</option></select></div></div><div class="modal-note">Aylıq qiymət, növbəti ödəniş, rayon və xidmət statusu buradan dəyişdirilir. Təşkilat dayandırıldıqda ona bağlı bütün aktiv istifadəçilərin girişinə avtomatik maneə qoyulur.</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    document.querySelector('#org-form').onsubmit = saveOrg;
  } else {
    const defaultOrg = preset.organization_id || orgs.find(o => o.short_name?.toLowerCase().includes('bərdə'))?.id || orgs[0]?.id || '';
    const posOptions = positionOptionsForOrg(defaultOrg, preset.position_id || '');
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="user-form"><div class="modal-head"><div><span class="eyebrow">Təşkilat hesabı</span><h2>Yeni istifadəçi</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Ad</label><input class="input" id="u-first" value="${escapeHtml(preset.first_name || '')}" required></div><div class="field"><label>Soyad</label><input class="input" id="u-last" value="${escapeHtml(preset.last_name || '')}" required></div><div class="field"><label>E-mail</label><input class="input" id="u-email" type="email" autocomplete="off" required></div><div class="field"><label>Müvəqqəti şifrə</label><input class="input" id="u-pass" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label>Təşkilat</label><select class="select" id="u-org" required>${orgs.map(o=>`<option value="${o.id}" ${o.id===defaultOrg?'selected':''}>${escapeHtml(o.short_name)}</option>`).join('')}</select></div><div class="field"><label>Vəzifə</label><select class="select" id="u-position">${posOptions}</select></div><div class="field"><label>Sistem rolu</label><select class="select" id="u-role"><option value="organization_admin" ${preset.system_role==='organization_admin'?'selected':''}>Təşkilat admini</option><option value="manager" ${preset.system_role==='manager'?'selected':''}>Menecer</option><option value="analyst">Analitik</option><option value="viewer">Baxış</option></select></div></div><div class="modal-note">Hesab yalnız seçilən təşkilatın məlumatlarını görəcək. Təşkilat xidməti dayandırılarsa bu hesab da avtomatik bloklanacaq.</div><div class="modal-actions"><button class="btn">Hesab yarat</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
    const orgSelect = document.querySelector('#u-org');
    orgSelect.onchange = () => { document.querySelector('#u-position').innerHTML = positionOptionsForOrg(orgSelect.value); };
    document.querySelector('#user-form').onsubmit = createUser;
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
    service_status: document.querySelector('#org-status').value
  };
  const query = orgId ? supabase.from('organizations').update(row).eq('id', orgId) : supabase.from('organizations').insert(row);
  const { error } = await query;
  toast(error ? error.message : (orgId ? 'Təşkilat məlumatları yeniləndi' : 'Təşkilat yaradıldı'), error ? 'error' : 'success');
  if (!error) { closeModal(); await refresh(); location.hash = 'organizations'; route(); }
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

  const kRes = await insertMissing('keywords', keywords, desiredKeywords.map(value=>({organization_id:org.id,value,kind:'phrase',is_active:true})), (a,b)=>a.organization_id===b.organization_id && String(a.value).toLocaleLowerCase('az-AZ')===String(b.value).toLocaleLowerCase('az-AZ'));
  if (kRes.error) return toast(kRes.error.message,'error');
  changed += kRes.count;

  const rssUrl = 'https://news.google.com/rss/search?q=' + encodeURIComponent('"Bərdə SMSİİ" OR "Bərdə suvarma" OR "Bərdə Suvarma İdarəsi"') + '&hl=az&gl=AZ&ceid=AZ:az';
  const hasRss = sources.some(s => s.organization_id===org.id && String(s.url||'').includes('news.google.com/rss/search'));
  if (!hasRss) {
    const { error } = await supabase.from('sources').insert({organization_id:org.id,platform:'RSS',url:rssUrl,is_active:true});
    if (error) return toast(error.message,'error');
    changed++;
  }

  toast(changed ? `Bərdə SMSİİ konfiqurasiyası tamamlandı: ${changed} dəyişiklik.` : 'Bərdə SMSİİ artıq düzgün konfiqurasiya olunub.', 'success');
  await refresh();
}

function renderBardaStatus() {
  const el = document.querySelector('#barda-status');
  if (!el) return;
  const org = orgs.find(o => String(o.short_name||'').toLocaleLowerCase('az-AZ').includes('bərdə sms'));
  if (!org) { el.innerHTML = '<span class="badge danger">Bərdə SMSİİ tapılmadı</span>'; return; }
  const hasDirector = positions.some(p => p.name === 'İdarə rəisi' && (!p.organization_id || p.organization_id === org.id));
  const hasRss = sources.some(s => s.organization_id===org.id && String(s.url||'').includes('news.google.com/rss/search'));
  const bits = [statusBadge(org.service_status), hasDirector ? '<span class="badge ok">Vəzifələr hazırdır</span>' : '<span class="badge warn">Vəzifə tamamlanmalıdır</span>', hasRss ? '<span class="badge ok">Real RSS hazırdır</span>' : '<span class="badge warn">RSS əlavə edilməlidir</span>'];
  el.innerHTML = bits.join(' ');
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
  const el = document.querySelector('#barda-status');
  if (el) el.insertAdjacentHTML('beforeend', `<span class="badge info">Son yoxlama: ${data?.checked_sources || 0} mənbə / ${data?.new_mentions || 0} yeni</span>`);
}

document.querySelector('#position-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('positions').insert({name:document.querySelector('#position-name').value.trim(),organization_id:document.querySelector('#position-org').value||null}); toast(error?error.message:'Vəzifə əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#district-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('districts').insert({name:document.querySelector('#district-name').value.trim()}); toast(error?error.message:'Rayon əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#village-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('villages').insert({district_id:document.querySelector('#village-district').value,name:document.querySelector('#village-name').value.trim()}); toast(error?error.message:'Kənd əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#keyword-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('keywords').insert({organization_id:document.querySelector('#keyword-org').value,value:document.querySelector('#keyword-value').value.trim(),kind:'phrase',is_active:true}); toast(error?error.message:'Açar söz əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };
document.querySelector('#source-form').onsubmit = async e => { e.preventDefault(); const { error } = await supabase.from('sources').insert({organization_id:document.querySelector('#source-org').value,platform:document.querySelector('#source-platform').value.trim(),url:document.querySelector('#source-url').value.trim(),is_active:true}); toast(error?error.message:'Mənbə əlavə edildi',error?'error':'success'); if(!error){e.target.reset();await refresh();} };

document.querySelector('#configure-barda').onclick = configureBarda;
document.querySelector('#run-monitor').onclick = runMonitorNow;

await refresh();
route();
