import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, toast, getCachedProfile, showPageLoader, hidePageLoader, confirmDialog, promptDialog } from './core.js';
import { resetGlobalExcludeCache, loadGlobalExcludes, isMentionExcluded } from './scope.js';
import { initAzerbaijanMonitoringMap } from './azerbaijan-map.js';

const cachedProfile=getCachedProfile(); if(cachedProfile?.system_role==='super_admin') renderShell(cachedProfile, location.hash.replace('#','')||'dashboard'); showPageLoader();
const ctx = await requireAuth({ superAdmin: true });
if (!ctx) throw new Error('auth');

let orgs = [];
let users = [];
let positions = [];
let districts = [];
let placeCatalog = [];
let placeCatalogAvailable = false;
let keywords = [];
let globalKeywordRows = [];
let allKeywordRows = [];
let keywordStats = [];
let keywordBankTotals = { records_total:0, total:0, inactive:0, positive:0, exclude:0, global_positive:0, global_exclude:0, organization_positive:0, organization_exclude:0 };
const KEYWORD_PAGE_SIZE = 100;
let sources = [];
let sourceIndex = [];
const SOURCE_PAGE_SIZE = 100;
let auditRows = [];
let aliases = [];
let showArchivedOrganizations = false;

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
  const rows=[]; const pageSize=1000; let loadError=null;
  const totalResult=await supabase.from('keywords').select('id',{count:'exact',head:true});
  const recordsTotal=totalResult.error?0:Number(totalResult.count||0);
  for(let from=0;from<50000;from+=pageSize){
    const {data,error}=await supabase.from('keywords')
      .select('id,organization_id,value,kind,is_active,created_at')
      .eq('is_active',true)
      .order('created_at',{ascending:true}).range(from,from+pageSize-1);
    if(error){loadError=error;break;}
    const batch=data||[]; rows.push(...batch);
    if(batch.length<pageSize)break;
  }
  if(loadError){
    toast(loadError.message,'error'); allKeywordRows=[]; globalKeywordRows=[];
    keywordStats=[{organization_id:'__all__',name:'Bütün aktiv söz bazası',positive_count:0,excluded_count:0,error:loadError}];
    keywordBankTotals={records_total:recordsTotal,total:0,inactive:recordsTotal,positive:0,exclude:0,global_positive:0,global_exclude:0,organization_positive:0,organization_exclude:0};
    return;
  }
  allKeywordRows=rows.filter(row=>String(row?.value||'').trim());
  globalKeywordRows=dedupeKeywordRows(allKeywordRows.filter(row=>!row.organization_id));
  const positives=allKeywordRows.filter(row=>String(row.kind||'phrase')!=='exclude');
  const excludes=allKeywordRows.filter(row=>String(row.kind||'phrase')==='exclude');
  const globalPositive=positives.filter(row=>!row.organization_id).length;
  const globalExclude=excludes.filter(row=>!row.organization_id).length;
  keywordBankTotals={
    records_total:recordsTotal||allKeywordRows.length, total:allKeywordRows.length, inactive:Math.max(0,(recordsTotal||allKeywordRows.length)-allKeywordRows.length), positive:positives.length, exclude:excludes.length,
    global_positive:globalPositive, global_exclude:globalExclude,
    organization_positive:positives.length-globalPositive, organization_exclude:excludes.length-globalExclude
  };
  keywordStats=[{organization_id:'__all__',name:'Bütün aktiv söz bazası',positive_count:positives.length,excluded_count:excludes.length,error:null}];
}

function isMissingPlaceCatalogError(error) {
  const raw = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return raw.includes('42p01') || raw.includes('pgrst205') || raw.includes('place_catalog') && (raw.includes('not found') || raw.includes('does not exist'));
}

async function loadPlaceCatalog() {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; from < 10000; from += pageSize) {
    const { data, error } = await supabase.from('place_catalog')
      .select('id,district_id,official_code,name,place_type,city_district,autonomous_republic,monitoring_aliases,is_official,is_active')
      .eq('is_active', true)
      .order('name')
      .range(from, from + pageSize - 1);
    if (error) {
      if (!isMissingPlaceCatalogError(error)) toast(error.message, 'error');
      placeCatalogAvailable = false;
      placeCatalog = districts.flatMap(d => (d.villages || []).map(v => ({
        ...v,
        district_id: d.id,
        place_type: 'kənd',
        is_official: false,
        is_active: true,
        legacy: true
      })));
      return;
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  placeCatalogAvailable = true;
  placeCatalog = rows;
}

function placeTypeLabel(value='') {
  return ({'şəhər':'Şəhər','qəsəbə':'Qəsəbə','kənd':'Kənd','digər':'Digər'})[value] || value || 'Kənd';
}

function normalizeLocationSearch(value='') {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('az-AZ');
}

function bindLocationCatalogFilters() {
  const search = document.querySelector('#location-search');
  const type = document.querySelector('#location-type-filter');
  if (search && search.dataset.bound !== '1') {
    search.dataset.bound = '1';
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(renderCatalogs, 120);
    });
  }
  if (type && type.dataset.bound !== '1') {
    type.dataset.bound = '1';
    type.addEventListener('change', renderCatalogs);
  }
}

