import { supabase, escapeHtml, fmtDate, toast, confirmDialog } from './core.js';

const MAP_URL='https://raw.githubusercontent.com/stephanietuerk/admin-boundaries/master/lo-res/Admin2_simp05/gadm36_AZE_2.json';
const RADAR_KEY='media_monitorinq_full_radar_v2';
const GEO_CACHE_KEY='mm.az.districts.geojson.v2';
const ACTIVE_STATUSES=new Set(['active','grace']);

const fold=v=>String(v||'').normalize('NFKC').toLocaleLowerCase('az-AZ').replace(/rayonu|şəhəri|şəhər|rayon/g,'').replace(/[^a-z0-9əğıöşüç]+/g,' ').replace(/\s+/g,' ').trim();
const nameAliases=new Map(Object.entries({
  'xanlar':'göygöl','hajigabul':'hacıqabul','lankaran city':'lənkəran','lankaran':'lənkəran','lachin':'laçın','kangarli':'kəngərli','qubadli':'qubadlı','shaki':'şəki','shirvan':'şirvan','yevlakh':'yevlax','stepanakert':'xankəndi','dəvəçi':'şabran','əli bayramlı':'şirvan','ali bayramli':'şirvan','xızı':'xızı','xizı':'xızı'
}).map(([a,b])=>[fold(a),fold(b)]));
const normName=v=>nameAliases.get(fold(v))||fold(v);

function radarRead(){try{return JSON.parse(localStorage.getItem(RADAR_KEY)||'null')}catch{return null}}
function radarWrite(value){try{localStorage.setItem(RADAR_KEY,JSON.stringify(value||{}))}catch{}}
function radarFinished(saved){return ['success','failure','cancelled'].includes(String(saved?.conclusion||''));}
function platformLabel(v=''){
  const s=String(v||'').toLowerCase();
  if(s.includes('youtube'))return 'YouTube';
  if(s.includes('facebook'))return 'Facebook';
  if(s.includes('instagram'))return 'Instagram';
  if(s.includes('tiktok'))return 'TikTok';
  if(s.includes('telegram'))return 'Telegram';
  if(s.includes('rss'))return 'RSS';
  if(s.includes('web')||s.includes('google news'))return 'Web';
  return String(v||'Digər').trim()||'Digər';
}
async function invokeBackend(body){
  const call=async(refresh=false)=>{
    let session=(await supabase.auth.getSession()).data?.session||null;
    if(refresh || (session?.expires_at && session.expires_at*1000-Date.now()<120000)) session=(await supabase.auth.refreshSession()).data?.session||session;
    return supabase.functions.invoke('monitor-worker',{body,headers:session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{}});
  };
  let result=await call(false).catch(error=>({data:null,error}));
  let status=Number(result.error?.context?.status||result.error?.status||0);
  if(result.error&&(status===401||status===403||/jwt|unauthorized|forbidden/i.test(String(result.error?.message||'')))){
    result=await call(true).catch(error=>({data:null,error}));
  }
  if(result.error && /failed to fetch|failed to send|network|cors|load failed/i.test(String(result.error?.message||''))){
    await new Promise(r=>setTimeout(r,900));
    result=await call(false).catch(error=>({data:null,error}));
    if(result.error){await new Promise(r=>setTimeout(r,1500));result=await call(false).catch(error=>({data:null,error}));}
  }
  return result;
}

async function loadGeo(){
  try{
    const cached=localStorage.getItem(GEO_CACHE_KEY);
    if(cached){const parsed=JSON.parse(cached);if(parsed?.features?.length)return parsed;}
  }catch{}
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const res=await fetch(MAP_URL,{cache:'force-cache',mode:'cors',credentials:'omit',signal:controller.signal});
    if(!res.ok)throw new Error(`Azərbaycan xəritəsi yüklənmədi (${res.status})`);
    const geo=await res.json();
    if(!geo?.features?.length)throw new Error('Azərbaycan xəritəsi boş qaytarıldı');
    try{localStorage.setItem(GEO_CACHE_KEY,JSON.stringify(geo))}catch{}
    return geo;
  }finally{clearTimeout(timer);}
}

function featureName(feature){
  return feature?.properties?.name||feature?.properties?.NAME_2||feature?.properties?.NAME_1||'';
}
function featureCode(feature){
  return feature?.properties?.id||feature?.properties?.GID_2||feature?.properties?.HASC_2||feature?.id||'';
}

