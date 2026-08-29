import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, getCachedProfile, showPageLoader, hidePageLoader, toast } from './core.js';
import { applyOrganizationScope, setupOrganizationFilter, loadGlobalExcludes, filterExcludedMentions } from './scope.js';
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'reports'); showPageLoader();
const c=await requireAuth(); if(!c) throw new Error('auth'); renderShell(c.profile,'reports'); hidePageLoader();
const organizationFilter=document.querySelector('#organization-filter');
const globalExcludes=await loadGlobalExcludes();
await setupOrganizationFilter(c.profile, organizationFilter);
const from=document.querySelector('#from'),to=document.querySelector('#to'),period=document.querySelector('#report-period');
function ymd(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function setPeriod(v){
  const now=new Date();let start=new Date(now);
  if(v==='today') start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  else if(v==='month') start=new Date(now.getFullYear(),now.getMonth(),1);
  else if(v==='6m') start.setMonth(start.getMonth()-6);
  else if(v==='1y') start.setFullYear(start.getFullYear()-1);
  else if(v==='10y') start.setFullYear(start.getFullYear()-10);
  else if(v==='all') start=new Date(2000,0,1);
  if(v!=='custom'){from.value=ymd(start);to.value=ymd(now)}
}
setPeriod('month');
function rangeIso(){
  const start=new Date(from.value+'T00:00:00');
  const end=new Date(to.value+'T23:59:59.999');
  return [start.toISOString(),end.toISOString()];
}
function normalizeStoryTitle(v=''){return String(v||'').toLocaleLowerCase('az-AZ').normalize('NFKD').replace(/[əƏ]/g,'e').replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[çÇ]/g,'c').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ğĞ]/g,'g').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function storyKey(x){const p=String(x?.source_platform||'').toLowerCase();if(p==='web'||p==='google news'){const t=normalizeStoryTitle(x?.title||'');const d=String(x?.published_at||x?.detected_at||'').slice(0,10);if(t.length>=18)return `web|${t}|${d}`;}return `id|${x?.id||x?.content_hash||x?.source_url||''}`;}
function dedupeRows(data){const seen=new Set();const out=[];for(const x of data){const k=storyKey(x);if(seen.has(k))continue;seen.add(k);out.push(x);}return out;}
async function loadBreakdown(){
  const [a,b]=rangeIso(); const out=[]; const size=1000;
  for(let page=0;page<100;page++){
    let q=supabase.from('mentions').select('id,title,source_url,content_hash,source_platform,priority_score,sentiment,published_at,detected_at,organization_id').gt('relevance_score',0).or(`and(published_at.gte.${a},published_at.lte.${b}),and(published_at.is.null,detected_at.gte.${a},detected_at.lte.${b})`).order('published_at',{ascending:false,nullsFirst:false}).order('detected_at',{ascending:false}).range(page*size,page*size+size-1);
    q=applyOrganizationScope(q,c.profile,organizationFilter?.value||'');
    const r=await q;
    if(r.error)throw r.error; const batch=r.data||[];out.push(...batch);if(batch.length<size)break;
  }
  return dedupeRows(filterExcludedMentions(out,globalExcludes));
}
async function load(){
  showPageLoader();
  try{
    const data=await loadBreakdown();
    const total=data.length;
    const neg=data.filter(x=>x.sentiment==='negative').length;
    const pos=data.filter(x=>x.sentiment==='positive').length;
    const critical=data.filter(x=>Number(x.priority_score||0)>=81).length;
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Kritik',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms={};data.forEach(x=>{const key=String(x.source_platform||'Web').toLowerCase()==='youtube'?'YouTube':'Web';platforms[key]=(platforms[key]||0)+1});
    document.querySelector('#platforms').innerHTML=Object.entries(platforms).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const score=x=>Number(x.priority_score||0);const buckets=[['81–100',data.filter(x=>score(x)>=81).length],['61–80',data.filter(x=>score(x)>=61&&score(x)<81).length],['31–60',data.filter(x=>score(x)>=31&&score(x)<61).length],['0–30',data.filter(x=>score(x)<31).length]];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
if(organizationFilter) organizationFilter.onchange=load;period.onchange=()=>{setPeriod(period.value);if(period.value!=='custom')load()};from.onchange=()=>period.value='custom';to.onchange=()=>period.value='custom';document.querySelector('#apply').onclick=load;load();