async function refresh() {
  const results = await Promise.all([
    supabase.from('organizations').select('*').order('created_at'),
    supabase.from('profiles').select('*,organizations(short_name),positions(name)').order('created_at',{ascending:false}),
    supabase.from('positions').select('*').order('name'),
    supabase.from('districts').select('*,villages(*)').order('name'),
    supabase.from('audit_logs').select('*').neq('action','radar_scan_event').order('created_at',{ascending:false}).limit(100),
    supabase.from('organization_aliases').select('*').order('alias')
  ]);

  const [o,u,p,d,a,al] = results;
  const fatal = results.find(r => r.error);
  if (fatal?.error) toast(fatal.error.message, 'error');

  orgs = o.data || [];
  users = u.data || [];
  positions = p.data || [];
  districts = d.data || [];
  await loadPlaceCatalog();
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
  const rows = sortedOrganizations().filter(o => showArchivedOrganizations || o.service_status !== 'archived');
  const archiveCount = orgs.filter(o=>o.service_status==='archived').length;
  const archiveToggle = document.querySelector('#toggle-archived-organizations');
  if (archiveToggle) archiveToggle.textContent = showArchivedOrganizations ? `Arxivləri gizlət (${archiveCount})` : `Arxivləri göstər (${archiveCount})`;
  desktop.innerHTML = rows.map(o => `
    <tr>
      <td><strong>${escapeHtml(o.short_name)}</strong><br><span class="muted table-sub">${escapeHtml(o.name)}</span></td>
      <td>${escapeHtml(organizationTypeLabel(o.organization_type))}</td>
      <td><strong>${escapeHtml((districts.find(d=>d.id===(o.location_district_id||o.district_id))?.name) || '—')}</strong></td>
      <td><span class="muted table-sub">${escapeHtml(o.address_text || 'Ünvan qeyd edilməyib')}</span></td>
      <td>${statusBadge(o.service_status)}</td>
      <td><div class="inline-actions"><button class="btn ghost btn-sm" data-org-edit="${o.id}">Redaktə et</button><button class="btn secondary btn-sm" data-org-toggle="${o.id}">${o.service_status === 'suspended' || o.service_status === 'archived' ? 'Aktivləşdir' : 'Dayandır'}</button><button class="btn danger btn-sm" data-org-delete="${o.id}">Sil</button></div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">Təşkilat yoxdur.</td></tr>';

  mobile.innerHTML = rows.map(o => `
    <article class="record-card">
      <div class="record-head"><div><strong>${escapeHtml(o.short_name)}</strong><small>${escapeHtml(o.name)}</small></div>${statusBadge(o.service_status)}</div>
      <div class="record-grid"><div><span>Növ</span><b>${escapeHtml(organizationTypeLabel(o.organization_type))}</b></div><div><span>Yerləşdiyi ərazi</span><b>${escapeHtml((districts.find(d=>d.id===(o.location_district_id||o.district_id))?.name) || '—')}</b></div><div class="record-grid-wide"><span>Ünvan</span><b>${escapeHtml(o.address_text || 'Qeyd edilməyib')}</b></div><div><span>Ad variantı</span><b>${aliases.filter(a=>a.organization_id===o.id&&a.is_active!==false).length}</b></div></div>
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
  const stat = document.querySelector('#place-catalog-stats');
  const source = document.querySelector('#place-catalog-source');
  const searchValue = normalizeLocationSearch(document.querySelector('#location-search')?.value || '');
  const typeValue = document.querySelector('#location-type-filter')?.value || '';
  const activePlaces = placeCatalog.filter(x => x.is_active !== false);
  const officialPlaces = activePlaces.filter(x => x.is_official === true);
  const statRows = officialPlaces.length ? officialPlaces : activePlaces;
  const counts = { 'şəhər':0, 'qəsəbə':0, 'kənd':0 };
  statRows.forEach(x => { if (x.place_type in counts) counts[x.place_type] += 1; });
  if (stat) stat.innerHTML = `<span><b>${counts['şəhər']}</b> şəhər</span><span><b>${counts['qəsəbə']}</b> qəsəbə</span><span><b>${counts['kənd']}</b> kənd</span><span><b>${statRows.length}</b> cəmi</span>`;
  if (source) {
    source.textContent = placeCatalogAvailable && officialPlaces.length ? `Rəsmi kataloq • ${officialPlaces.length}` : 'Köhnə coğrafiya bazası';
    source.className = `badge ${placeCatalogAvailable && officialPlaces.length ? 'ok' : 'warn'}`;
  }

  const uniqueDistricts=[...new Map(districts.map(d=>[String(d.name||'').trim().toLocaleLowerCase('az-AZ'),d])).values()];
  const typeOrder = {'şəhər':0,'qəsəbə':1,'kənd':2,'digər':3};
  const districtRows = uniqueDistricts.map(d => {
    const districtNeedle = normalizeLocationSearch(`${d.name || ''} ${d.autonomous_republic || ''}`);
    const districtMatched = !searchValue || districtNeedle.includes(searchValue);
    let rows = activePlaces.filter(x => x.district_id === d.id);
    if (typeValue) rows = rows.filter(x => (x.place_type || 'kənd') === typeValue);
    if (searchValue && !districtMatched) {
      rows = rows.filter(x => normalizeLocationSearch(`${x.name || ''} ${x.city_district || ''} ${(x.monitoring_aliases || []).join(' ')}`).includes(searchValue));
    }
    rows.sort((a,b)=>(typeOrder[a.place_type]??9)-(typeOrder[b.place_type]??9) || String(a.name||'').localeCompare(String(b.name||''),'az'));
    if (searchValue && !districtMatched && !rows.length) return '';
    if (typeValue && !rows.length) return '';
    const nar = d.autonomous_republic ? `<small class="location-region-note">${escapeHtml(d.autonomous_republic)}</small>` : '';
    return `<details class="location-row location-group" ${searchValue && rows.length ? 'open' : ''}><summary class="location-title"><strong>${escapeHtml(d.name)}${nar}</strong><span>${rows.length} məntəqə</span></summary><div class="location-values location-values-grid">${rows.map(v => `<span class="location-place"><b>${escapeHtml(v.name)}</b><small class="place-type ${escapeHtml(v.place_type || 'kənd')}">${escapeHtml(placeTypeLabel(v.place_type || 'kənd'))}</small>${v.city_district ? `<small class="place-city-district">${escapeHtml(v.city_district)}</small>` : ''}</span>`).join('') || '<em>Bu filtr üzrə məntəqə yoxdur</em>'}</div></details>`;
  }).filter(Boolean);
  if (l) l.innerHTML = districtRows.join('') || '<div class="empty">Uyğun ərazi və ya yaşayış məntəqəsi tapılmadı.</div>';
  bindLocationCatalogFilters();
}

function normalizeKeywordValue(value=''){
  return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('az-AZ');
}
function keywordBucket(row){return String(row?.kind||'phrase')==='exclude'?'exclude':'positive';}
function dedupeKeywordRows(rows=[]){
  const seen=new Set(),out=[];
  for(const row of rows){
    const key=`${keywordBucket(row)}|${normalizeKeywordValue(row?.value)}`;
    if(!normalizeKeywordValue(row?.value)||seen.has(key))continue;
    seen.add(key);out.push(row);
  }
  return out;
}
function globalKeywordExists(value,mode='positive'){
  const key=normalizeKeywordValue(value);
  return globalKeywordRows.some(row=>keywordBucket(row)===mode&&normalizeKeywordValue(row.value)===key);
}

function keywordGroupSummary(stat, mode) {
  const count = mode === 'exclude' ? stat.excluded_count : stat.positive_count;
  if (!count) return '';
  const orgKey = stat.organization_id || '';
  const css = mode === 'exclude' ? 'keyword-group exclusion-group' : 'keyword-group positive-group';
  const globalList=String(stat.organization_id||'')==='__all__';
  const title=globalList?(mode==='exclude'?'Axtarılmayan sözlərin siyahısı':'Axtarılan sözlərin siyahısı'):stat.name;
  const hint=globalList?'Siyahını aç və idarə et':`${count} ${mode==='exclude'?'aktiv filtr':'açar söz'}`;
  return `
    <details class="${css}" data-keyword-group="1" data-mode="${mode}" data-org-id="${escapeHtml(orgKey)}" data-total="${count}">
      <summary>
        <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(hint)}</small></span>
        <span class="keyword-list-open-mark">Aç ›</span>
      </summary>
      <div class="keyword-group-body" data-keyword-body>
        <div class="empty compact">Açdıqda ilk ${Math.min(KEYWORD_PAGE_SIZE,count)} qeyd yüklənəcək.</div>
      </div>
    </details>`;
}

function renderKeywordSearchResults(target, rows, mode) {
  if (!target) return;
  if (!rows?.length) { target.innerHTML='<div class="empty compact">Uyğun söz tapılmadı.</div>'; target.classList.remove('hidden'); return; }
  target.innerHTML=rows.map(x=>{const org=x.organization_id?orgs.find(o=>o.id===x.organization_id):null;const scope=org?(org.short_name||org.name||'Təşkilat'):'Qlobal';return `<div class="keyword-search-hit"><span>${escapeHtml(x.value)}</span><small>${mode==='exclude'?'Axtarılmamalı':'Monitorinq açar sözü'} • ${escapeHtml(scope)}</small></div>`}).join('');
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
    timer=setTimeout(()=>{
      if(current!==token)return;
      const needle=normalizeKeywordValue(value);
      const rows=allKeywordRows
        .filter(row=>keywordBucket(row)===mode&&normalizeKeywordValue(row.value).includes(needle))
        .sort((a,b)=>String(a.value||'').localeCompare(String(b.value||''),'az'))
        .slice(0,30);
      renderKeywordSearchResults(result,rows,mode);
    },180);
  });
}