function allCoordinates(geometry){
  if(!geometry)return [];
  if(geometry.type==='Polygon')return geometry.coordinates.flat();
  if(geometry.type==='MultiPolygon')return geometry.coordinates.flat(2);
  return [];
}
function geometryPaths(geometry,project){
  const polygon=coords=>coords.map(r=>r.length?`M${r.map(([x,y])=>project(x,y).join(',')).join('L')}Z`:'').join('');
  if(geometry?.type==='Polygon')return polygon(geometry.coordinates);
  if(geometry?.type==='MultiPolygon')return geometry.coordinates.map(polygon).join('');
  return '';
}
function createSvg(geo){
  const coords=geo.features.flatMap(f=>allCoordinates(f.geometry));
  const xs=coords.map(c=>c[0]),ys=coords.map(c=>c[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const W=920,H=520,pad=18;const sx=(W-pad*2)/(maxX-minX),sy=(H-pad*2)/(maxY-minY),scale=Math.min(sx,sy);
  const ox=(W-(maxX-minX)*scale)/2,oy=(H-(maxY-minY)*scale)/2;
  const project=(x,y)=>[(ox+(x-minX)*scale).toFixed(1),(H-(oy+(y-minY)*scale)).toFixed(1)];
  return `<svg class="az-live-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Azərbaycan üzrə monitorinq xəritəsi">${geo.features.map(f=>`<path class="az-region" data-map-name="${escapeHtml(featureName(f))}" data-map-code="${escapeHtml(featureCode(f))}" d="${geometryPaths(f.geometry,project)}" tabindex="0"/>`).join('')}</svg>`;
}

async function loadMapData(){
  const [orgRes,distRes]=await Promise.all([
    supabase.from('organizations').select('*').order('name'),
    supabase.from('districts').select('id,name').order('name')
  ]);
  if(orgRes.error)throw orgRes.error;if(distRes.error)throw distRes.error;
  const orgs=orgRes.data||[],districts=distRes.data||[];
  const counts=new Map(),latest=new Map();
  for(let from=0;from<20000;from+=1000){
    const {data,error}=await supabase.from('mentions').select('organization_id,source_platform,detected_at,relevance_score').gt('relevance_score',0).order('detected_at',{ascending:false}).range(from,from+999);
    if(error)throw error;const rows=data||[];
    for(const m of rows){
      if(!m.organization_id)continue;
      const key=`${m.organization_id}|${platformLabel(m.source_platform)}`;counts.set(key,(counts.get(key)||0)+1);
      if(!latest.has(m.organization_id))latest.set(m.organization_id,m.detected_at);
    }
    if(rows.length<1000)break;
  }
  return {orgs,districts,counts,latest};
}

function organizationMapDistrictId(org){
  return org?.location_district_id || org?.district_id || null;
}

function radarHitsByDistrict(saved,orgs){
  const out=new Map();
  const byId=new Map(orgs.map(o=>[String(o.id),o]));
  for(const hit of saved?.organization_hits||[]){
    const org=byId.get(String(hit.organization_id));const districtId=organizationMapDistrictId(org);if(!districtId)continue;
    out.set(String(districtId),(out.get(String(districtId))||0)+Number(hit.count||0));
  }
  return out;
}

export async function initAzerbaijanMonitoringMap({rootId='azerbaijan-live-map',profile=null,allowScan=false}={}){
  const root=document.getElementById(rootId);if(!root)return null;
  root.innerHTML='<div class="az-map-loading">Azərbaycan üzrə monitorinq xəritəsi hazırlanır…</div>';
  let geo,data;
  try{[geo,data]=await Promise.all([loadGeo(),loadMapData()]);}
  catch(error){console.warn(error);root.innerHTML='<div class="empty">Xəritə məlumatı hazırda yüklənmədi. Səhifəni yenilədikdə yenidən yoxlanacaq.</div>';return null;}
  const {orgs,districts,counts,latest}=data;
  const districtByNorm=new Map(districts.map(d=>[normName(d.name),d]));
  const orgsByDistrict=new Map();
  for(const o of orgs){const districtId=organizationMapDistrictId(o);if(!districtId)continue;const key=String(districtId);if(!orgsByDistrict.has(key))orgsByDistrict.set(key,[]);orgsByDistrict.get(key).push(o);}

  root.innerHTML=`<div class="az-map-layout"><div class="az-map-stage"><div class="az-map-toolbar"><div><span class="eyebrow">Azərbaycan üzrə canlı monitorinq</span><h2>Ərazi Aktivlik Xəritəsi</h2><p>Rayonun üzərinə gəl və ya toxun — təşkilatlar və mənbə nəticələri açılacaq.</p></div>${allowScan?'<button class="btn az-map-scan" type="button" data-map-scan>Tam şəbəkəni skan et</button>':''}</div><div class="az-map-kpis" data-map-kpis></div><div class="az-map-svg-wrap"><div class="az-map-scan-beam" aria-hidden="true"></div>${createSvg(geo)}<div class="az-map-tooltip" data-map-tooltip hidden></div><div class="az-map-brand" aria-hidden="true">ADSEA</div></div><div class="az-map-legend"><span><i class="idle"></i>Nəticə yoxdur</span><span><i class="has"></i>Nəticə var</span><span><i class="live"></i>Son skanda yeni nəticə</span></div><small class="az-map-credit">İnzibati sərhəd məlumatı: GADM 3.6 xəritə datası (GitHub mirror).</small></div><aside class="az-map-detail" data-map-detail><div class="az-map-detail-empty"><strong>Rayon seçin</strong><span>Təşkilatların tam adları və mənbə sayları burada göstəriləcək.</span></div></aside></div>`;

  const paths=[...root.querySelectorAll('.az-region')];
  const tooltip=root.querySelector('[data-map-tooltip]'),detail=root.querySelector('[data-map-detail]'),kpis=root.querySelector('[data-map-kpis]'),scanBtn=root.querySelector('[data-map-scan]');
  let selectedPath=null,pollTimer=null,serverSyncTimer=null;

  function districtInfo(path){
    const mapName=path?.dataset?.mapName||'';const district=districtByNorm.get(normName(mapName));
    const rows=district?orgsByDistrict.get(String(district.id))||[]:[];
    return {mapName,district,rows};
  }
  function orgSources(o){
    const names=['Web','YouTube','Facebook','Instagram','TikTok','Telegram','RSS'];
    const rows=names.map(name=>[name,counts.get(`${o.id}|${name}`)||0]).filter(([,n])=>n>0);
    return rows.length?rows:[['Web',0]];
  }
  function renderDetail(path){
    const {mapName,district,rows}=districtInfo(path);if(!detail)return;
    const saved=radarRead(),hitMap=radarHitsByDistrict(saved,orgs),hit=district?Number(hitMap.get(String(district.id))||0):0;
    const total=rows.reduce((sum,o)=>sum+orgSources(o).reduce((s,[,n])=>s+n,0),0);
    detail.innerHTML=`<div class="az-map-detail-head"><div><span class="eyebrow">Seçilən ərazi</span><h3>${escapeHtml(district?.name||mapName||'Ərazi')}</h3><p>${rows.length} təşkilat · ${total} məlumat${hit?` · <b>son skanda +${hit}</b>`:''}</p></div></div><div class="az-org-list">${rows.length?rows.map(o=>`<article class="az-org-row"><div class="az-org-title"><strong>${escapeHtml(o.name||o.short_name||'Təşkilat')}</strong>${o.service_status&&!ACTIVE_STATUSES.has(o.service_status)?`<small>${escapeHtml(o.service_status)}</small>`:''}</div><small class="az-org-address">${escapeHtml(o.address_text || 'Rəsmi ünvan bazaya daxil edilməyib')}</small><div class="az-source-chips">${orgSources(o).map(([name,n])=>`<span class="az-source-chip${n?' has-result':''}">${escapeHtml(name)} · ${n}</span>`).join('')}</div><small class="az-org-last">Son aşkarlanma: ${escapeHtml(fmtDate(latest.get(o.id)))}</small></article>`).join(''):'<div class="empty compact">Bu əraziyə bazada təşkilat bağlanmayıb.</div>'}</div>`;
  }
  function showTooltip(path,event){
    if(!tooltip)return;const {mapName,district,rows}=districtInfo(path);const saved=radarRead(),hits=radarHitsByDistrict(saved,orgs),hit=district?hits.get(String(district.id))||0:0;
    tooltip.innerHTML=`<strong>${escapeHtml(district?.name||mapName)}</strong><span>${rows.length} təşkilat${hit?` · son skan +${hit}`:''}</span>`;tooltip.hidden=false;
    const box=root.querySelector('.az-map-svg-wrap').getBoundingClientRect();const x=(event?.clientX??box.left+box.width/2)-box.left,y=(event?.clientY??box.top+20)-box.top;
    tooltip.style.left=`${Math.max(8,Math.min(box.width-180,x+12))}px`;tooltip.style.top=`${Math.max(8,Math.min(box.height-64,y+12))}px`;
  }
  function refreshVisuals(){
    const saved=radarRead();const hits=radarHitsByDistrict(saved,orgs);const running=Boolean(saved?.scan_id&&!radarFinished(saved));
    const currentOrgId=String(saved?.current_organization_id||'');
    const currentOrg=currentOrgId?orgs.find(o=>String(o.id)===currentOrgId):null;
    const currentDistrictId=currentOrg?String(organizationMapDistrictId(currentOrg)||''):'';
    root.classList.toggle('is-radar-scanning',running);
    let activeDistricts=0;
    const allResults=orgs.reduce((sum,o)=>sum+orgSources(o).reduce((s,[,n])=>s+n,0),0);
    const unlocated=orgs.filter(o=>ACTIVE_STATUSES.has(o.service_status)&&!organizationMapDistrictId(o)).length;
    for(const path of paths){
      const {district,rows}=districtInfo(path);const total=rows.reduce((sum,o)=>sum+orgSources(o).reduce((s,[,n])=>s+n,0),0);
      const hit=district?Number(hits.get(String(district.id))||0):0;path.classList.toggle('has-results',total>0);path.classList.toggle('radar-hit',hit>0);path.classList.toggle('is-scanning',running&&hit>0);path.classList.toggle('is-current-scan',running&&district&&String(district.id)===currentDistrictId);if(total>0)activeDistricts++;
    }
    if(kpis)kpis.innerHTML=`<span><b>${districts.length}</b><small>Ərazi</small></span><span><b>${orgs.filter(o=>ACTIVE_STATUSES.has(o.service_status)).length}</b><small>Aktiv təşkilat</small></span><span><b>${activeDistricts}</b><small>Nəticəli ərazi</small></span><span><b>${allResults}</b><small>Yüklənən nəticə</small></span><span class="${unlocated?'needs-location':''}"><b>${unlocated}</b><small>Yerləşməsi yoxdur</small></span>`;
    if(scanBtn){scanBtn.disabled=running;scanBtn.textContent=running?`Şəbəkə skan edilir${saved?.progress_percent!=null?` · ${Math.round(Number(saved.progress_percent)||0)}%`:''}`:'Tam şəbəkəni skan et';}
    if(selectedPath)renderDetail(selectedPath);
  }
  paths.forEach(path=>{
    path.addEventListener('mouseenter',e=>showTooltip(path,e));path.addEventListener('mousemove',e=>showTooltip(path,e));path.addEventListener('mouseleave',()=>{if(tooltip)tooltip.hidden=true;});
    const select=()=>{selectedPath?.classList.remove('selected');selectedPath=path;path.classList.add('selected');renderDetail(path);};
    path.addEventListener('click',select);path.addEventListener('focus',e=>{select();showTooltip(path,e);});path.addEventListener('blur',()=>{if(tooltip)tooltip.hidden=true;});
  });

  async function pollRadar(){
    const saved=radarRead();if(!saved?.scan_id||radarFinished(saved)){refreshVisuals();return;}
    const {data:status,error}=await invokeBackend({mode:'radar_status',scan_id:saved.scan_id,scan_started_at:saved.scan_started_at});
    if(!error&&status){
      const conclusion=String(status.conclusion||'');const finished=String(status.status||'')==='completed'||['success','failure','cancelled'].includes(conclusion);
      const currentEvent=Array.isArray(status.telemetry)&&status.telemetry.length?status.telemetry[0]:null;
      radarWrite({...saved,github_run_id:Number(status.github_run_id||saved.github_run_id||0),status:String(status.status||saved.status||''),conclusion,progress_percent:Number(status.progress_percent||0),jobs_completed:Number(status.jobs_completed||0),jobs_total:Number(status.jobs_total||0),max_found:Math.max(Number(saved.max_found||0),Number(status.new_mentions||0)),organization_hits:status.organization_hits||saved.organization_hits||[],current_job:status.current_job||saved.current_job||'',current_organization_id:currentEvent?.organization_id||saved.current_organization_id||null,current_organization:currentEvent?.organization||saved.current_organization||'',source_text:saved.source_text||'',finished_at:finished?Date.now():null});
      refreshVisuals();
    }
    if(!radarFinished(radarRead())){if(pollTimer)clearTimeout(pollTimer);pollTimer=setTimeout(pollRadar,65000);}
  }

  async function syncLatestRadar({announce=false}={}){
    const {data:latest,error}=await invokeBackend({mode:'radar_latest'});
    if(error||!latest?.ok||!latest?.found||!latest?.scan_id)return {active:false,error:error||null};
    const local=radarRead();
    const latestStarted=new Date(latest.scan_started_at||0).getTime()||0;
    const localStarted=new Date(local?.scan_started_at||0).getTime()||0;
    const latestActive=!['completed'].includes(String(latest.status||''))&&!['success','failure','cancelled'].includes(String(latest.conclusion||''));
    if(!local?.scan_id || String(local.scan_id)!==String(latest.scan_id) || latestStarted>=localStarted){
      radarWrite({...(String(local?.scan_id)===String(latest.scan_id)?local:{}),scan_id:String(latest.scan_id),scan_started_at:latest.scan_started_at||new Date().toISOString(),github_run_id:Number(latest.github_run_id||0),status:String(latest.status||'waiting'),conclusion:String(latest.conclusion||''),max_found:String(local?.scan_id)===String(latest.scan_id)?Number(local?.max_found||0):0,progress_percent:String(local?.scan_id)===String(latest.scan_id)?Number(local?.progress_percent||0):0,organization_hits:String(local?.scan_id)===String(latest.scan_id)?(local?.organization_hits||[]):[]});
      refreshVisuals();
      const {data:status}=await invokeBackend({mode:'radar_status',scan_id:String(latest.scan_id),scan_started_at:latest.scan_started_at||new Date().toISOString()});
      if(status?.ok){
        const currentSaved=radarRead()||{};const conclusion=String(status.conclusion||latest.conclusion||'');
        const finished=String(status.status||latest.status||'')==='completed'||['success','failure','cancelled'].includes(conclusion);
        const currentEvent=Array.isArray(status.telemetry)&&status.telemetry.length?status.telemetry[0]:null;
        radarWrite({...currentSaved,status:String(status.status||latest.status||currentSaved.status||''),conclusion,progress_percent:Number(status.progress_percent||0),jobs_completed:Number(status.jobs_completed||0),jobs_total:Number(status.jobs_total||0),max_found:Math.max(Number(currentSaved.max_found||0),Number(status.new_mentions||0)),organization_hits:status.organization_hits||currentSaved.organization_hits||[],current_job:status.current_job||currentSaved.current_job||'',current_organization_id:currentEvent?.organization_id||currentSaved.current_organization_id||null,current_organization:currentEvent?.organization||currentSaved.current_organization||'',finished_at:finished?(currentSaved.finished_at||Date.now()):null});
        refreshVisuals();
      }
      if(latestActive&&!radarFinished(radarRead())){if(pollTimer)clearTimeout(pollTimer);pollTimer=setTimeout(pollRadar,65000);}
    }
    if(announce&&latestActive)toast('Tam şəbəkə skanı artıq sistemdə işləyir. Cari skanın vəziyyəti xəritədə göstərilir.','info');
    return {active:latestActive,latest};
  }

  if(scanBtn){scanBtn.addEventListener('click',async()=>{
    const current=radarRead();if(current?.scan_id&&!radarFinished(current)){toast('Tam şəbəkə skanı artıq işləyir. Cari skanın vəziyyəti xəritədə göstərilir.','info');return pollRadar();}
    const shared=await syncLatestRadar({announce:true});if(shared.active)return;
    const active=orgs.filter(o=>ACTIVE_STATUSES.has(o.service_status));
    const ok=await confirmDialog({title:'Tam internet axtarışı başlasın?',message:`${active.length} aktiv təşkilat üzrə qlobal radar skanı başladılacaq. Proses səhifə bağlansa da serverdə davam edəcək.`,confirmText:'Bəli, tam skanı başlat',cancelText:'Xeyr'});if(!ok)return;
    scanBtn.disabled=true;scanBtn.textContent='Skan başladılır…';const scanId=`radar-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const {data:res,error}=await invokeBackend({mode:'radar_dispatch',scan_id:scanId});
    if(error||!res?.ok){scanBtn.disabled=false;scanBtn.textContent='Tam şəbəkəni skan et';return toast(res?.error||error?.message||'Radar başladılmadı.','error');}
    const started=res.scan_started_at||new Date().toISOString();radarWrite({scan_id:String(res.scan_id||scanId),scan_started_at:started,github_run_id:0,status:'queued',conclusion:'',max_found:0,progress_percent:0,organization_hits:[]});
    refreshVisuals();pollRadar();toast('Tam şəbəkə skanı başladıldı. Səhifəni bağlasanız da proses davam edəcək.','success');
  });}

  refreshVisuals();
  const saved=radarRead();if(saved?.scan_id&&!radarFinished(saved))pollRadar();
  syncLatestRadar().catch(()=>{});
  serverSyncTimer=setInterval(()=>syncLatestRadar().catch(()=>{}),60000);
  window.addEventListener('storage',e=>{if(e.key===RADAR_KEY)refreshVisuals();});
  return {refreshRadar:refreshVisuals,refreshData:()=>initAzerbaijanMonitoringMap({rootId,profile,allowScan}),destroy:()=>{if(pollTimer)clearTimeout(pollTimer);if(serverSyncTimer)clearInterval(serverSyncTimer);}};
}
