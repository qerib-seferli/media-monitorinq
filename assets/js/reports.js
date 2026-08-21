import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, getCachedProfile, showPageLoader, hidePageLoader, toast } from './core.js';
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'reports'); showPageLoader();
const c=await requireAuth(); if(!c) throw new Error('auth'); renderShell(c.profile,'reports'); hidePageLoader();
const from=document.querySelector('#from'),to=document.querySelector('#to'),period=document.querySelector('#report-period');
function ymd(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function setPeriod(v){const now=new Date();let start=new Date(now);if(v==='today')start=new Date(now.getFullYear(),now.getMonth(),now.getDate());else if(v==='month')start=new Date(now.getFullYear(),now.getMonth(),1);else if(v!=='custom'){const m={'3m':3,'6m':6,'9m':9,'1y':12,'2y':24,'3y':36,'4y':48,'5y':60}[v]||1;start.setMonth(start.getMonth()-m)}if(v!=='custom'){from.value=ymd(start);to.value=ymd(now)}}
setPeriod('month');
async function load(){
  showPageLoader();
  try{
    const start=new Date(from.value+'T00:00:00');const end=new Date(to.value+'T23:59:59.999');
    const {data=[],error}=await supabase.from('mentions').select('source_platform,sentiment,priority_score,published_at').gte('published_at',start.toISOString()).lte('published_at',end.toISOString());
    if(error)throw error;
    const total=data.length,neg=data.filter(x=>x.sentiment==='negative').length,pos=data.filter(x=>x.sentiment==='positive').length,critical=data.filter(x=>Number(x.priority_score)>=81).length;
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Kritik',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms={};data.forEach(x=>{const key=String(x.source_platform||'Web').toLowerCase()==='youtube'?'YouTube':(x.source_platform||'Web');platforms[key]=(platforms[key]||0)+1});
    document.querySelector('#platforms').innerHTML=Object.entries(platforms).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const score=x=>Number(x.priority_score||0);const buckets=[['81–100',data.filter(x=>score(x)>=81).length],['61–80',data.filter(x=>score(x)>=61&&score(x)<81).length],['31–60',data.filter(x=>score(x)>=31&&score(x)<61).length],['0–30',data.filter(x=>score(x)<31).length]];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
period.onchange=()=>{setPeriod(period.value);if(period.value!=='custom')load()};from.onchange=()=>period.value='custom';to.onchange=()=>period.value='custom';document.querySelector('#apply').onclick=load;load();