function renderKeywords() {
  const el = document.querySelector('#keyword-list');
  const excludeEl = document.querySelector('#exclude-list');
  if (!el) return;

  const summary=document.querySelector('#keyword-bank-summary');
  if(summary){
    summary.innerHTML=`<div class="keyword-bank-overview keyword-bank-overview-single">
      <span><small>Ümumi söz bazası</small><b>${keywordBankTotals.records_total}</b></span>
      <span><small>Prioritet axtarılan</small><b>${keywordBankTotals.positive}</b></span>
      <span><small>Prioritet filtr</small><b>${keywordBankTotals.exclude}</b></span>
      <span><small>Ehtiyat rotasiya bankı</small><b>${keywordBankTotals.inactive}</b></span>
      <div class="keyword-bank-note"><b>${keywordBankTotals.records_total}</b> qeyd artıq sistemdə istifadədədir: <b>${keywordBankTotals.total}</b> aktiv/prioritet qeyd hər taramada birinci işləyir, <b>${keywordBankTotals.inactive}</b> arxiv/deaktiv qeyd isə təhlükəsiz <strong>rotasiya bankı</strong> kimi mərhələli istifadə olunur. Beləliklə baza silinmir və birdən-birə bütün köhnə sözlər aktivləşdirilib əlaqəsiz nəticə yaratmır. <strong>Gemini AI</strong> radar zamanı bankı ələkdən keçirərək uyğun frazaları prioritet bankına daşıya bilər.</div>
    </div>`;
  }
  const positiveGroups = keywordStats.filter(x => x.positive_count > 0);
  el.innerHTML = (positiveGroups.map(x => keywordGroupSummary(x,'positive')).join('') || '<div class="empty compact">Açar söz yoxdur.</div>');

  if (excludeEl) {
    const excludeGroups = keywordStats.filter(x => x.excluded_count > 0);
    excludeEl.innerHTML = (excludeGroups.map(x => keywordGroupSummary(x,'exclude')).join('') || '<div class="empty compact">Axtarılmamalı söz təyin edilməyib.</div>');
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

  const mode = group.dataset.mode || 'positive';
  const allRows=allKeywordRows
    .filter(row=>keywordBucket(row)===mode)
    .sort((a,b)=>String(a.value||'').localeCompare(String(b.value||''),'az'));
  const rows=allRows.slice(offset,offset+KEYWORD_PAGE_SIZE);
  group.dataset.loading = '0';

  const html = rows.map(x => {
    const org=x.organization_id?orgs.find(o=>o.id===x.organization_id):null;
    const scope=org?(org.short_name||org.name||'Təşkilat'):'Qlobal';
    return mode === 'exclude' ? `
    <div class="keyword-item exclusion-item">
      <span>${escapeHtml(x.value)} <small class="keyword-scope">${escapeHtml(scope)}</small></span>
      <button class="icon-btn keyword-delete exclusion-delete" type="button" title="Filtri sil" aria-label="${escapeHtml(x.value)} filtrini sil" data-keyword-delete="${x.id}" data-keyword-delete-mode="exclude">×</button>
    </div>` : `
    <div class="keyword-item">
      <span>${escapeHtml(x.value)} <small class="keyword-scope">${escapeHtml(scope)}</small></span>
      <span class="keyword-item-actions"><span class="badge info">${escapeHtml(x.kind || 'phrase')}</span><button class="icon-btn keyword-delete" type="button" title="Açar sözü sil" aria-label="${escapeHtml(x.value)} açar sözünü sil" data-keyword-delete="${x.id}" data-keyword-delete-mode="positive">×</button></span>
    </div>`;
  }).join('');

  const total = allRows.length;
  const nextOffset = offset + rows.length;
  const more = nextOffset < total ? `<button class="btn ghost btn-sm keyword-load-more" type="button" data-keyword-more="${nextOffset}">Daha ${Math.min(KEYWORD_PAGE_SIZE,total-nextOffset)} göstər</button>` : '';

  if (append) {
    body.querySelector('[data-keyword-more]')?.remove();
    body.insertAdjacentHTML('beforeend', html + more);
  } else {
    body.innerHTML = html + more || '<div class="empty compact">Qeyd yoxdur.</div>';
    group.dataset.loaded = '1';
  }
  body.querySelector('[data-keyword-more]')?.addEventListener('click', e => loadKeywordGroup(group, Number(e.currentTarget.dataset.keywordMore || 0), true));
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

  const archiveToggle=document.querySelector('#toggle-archived-organizations');
  if(archiveToggle && !archiveToggle.dataset.bound){archiveToggle.dataset.bound='1';archiveToggle.addEventListener('click',()=>{showArchivedOrganizations=!showArchivedOrganizations;renderOrgs();bindDynamicActions();});}
  const fullRefilterBtn=document.querySelector('#full-refilter-btn');
  if(fullRefilterBtn && !fullRefilterBtn.dataset.bound){fullRefilterBtn.dataset.bound='1';fullRefilterBtn.addEventListener('click',runFullDatabaseRefilter);}
  const reviewSieveBtn=document.querySelector('#review-auto-sieve-btn');
  if(reviewSieveBtn && !reviewSieveBtn.dataset.bound){reviewSieveBtn.dataset.bound='1';reviewSieveBtn.addEventListener('click',runReviewAutoSieve);}
  const radarStart=document.querySelector('#network-radar-start');
  if(radarStart && !radarStart.dataset.bound){radarStart.dataset.bound='1';radarStart.addEventListener('click',runNetworkRadarScan);}
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

let backendRefreshPromise=null;
async function refreshBackendSession(){
  if(!backendRefreshPromise){
    backendRefreshPromise=supabase.auth.refreshSession().finally(()=>{backendRefreshPromise=null;});
  }
  const result=await backendRefreshPromise;
  return result?.data?.session||null;
}
async function invokeBackend(name, body) {
  const call = async (forceRefresh=false) => {
    let session=null;
    if(forceRefresh) session=await refreshBackendSession();
    else {
      const current=await supabase.auth.getSession();
      session=current?.data?.session||null;
      const expiresAt=Number(session?.expires_at||0)*1000;
      if(session && expiresAt && expiresAt-Date.now()<120000) session=await refreshBackendSession();
    }
    const headers=session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{ };
    return supabase.functions.invoke(name,{body,headers});
  };
  let {data,error}=await call(false);
  let status=Number(error?.context?.status||error?.status||0);
  const authFailure=()=>error && (status===401||status===403||/jwt|unauthorized|forbidden|403|401/i.test(String(error?.message||'')));
  // Uzun radar/axtarış sessiyalarında giriş tokeni vaxtı bitə bilər. 401/403 olduqda
  // sessiya həqiqətən yenilənir və eyni sorğu yalnız bir dəfə təkrar edilir.
  if(authFailure()){
    const retry=await call(true).catch(e=>({data:null,error:e}));
    data=retry.data; error=retry.error;
    status=Number(error?.context?.status||error?.status||0);
  }
  if (error) {
    const raw = `${error.message || ''} ${error.context?.status || ''}`.toLowerCase();
    if (raw.includes('404') || raw.includes('not found') || raw.includes('failed to send') || raw.includes('failed to fetch') || raw.includes('cors')) {
      return { data:null, error:new Error('Sistem xidməti müvəqqəti cavab vermədi.') };
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
    document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-bg"><form class="modal" id="org-form" data-org-id="${editing?.id || ''}"><div class="modal-head"><div><span class="eyebrow">Təşkilat kataloqu</span><h2>${title}</h2></div><button type="button" class="icon-btn" id="close-modal">✕</button></div><div class="form-grid"><div class="field"><label>Tam adı</label><input class="input" id="org-name" value="${escapeHtml(editing?.name || '')}" required></div><div class="field"><label>Qısa adı</label><input class="input" id="org-short" value="${escapeHtml(editing?.short_name || '')}" required></div><div class="field"><label>Təşkilat növü</label><select class="select" id="org-type"><option value="district" ${typeValue==='district'?'selected':''}>Rayon idarəsi</option><option value="regional_unit" ${typeValue==='regional_unit'?'selected':''}>Regional vahid</option><option value="special_unit" ${typeValue==='special_unit'?'selected':''}>Xüsusi idarə</option><option value="central_service" ${typeValue==='central_service'?'selected':''}>Mərkəzi xidmət</option></select></div><div class="field"><label>Axtarış əhatəsi (texniki)</label><select class="select" id="org-district"><option value="">Mərkəzi / ümumi</option>${districts.map(d=>`<option value="${d.id}" ${editing?.district_id===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label>Yerləşdiyi ərazi (xəritə üçün)</label><select class="select" id="org-location-district"><option value="">Seçilməyib</option>${districts.map(d=>`<option value="${d.id}" ${(editing?.location_district_id||editing?.district_id)===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field form-span-2"><label>Təşkilatın rəsmi ünvanı</label><input class="input" id="org-address" value="${escapeHtml(editing?.address_text || '')}" placeholder="Məs: Bərdə şəhəri, H. Əliyev prospekti 110"></div><div class="field form-span-2"><label>Ünvan mənbəyi</label><input class="input" id="org-address-source" type="url" value="${escapeHtml(editing?.address_source_url || '')}" placeholder="https://..."></div><div class="field"><label>Xidmət statusu</label><select class="select" id="org-status"><option value="active" ${editing?.service_status==='active'?'selected':''}>Aktiv</option><option value="grace" ${editing?.service_status==='grace'?'selected':''}>Möhlət</option><option value="suspended" ${editing?.service_status==='suspended'?'selected':''}>Dayandırılıb</option><option value="archived" ${editing?.service_status==='archived'?'selected':''}>Arxiv</option></select></div><div class="field field-toggle"><label>Rayon üzrə geniş monitorinq</label><label class="switch-row"><input type="checkbox" id="org-district-wide" ${editing?.show_district_wide!==false?'checked':''}><span class="switch-ui"></span><span>Təşkilatın rayonuna aid ümumi su və meliorasiya materiallarını da göstər</span></label></div></div><div class="modal-note">“Yerləşdiyi ərazi” təşkilatın fiziki ünvanını və xəritədə hansı rayonda görünəcəyini müəyyən edir. “Axtarış əhatəsi” isə radarın məntəqə/açar-söz genişləndirilməsi üçün texniki sahədir. Köhnə və alternativ adlar ayrıca “Təşkilat ad variantları” bölməsində idarə olunur.</div><div class="modal-actions"><button class="btn">${submitLabel}</button><button type="button" class="btn ghost" id="cancel-modal">Ləğv et</button></div></form></div>`;
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
    location_district_id: document.querySelector('#org-location-district')?.value || null,
    address_text: document.querySelector('#org-address')?.value.trim() || null,
    address_source_url: document.querySelector('#org-address-source')?.value.trim() || null,
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
  const renderSeq=++bardaStatusRenderSeq;
  const el = document.querySelector('#barda-status');
  const globalEl = document.querySelector('#global-status');
  if (!el && !globalEl) return;
  const globalStats = {positive_count:keywordBankTotals.positive,excluded_count:keywordBankTotals.exclude};
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
    if(renderSeq!==bardaStatusRenderSeq) return;
    const last = latest?.data?.detected_at ? fmtDate(latest.data.detected_at) : '—';
    const totalWeb = Number(web.count || 0);
    const currentWeb = recentWeb?.error ? 0 : Number(recentWeb.count || 0);
    const archiveWeb = Math.max(0, totalWeb - currentWeb);
    const oldest = oldestWeb?.data?.published_at ? fmtDate(oldestWeb.data.published_at) : '—';
    const currentYear = new Date().getFullYear();
    el.insertAdjacentHTML('beforeend', `<span class="badge info">Bərdə nəticəsi: Web ${totalWeb} / YouTube ${youtube.count||0}</span><span class="badge info">Web arxiv: ${archiveWeb} / son 90 gün: ${currentWeb}</span><span class="badge info">Ən köhnə Web: ${escapeHtml(oldest)}</span><span class="badge info">Son yeni nəticə: ${escapeHtml(last)}</span><span class="badge ok">Əsas Web backfill: 2020–${currentYear}</span><span class="badge ok">Tarixi arxiv: 2000–2019</span>`);
  }
}



const NETWORK_RADAR_STORAGE_KEY='media_monitorinq_full_radar_v2';
let networkRadarRunning=false;
let networkRadarStartedAt=0;
let networkRadarTimer=null;
let networkRadarPollTimer=null;
let networkRadarRunId=0;
let networkRadarScanId='';
let networkRadarLastFeedSignature='';
let networkRadarMaxFound=0;
let networkRadarTransientErrors=0;
let networkRadarLastOrgCounts={};
let networkRadarTerminalTimer=null;
let networkRadarTerminalIndex=0;
let networkRadarLastTelemetryAt=0;
let networkRadarTelemetryPollTimer=null;
let networkRadarKeywordFlowTimer=null;
let networkRadarKeywordFlowOffset=0;
let networkRadarKeywordFlowEvents=[];
let bardaStatusRenderSeq=0;
let adminAzerbaijanMap=null;

function radarTime(ms){
  const total=Math.max(0,Math.floor(ms/1000));
  const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;
  return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function radarStorageRead(){try{const raw=localStorage.getItem(NETWORK_RADAR_STORAGE_KEY);return raw?JSON.parse(raw):null}catch{return null}}
function radarStorageWrite(value){try{localStorage.setItem(NETWORK_RADAR_STORAGE_KEY,JSON.stringify(value||{}));adminAzerbaijanMap?.refreshRadar?.()}catch{}}
function radarStorageClear(){try{localStorage.removeItem(NETWORK_RADAR_STORAGE_KEY)}catch{}}
const LEGACY_RADAR_ORG_LABELS=new Map([
  ['bərdə su meliorasiya və kanalizasiya sahəsi','Bərdə SMSİİ'],
  ['bərdə smks','Bərdə SMSİİ'],
  ['bərdə melioservis və texniki xidmət idarəsi','Bərdə SMSİİ'],
  ['bərdə mstxi','Bərdə SMSİİ'],
  ['yuxarı qarabağ kanalının istismarı idarəsi','Qarabağ SKİİ'],
  ['yqkii','Qarabağ SKİİ'],
  ['yuxarı şirvan kanalının istismarı idarəsi','Şirvan SKİİ'],
  ['yşkii','Şirvan SKİİ'],
  ['işbstx','İSST'],
  ['şuşa smsii','Qarabağ SMSİİ'],
  ['babək smsii','Naxçıvan SMSİİ']
]);
function canonicalRadarOrganizationLabel(value=''){
  const raw=String(value||'').trim();
  if(!raw)return '';
  return LEGACY_RADAR_ORG_LABELS.get(raw.toLocaleLowerCase('az-AZ'))||raw;
}

function readableRadarStage(value=''){
  return String(value||'')
    .replace(/Tam discovery shard\s*\d+/gi,'Tam tarama bölməsi')
    .replace(/Web 2020-indiyə\s*[—-]\s*/gi,'Yeni dövr üzrə internet axtarışı — ')
    .replace(/Web 2000-2019\s*[—-]\s*/gi,'Tarixi arxiv axtarışı — ')
    .replace(/YouTube video və şərh discovery/gi,'Video və şərh axtarışı')
    .replace(/Aktiv təşkilat planını al/gi,'Aktiv təşkilatlar hazırlanır')
    .replace(/Shard yekunu/gi,'Tarama bölməsi tamamlanır')
    .replace(/Google News/gi,'Google Xəbərlər')
    .replace(/sitemap/gi,'sayt xəritəsi')
    .replace(/discovery/gi,'axtarışı')
    .replace(/shard/gi,'bölmə')
    .replace(/GitHub Actions serverində növbə gözlənilir/gi,'Serverdə növbə gözlənilir')
    .replace(/GitHub Actions run yaradılır/gi,'Server tapşırığı yaradılır')
    .replace(/GitHub Actions workflow başladılır/gi,'Tam tarama başladılır')
    .replace(/server-side dispatch/gi,'təhlükəsiz server bağlantısı')
    .replace(/\s+/g,' ').trim();
}
function renderNetworkRadarIdle(){
  const total=document.querySelector('#radar-org-total');
  if(total) total.textContent=String(sortedOrganizations(orgs).filter(o=>['active','grace'].includes(o.service_status)).length);
  const saved=radarStorageRead();
  networkRadarMaxFound=Math.max(0,Number(saved?.max_found||0));
  if(saved?.scan_id && !networkRadarRunning){
    networkRadarScanId=String(saved.scan_id);networkRadarRunId=Number(saved.github_run_id||0);
    networkRadarStartedAt=new Date(saved.scan_started_at||Date.now()).getTime()||Date.now();
    const conclusion=String(saved?.conclusion||'');
    if(!['success','failure','cancelled'].includes(conclusion)){
      setTimeout(()=>startRadarPolling(true),0);
    }else{
      networkRadarMaxFound=Math.max(networkRadarMaxFound,Number(saved?.max_found||0));
      const state=conclusion==='success'?'Tamamlandı':conclusion==='cancelled'?'Dayandırıldı':'Yoxlama bitdi';
      radarSetProgress(saved?.progress_percent??(conclusion==='success'?100:0),saved?.jobs_completed||0,saved?.jobs_total||0,networkRadarMaxFound,saved?.current_job||'Son tam internet axtarışı tamamlanıb',saved?.source_text||'',state,saved?.organization_hits||[]);
      const elapsed=document.querySelector('#radar-elapsed');
      if(elapsed)elapsed.textContent=radarTime(Number(saved?.duration_ms||0)||Math.max(0,Number(saved?.finished_at||Date.now())-networkRadarStartedAt));
      // Ctrl+F5-dən sonra tamamlanmış skanın real telemetriyasını serverdən bir dəfə bərpa et.
      setTimeout(()=>refreshCompletedRadarSnapshot(),0);
    }
  }
}
function radarHash(value=''){let h=2166136261;for(const c of String(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
const RADAR_BLIP_SLOTS=(()=>{
  // Nəticə tapılan təşkilatları bir xəttə yığmamaq üçün 3 halqalı, bucaqları
  // bir-birindən sürüşdürülmüş sabit radar koordinatları. Etiket istiqaməti
  // nöqtədən çölə doğrudur; buna görə həm mərkəzdə, həm də kənarda üst-üstə düşmə azalır.
  const slots=[];
  const addRing=(radius,count,offset)=>{
    for(let i=0;i<count;i++){
      const deg=offset+(360/count)*i, a=deg*Math.PI/180;
      const left=50+Math.cos(a)*radius, top=50+Math.sin(a)*radius;
      slots.push({left,top,angle:a,side:Math.cos(a)<0?'left':'right',vertical:Math.sin(a)<-.55?'up':Math.sin(a)>.55?'down':'mid'});
    }
  };
  addRing(23,6,-72);
  addRing(34,8,-50);
  addRing(43,10,-82);
  return slots;
})();
const RADAR_SEARCH_SLOTS=(()=>{
  const slots=[];for(let i=0;i<7;i++){const a=(-90+i*(360/7))*Math.PI/180;const r=i%2?33:41;slots.push({left:50+Math.cos(a)*r,top:50+Math.sin(a)*r,delay:(i*.24).toFixed(2)});}return slots;
})();
let networkRadarBlipSlots={};
function resetRadarBlipSlots(){networkRadarBlipSlots={};}
function radarBlipPosition(key,usedSlots){
  if(Number.isInteger(networkRadarBlipSlots[key])&&!usedSlots.has(networkRadarBlipSlots[key])){usedSlots.add(networkRadarBlipSlots[key]);return {slot:networkRadarBlipSlots[key],...RADAR_BLIP_SLOTS[networkRadarBlipSlots[key]]};}
  const start=radarHash(key)%RADAR_BLIP_SLOTS.length;
  for(let offset=0;offset<RADAR_BLIP_SLOTS.length;offset++){const slot=(start+offset)%RADAR_BLIP_SLOTS.length;if(!usedSlots.has(slot)){networkRadarBlipSlots[key]=slot;usedSlots.add(slot);return {slot,...RADAR_BLIP_SLOTS[slot]};}}
  return {slot:start,...RADAR_BLIP_SLOTS[start]};
}
function renderRadarOrganizations(items=[]){
  const box=document.querySelector('#radar-blips');if(!box)return;
  const rows=(Array.isArray(items)?items:[]).filter(x=>x?.short_name).slice(0,RADAR_BLIP_SLOTS.length);
  const next={},usedSlots=new Set();
  const searchBlips=RADAR_SEARCH_SLOTS.map((pos,i)=>`<span class="radar-search-blip" style="left:${pos.left}%;top:${pos.top}%;--blink-delay:${pos.delay}s;--blink-index:${i}"><i></i></span>`).join('');
  const hits=rows.map(row=>{
    const key=String(row.organization_id||row.short_name), count=Number(row.count||0), pos=radarBlipPosition(key,usedSlots);
    next[key]=count;
    const fresh=count>Number(networkRadarLastOrgCounts[key]||0);
    const labelSide=pos.side==='left'?' label-left':' label-right';
    const labelVertical=pos.vertical==='up'?' label-up':pos.vertical==='down'?' label-down':' label-mid';
    return `<span class="radar-blip hit${fresh?' fresh':''}${labelSide}${labelVertical}" style="left:${pos.left}%;top:${pos.top}%"><i></i><small>${escapeHtml(row.short_name)}${count>1?` · ${count}`:''}</small></span>`;
  }).join('');
  box.innerHTML=searchBlips+hits;
  networkRadarLastOrgCounts=next;
}

function radarSetProgress(pct,jobsDone,jobsTotal,found,current='',source='',stateLabel='',orgHits=[]){
  const set=(id,v)=>{const e=document.querySelector(id);if(e)e.textContent=String(v)};
  const total=Math.max(0,Number(jobsTotal||0)), done=Math.max(0,Number(jobsDone||0));
  const computed=total?Math.round((done/total)*100):Number(pct||0);
  const safePct=Math.max(0,Math.min(100,computed));
  networkRadarMaxFound=Math.max(networkRadarMaxFound,Number(found||0));
  set('#radar-percent',`${safePct}%`);set('#radar-org-done',`${done}/${total}`);set('#radar-found',networkRadarMaxFound);
  if(current)set('#radar-current-org',readableRadarStage(current));if(source)set('#radar-current-source',source);
  const state=document.querySelector('#radar-state');if(state)state.textContent=stateLabel||(networkRadarRunning?'Skan edilir':safePct===100?'Tamamlandı':'Hazır');
  renderRadarOrganizations(orgHits);
  adminAzerbaijanMap?.refreshRadar?.();
}
function radarStageLabel(stage=''){
  return ({youtube:'YouTube video və şərhlər',web_recent:'Yeni dövr Web axtarışı',web_archive:'Tarixi arxiv Web axtarışı',ai:'AI ələk və söz bankı'})[String(stage)]||String(stage||'Monitorinq');
}
function radarKeywordFlowOrgId(event={}){
  const direct=String(event?.organization_id||'').trim();
  if(direct)return direct;
  const name=canonicalRadarOrganizationLabel(event?.organization||'').trim().toLocaleLowerCase('az-AZ');
  if(!name)return '';
  const found=orgs.find(o=>[o?.name,o?.short_name].some(v=>String(v||'').trim().toLocaleLowerCase('az-AZ')===name));
  return String(found?.id||'');
}
function radarKeywordFlowRows(kind='positive',event={}){
  const orgId=radarKeywordFlowOrgId(event);
  const seen=new Set();
  const rows=[];
  for(const row of allKeywordRows){
    if(keywordBucket(row)!==kind)continue;
    const rowOrg=String(row?.organization_id||'');
    if(rowOrg && rowOrg!==orgId)continue;
    const value=String(row?.value||'').trim(); if(!value)continue;
    const key=value.toLocaleLowerCase('az-AZ'); if(seen.has(key))continue;
    seen.add(key); rows.push({value,scope:rowOrg?'Təşkilat':'Qlobal'});
  }
  return rows;
}
function renderRadarKeywordFlow(events=networkRadarKeywordFlowEvents){
  const positiveBox=document.querySelector('#radar-keyword-positive');
  const excludeBox=document.querySelector('#radar-keyword-exclude');
  if(!positiveBox||!excludeBox)return;
  const list=Array.isArray(events)?events:[];
  const current=list[0]||{};
  const currentOrgId=radarKeywordFlowOrgId(current);
  const sameOrg=list.filter(e=>!currentOrgId||radarKeywordFlowOrgId(e)===currentOrgId);
  const checkedPositive=new Set(sameOrg.map(e=>String(e?.include_term||'').trim().toLocaleLowerCase('az-AZ')).filter(Boolean));
  const checkedExclude=new Set(sameOrg.map(e=>String(e?.exclude_term||'').trim().toLocaleLowerCase('az-AZ')).filter(Boolean));
  const positives=radarKeywordFlowRows('positive',current);
  const excludes=radarKeywordFlowRows('exclude',current);
  const pc=document.querySelector('#radar-keyword-positive-count'); if(pc)pc.textContent=String(positives.length);
  const ec=document.querySelector('#radar-keyword-exclude-count'); if(ec)ec.textContent=String(excludes.length);
  const draw=(box,rows,checked,type)=>{
    if(!rows.length){box.innerHTML='<div class="empty compact">Uyğun söz yoxdur.</div>';return;}
    const take=Math.min(5,rows.length), start=networkRadarKeywordFlowOffset%rows.length;
    const visible=[]; for(let i=0;i<take;i++)visible.push(rows[(start+i)%rows.length]);
    box.innerHTML=visible.map((row,i)=>{
      const done=checked.has(row.value.toLocaleLowerCase('az-AZ'));
      return `<div class="radar-keyword-row ${type}${done?' checked':''}${i===0?' current':''}"><span>${done?'✅':'•'}</span><strong>${escapeHtml(row.value)}</strong><small>${escapeHtml(row.scope)}</small></div>`;
    }).join('');
  };
  draw(positiveBox,positives,checkedPositive,'positive');
  draw(excludeBox,excludes,checkedExclude,'exclude');
}
function startRadarKeywordFlow(events=[]){
  networkRadarKeywordFlowEvents=Array.isArray(events)?events:[];
  renderRadarKeywordFlow(networkRadarKeywordFlowEvents);
  if(networkRadarKeywordFlowTimer)return;
  networkRadarKeywordFlowTimer=setInterval(()=>{
    if(!networkRadarRunning)return;
    networkRadarKeywordFlowOffset++;
    renderRadarKeywordFlow(networkRadarKeywordFlowEvents);
  },1700);
}
function stopRadarKeywordFlow(){
  if(networkRadarKeywordFlowTimer){clearInterval(networkRadarKeywordFlowTimer);networkRadarKeywordFlowTimer=null;}
}
function renderRadarTelemetry(events=[]){
  const box=document.querySelector('#radar-terminal'); if(!box)return;
  const rows=Array.isArray(events)?events:[];
  if(!rows.length)return;
  networkRadarLastTelemetryAt=Date.now();
  networkRadarKeywordFlowEvents=rows;
  startRadarKeywordFlow(rows);
  box.innerHTML=rows.slice(0,24).map((event,i)=>{
    const at=event.created_at?new Date(event.created_at):null;
    const tm=at&&!Number.isNaN(at.getTime())?at.toLocaleTimeString('az-AZ',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'--:--:--';
    return `<div class="radar-terminal-line real${i===0?' current':''}"><span class="terminal-time">${escapeHtml(tm)}</span><span class="terminal-prompt">›</span><div><strong>${escapeHtml(canonicalRadarOrganizationLabel(event.organization)||'Təşkilat')}</strong><small>${escapeHtml(radarStageLabel(event.stage))} • ${escapeHtml(event.district||'Ümumi əhatə')}<br><em>+ ${escapeHtml(event.include_term||'söz bankı rotasiyası')}</em> <i>− ${escapeHtml(event.exclude_term||'filtr bankı')}</i>${event.place?` <u>⌖ ${escapeHtml(event.place)}</u>`:''}</small></div></div>`;
  }).join('');
}
function radarTerminalSample(){
  const box=document.querySelector('#radar-terminal'); if(!box)return;
  const active=sortedOrganizations(orgs).filter(o=>['active','grace'].includes(o.service_status));
  if(!active.length){box.innerHTML='<div class="radar-terminal-line muted">Aktiv təşkilat yoxdur.</div>';return;}
  const org=active[networkRadarTerminalIndex++%active.length];
  const district=String(org?.districts?.name||'Ümumi əhatə');
  const places=placeCatalog.filter(x=>x.is_active!==false&&x.district_id===org.district_id).map(x=>x.name).filter(Boolean);
  const positives=allKeywordRows.filter(x=>keywordBucket(x)==='positive');
  const excludes=allKeywordRows.filter(x=>keywordBucket(x)==='exclude');
  const salt=(networkRadarTerminalIndex*7)%Math.max(1,positives.length);
  const pos=positives.length?positives[salt%positives.length]?.value:'Açar söz bankı yüklənir';
  const neg=excludes.length?excludes[(salt*3)%excludes.length]?.value:'Filtr bankı yüklənir';
  const place=places.length?places[(salt*5)%places.length]:district;
  const line=document.createElement('div'); line.className='radar-terminal-line';
  line.innerHTML=`<span class="terminal-prompt">›</span><div><strong>${escapeHtml(org.name||org.short_name)}</strong><small>${escapeHtml(district)} • məntəqə: ${escapeHtml(place||'—')}<br><em>+ ${escapeHtml(pos||'—')}</em> <i>− ${escapeHtml(neg||'—')}</i></small></div>`;
  box.prepend(line); while(box.children.length>18)box.lastElementChild?.remove();
}
async function loadRadarTelemetryDirect(){
  if(!networkRadarScanId)return [];
  try{
    const {data,error}=await invokeBackend('monitor-worker',{
      mode:'radar_telemetry',
      scan_id:networkRadarScanId,
      scan_started_at:new Date(networkRadarStartedAt||Date.now()-86400000).toISOString(),
      telemetry_limit:24
    });
    if(error||!data?.ok)return [];
    const rows=Array.isArray(data.telemetry)?data.telemetry:[];
    if(rows.length){
      renderRadarTelemetry(rows);
      const current=rows[0];
      const saved=radarStorageRead()||{};
      radarStorageWrite({...saved,current_organization_id:current?.organization_id||saved.current_organization_id||null,current_organization:current?.organization||saved.current_organization||'',telemetry:rows});
    }
    return rows;
  }catch{return [];}
}
function startRadarTelemetryPolling(){
  if(networkRadarTelemetryPollTimer)clearInterval(networkRadarTelemetryPollTimer);
  loadRadarTelemetryDirect();
  networkRadarTelemetryPollTimer=setInterval(()=>{if(networkRadarRunning)loadRadarTelemetryDirect();},8000);
}
function stopRadarTelemetryPolling(){if(networkRadarTelemetryPollTimer){clearInterval(networkRadarTelemetryPollTimer);networkRadarTelemetryPollTimer=null;}stopRadarKeywordFlow();}
function startRadarTerminal(){
  stopRadarTerminal(); networkRadarTerminalIndex=0; networkRadarLastTelemetryAt=Date.now(); const box=document.querySelector('#radar-terminal'); if(box)box.innerHTML='';
  radarTerminalSample();
  networkRadarTerminalTimer=setInterval(()=>{
    if(!networkRadarRunning)return;
    const box=document.querySelector('#radar-terminal');if(!box)return;
    const age=Date.now()-networkRadarLastTelemetryAt;
    if(age<12000)return;
    const now=new Date().toLocaleTimeString('az-AZ',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const line=document.createElement('div');line.className='radar-terminal-line real muted live-heartbeat';
    line.innerHTML=`<span class="terminal-time">${escapeHtml(now)}</span><span class="terminal-prompt">›</span><div><strong>Radar prosesi davam edir</strong><small>Yeni canlı telemetriya hadisəsi gözlənilir.</small></div>`;
    box.prepend(line);while(box.children.length>24)box.lastElementChild?.remove();
    networkRadarLastTelemetryAt=Date.now()-7000;
  },5000);
}
function stopRadarTerminal(){if(networkRadarTerminalTimer){clearInterval(networkRadarTerminalTimer);networkRadarTerminalTimer=null;}}

function radarPlatformText(platforms={}){
  const label=name=>({web:'Veb',youtube:'YouTube','google news':'Google Xəbərlər',facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok',linkedin:'LinkedIn',x:'X'}[String(name).toLowerCase()]||String(name));
  const entries=Object.entries(platforms||{}).filter(([,count])=>Number(count)>0);
  if(!entries.length)return 'Hələ yeni qəbul edilmiş nəticə yoxdur.';
  return entries.map(([name,count])=>`${label(name)}: ${count}`).join(' • ');
}
function radarFeedStatus(data,error=null){
  const feed=document.querySelector('#radar-feed');if(!feed)return;
  if(error) return; // keçici şəbəkə/CORS xətaları radar lentini çirkləndirmir
  if(feed.querySelector('.empty'))feed.innerHTML='';
  const signature=`${data?.status}|${data?.conclusion}|${data?.jobs_completed}|${data?.jobs_total}|${networkRadarMaxFound}|${data?.current_job}`;
  if(signature===networkRadarLastFeedSignature)return;networkRadarLastFeedSignature=signature;
  const row=document.createElement('div');
  const failed=Number(data?.jobs_failed||0)>0&&String(data?.status)==='completed';const hit=networkRadarMaxFound>0;
  row.className=`radar-feed-row ${failed?'error':hit?'hit':''}`;
  const title=readableRadarStage(data?.current_job||'Tam internet axtarışı');
  const detail=`Tamamlanan mərhələ: ${Number(data?.jobs_completed||0)}/${Number(data?.jobs_total||0)} • Yeni: ${networkRadarMaxFound} • ${radarPlatformText(data?.platforms||{})}`;
  row.innerHTML=`<span>${failed?'×':hit?'●':'○'}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div><b>${networkRadarMaxFound}</b>`;
  feed.prepend(row);while(feed.children.length>30)feed.lastElementChild?.remove();
}
function radarSetVisualRunning(running){
  const card=document.querySelector('#network-radar-card'),start=document.querySelector('#network-radar-start'),visual=document.querySelector('#radar-visual');
  card?.classList.toggle('is-scanning',running);visual?.classList.toggle('is-scanning',running);if(start)start.disabled=running;
}
function stopRadarTimers(){if(networkRadarTimer){clearInterval(networkRadarTimer);networkRadarTimer=null}if(networkRadarPollTimer){clearTimeout(networkRadarPollTimer);networkRadarPollTimer=null}stopRadarTerminal();stopRadarTelemetryPolling()}
async function refreshCompletedRadarSnapshot(){
  if(!networkRadarScanId)return;
  const {data,error}=await invokeBackend('monitor-worker',{mode:'radar_status',scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt||Date.now()).toISOString(),include_telemetry:false});
  if(error||!data?.ok)return;
  networkRadarMaxFound=Math.max(networkRadarMaxFound,Number(data.new_mentions||0));
  if(Array.isArray(data.telemetry)&&data.telemetry.length)renderRadarTelemetry(data.telemetry);
  radarFeedStatus(data);
  const currentEvent=Array.isArray(data.telemetry)&&data.telemetry.length?data.telemetry[0]:null;
  const saved=radarStorageRead()||{};
  radarStorageWrite({...saved,scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt||Date.now()).toISOString(),github_run_id:Number(data.github_run_id||networkRadarRunId||0),status:String(data.status||saved.status||''),conclusion:String(data.conclusion||saved.conclusion||''),max_found:networkRadarMaxFound,progress_percent:Number(data.progress_percent||saved.progress_percent||0),jobs_completed:Number(data.jobs_completed||saved.jobs_completed||0),jobs_total:Number(data.jobs_total||saved.jobs_total||0),organization_hits:data.organization_hits||saved.organization_hits||[],current_organization_id:currentEvent?.organization_id||saved.current_organization_id||null,current_organization:currentEvent?.organization||saved.current_organization||'',telemetry:data.telemetry||saved.telemetry||[]});
}

async function pollNetworkRadarStatus(){
  if(!networkRadarScanId)return;
  const {data,error}=await invokeBackend('monitor-worker',{mode:'radar_status',scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt||Date.now()).toISOString(),include_telemetry:false});
  if(error||!data?.ok){
    networkRadarTransientErrors++;
    const msg=String(data?.error||error?.message||'');
    if(/RADAR_GITHUB_TOKEN/i.test(msg)){networkRadarRunning=false;radarSetVisualRunning(false);stopRadarTimers();toast('Radar üçün server icazəsi tamamlanmayıb.','error');return;}
    // Müvəqqəti 403/CORS/520 sorğusu serverdə gedən taramanı dayandırmır.
    const delay=Math.min(90000,30000+networkRadarTransientErrors*12000);
    networkRadarPollTimer=setTimeout(pollNetworkRadarStatus,delay);return;
  }
  networkRadarTransientErrors=0;
  networkRadarRunId=Number(data.github_run_id||networkRadarRunId||0);
  const conclusion=String(data.conclusion||''),status=String(data.status||'waiting');const finished=status==='completed'||Boolean(conclusion);
  const stateLabel=finished?(conclusion==='success'?'Tamamlandı':conclusion==='cancelled'?'Dayandırıldı':'Yoxlama bitdi'):status==='queued'||status==='waiting'?'Növbədə':'Skan edilir';
  const current=finished?(conclusion==='success'?'Tam internet axtarışı tamamlandı':conclusion==='cancelled'?'Skan dayandırıldı':'Tarama tamamlandı, bəzi bölmələr təkrar yoxlanmalıdır'):(data.current_job||'Serverdə növbə gözlənilir');
  const source=`${radarPlatformText(data.platforms||{})}${Number(data.organizations_with_new||0)?` • Nəticə tapılan təşkilat: ${Number(data.organizations_with_new||0)}`:''}`;
  radarSetProgress(data.progress_percent||0,data.jobs_completed||0,data.jobs_total||0,data.new_mentions||0,current,source,stateLabel,data.organization_hits||[]);radarFeedStatus(data);if(Array.isArray(data.telemetry)&&data.telemetry.length){renderRadarTelemetry(data.telemetry);}
  const currentEvent=Array.isArray(data.telemetry)&&data.telemetry.length?data.telemetry[0]:null;
  radarStorageWrite({scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt||Date.now()).toISOString(),github_run_id:networkRadarRunId,status,conclusion,html_url:data.html_url||null,max_found:networkRadarMaxFound,progress_percent:Number(data.progress_percent||0),jobs_completed:Number(data.jobs_completed||0),jobs_total:Number(data.jobs_total||0),current_job:readableRadarStage(current),current_organization_id:currentEvent?.organization_id||null,current_organization:currentEvent?.organization||'',source_text:source,organization_hits:data.organization_hits||[],telemetry:data.telemetry||[],duration_ms:Date.now()-networkRadarStartedAt,finished_at:finished?Date.now():null});
  if(finished){
    networkRadarRunning=false;radarSetVisualRunning(false);stopRadarTimers();const elapsed=document.querySelector('#radar-elapsed');if(elapsed)elapsed.textContent=radarTime(Date.now()-networkRadarStartedAt);await renderBardaStatus();
    if(conclusion==='success')toast(`Tam internet axtarışı tamamlandı. ${networkRadarMaxFound} yeni nəticə aşkarlanıb.`,'success');
    else if(conclusion==='cancelled')toast('Tam internet axtarışı dayandırıldı.','info');
    else toast(`Tam tarama bitdi. ${Number(data.jobs_failed||0)} bölmədə texniki xəbərdarlıq qeydə alındı.`,'info');
    return;
  }
  networkRadarPollTimer=setTimeout(pollNetworkRadarStatus,35000);
}
function startRadarPolling(resume=false){
  if(!networkRadarScanId)return;networkRadarRunning=true;radarSetVisualRunning(true);
  if(!resume){const feed=document.querySelector('#radar-feed');if(feed)feed.innerHTML='';networkRadarLastFeedSignature='';networkRadarMaxFound=0;networkRadarLastOrgCounts={};networkRadarKeywordFlowOffset=0;networkRadarKeywordFlowEvents=[];renderRadarKeywordFlow([]);resetRadarBlipSlots();renderRadarOrganizations([])}
  if(!networkRadarTimer)networkRadarTimer=setInterval(()=>{const e=document.querySelector('#radar-elapsed');if(e)e.textContent=radarTime(Date.now()-(networkRadarStartedAt||Date.now()))},1000);
  startRadarTerminal();
  startRadarTelemetryPolling();
  pollNetworkRadarStatus();
}
async function syncLatestNetworkRadar({announce=false}={}){
  const {data,error}=await invokeBackend('monitor-worker',{mode:'radar_latest'});
  if(error||!data?.ok||!data?.found||!data?.scan_id)return {active:false,error:error||null};
  const status=String(data.status||''),conclusion=String(data.conclusion||'');
  const active=status!=='completed'&&!['success','failure','cancelled'].includes(conclusion);
  if(active){
    networkRadarScanId=String(data.scan_id);networkRadarRunId=Number(data.github_run_id||0);networkRadarStartedAt=new Date(data.scan_started_at||Date.now()).getTime()||Date.now();
    radarStorageWrite({...(radarStorageRead()||{}),scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt).toISOString(),github_run_id:networkRadarRunId,status:status||'queued',conclusion:''});
    if(!networkRadarRunning)startRadarPolling(true);else radarSetVisualRunning(true);
    if(announce)toast('Tam şəbəkə skanı artıq sistemdə işləyir. Cari skan tamamlandıqdan sonra düymə yenidən aktiv olacaq.','info');
  }
  return {active,data,error:null};
}
async function runNetworkRadarScan(){
  if(networkRadarRunning)return;
  const shared=await syncLatestNetworkRadar({announce:true});if(shared.active)return;
  const active=sortedOrganizations(orgs).filter(o=>['active','grace'].includes(o.service_status));if(!active.length)return toast('Skan ediləcək aktiv təşkilat yoxdur.','error');
  const ok=await confirmDialog({title:'Tam internet axtarışı başlasın?',message:`${active.length} aktiv təşkilat üzrə video platformaları, xəbər mənbələri, RSS, birbaşa saytlar və tarixi arxiv mərhələli şəkildə yoxlanacaq. Proses bir neçə saat çəkə bilər və səhifəni bağlasanız da serverdə davam edəcək.`,confirmText:'Bəli, tam skanı başlat',cancelText:'Xeyr'});if(!ok)return;
  const scanId=`radar-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;radarSetVisualRunning(true);
  const state=document.querySelector('#radar-state');if(state)state.textContent='Başladılır';const current=document.querySelector('#radar-current-org');if(current)current.textContent='Tam tarama başladılır…';const source=document.querySelector('#radar-current-source');if(source)source.textContent='Təhlükəsiz server bağlantısı hazırlanır.';
  const {data,error}=await invokeBackend('monitor-worker',{mode:'radar_dispatch',scan_id:scanId});
  if(error||!data?.ok){radarSetVisualRunning(false);const msg=String(data?.error||error?.message||'Radar başladılmadı.');if(data?.setup_required||/RADAR_GITHUB_TOKEN/i.test(msg))toast('Tam Radar üçün server icazəsi hələ tamamlanmayıb.','error');else toast(msg,'error');return;}
  networkRadarScanId=String(data.scan_id||scanId);networkRadarStartedAt=new Date(data.scan_started_at||Date.now()).getTime()||Date.now();networkRadarRunId=0;networkRadarMaxFound=0;
  radarStorageWrite({scan_id:networkRadarScanId,scan_started_at:new Date(networkRadarStartedAt).toISOString(),github_run_id:0,status:'queued',conclusion:'',max_found:0});
  radarSetProgress(0,0,0,0,'Tam internet axtarışı növbəyə alındı','Server tapşırığı yaradılır…','Növbədə',[]);startRadarPolling(false);toast('Tam internet axtarışı başladıldı. Səhifəni bağlasanız da proses davam edəcək.','success');
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
document.querySelector('#district-form').onsubmit = async e => {
  e.preventDefault();
  const name = document.querySelector('#district-name').value.trim();
  if (districts.some(d => normalizeLocationSearch(d.name) === normalizeLocationSearch(name))) return toast('Bu rayon / şəhər artıq kataloqda var.', 'error');
  const { error } = await supabase.from('districts').insert({name});
  toast(error ? error.message : 'Ərazi əlavə edildi', error ? 'error' : 'success');
  if (!error) { e.target.reset(); await refresh(); }
};
document.querySelector('#village-form').onsubmit = async e => {
  e.preventDefault();
  const districtId = document.querySelector('#village-district').value;
  const name = document.querySelector('#village-name').value.trim();
  const placeType = document.querySelector('#village-type')?.value || 'kənd';
  const duplicate = placeCatalog.some(x => x.district_id === districtId && normalizeLocationSearch(x.name) === normalizeLocationSearch(name));
  if (duplicate) return toast('Bu yaşayış məntəqəsi seçilən ərazidə artıq var.', 'error');
  let result = await supabase.from('place_catalog').insert({district_id:districtId,name,place_type:placeType,is_official:false,is_active:true});
  if (result.error && isMissingPlaceCatalogError(result.error)) {
    result = await supabase.from('villages').insert({district_id:districtId,name});
  }
  toast(result.error ? result.error.message : 'Yaşayış məntəqəsi əlavə edildi', result.error ? 'error' : 'success');
  if (!result.error) { e.target.reset(); await refresh(); }
};
document.querySelector('#keyword-form').onsubmit = async e => {
  e.preventDefault();
  const value=document.querySelector('#keyword-value').value.trim();
  if (!value) return;
  if(globalKeywordExists(value,'positive')) return toast('Bu qlobal açar söz artıq mövcuddur.','info');
  const { error } = await supabase.from('keywords').insert({organization_id:null,value,kind:'phrase',is_active:true});
  toast(error?.code==='23505'?'Bu qlobal açar söz artıq mövcuddur.':(error?.message||'Qlobal açar söz əlavə edildi'),error?'error':'success');
  if(!error){e.target.reset();await refresh();}
};
document.querySelector('#exclude-form').onsubmit = async e => {
  e.preventDefault();
  const value = document.querySelector('#exclude-value').value.trim();
  if (!value) return;
  if(globalKeywordExists(value,'exclude')) return toast('Bu qlobal filtr artıq mövcuddur.','info');
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
adminAzerbaijanMap=await initAzerbaijanMonitoringMap({rootId:'admin-azerbaijan-live-map',profile:ctx.profile,allowScan:false,serverSync:false});
await syncLatestNetworkRadar().catch(()=>({active:false}));
route();
