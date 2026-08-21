import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, getCachedProfile, showPageLoader, hidePageLoader, toast } from './core.js';
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'reports'); showPageLoader();
const c=await requireAuth(); if(!c) throw new Error('auth'); renderShell(c.profile,'reports'); hidePageLoader();
const from=document.querySelector('#from'),to=document.querySelector('#to');
const now=new Date(),month=new Date(now.getFullYear(),now.getMonth(),1);from.value=month.toISOString().slice(0,10);to.value=now.toISOString().slice(0,10);
async function load(){
  showPageLoader();
  try{
    const {data=[],error}=await supabase.from('mentions').select('source_platform,sentiment,priority_score').gte('detected_at',new Date(from.value+'T00:00:00').toISOString()).lte('detected_at',new Date(to.value+'T23:59:59').toISOString());
    if(error) throw error;
    const total=data.length,neg=data.filter(x=>x.sentiment==='negative').length,pos=data.filter(x=>x.sentiment==='positive').length,critical=data.filter(x=>x.priority_score>=81).length;
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Kritik',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms={};data.forEach(x=>platforms[x.source_platform||'Web']=(platforms[x.source_platform||'Web']||0)+1);
    document.querySelector('#platforms').innerHTML=Object.entries(platforms).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const buckets=[['81–100',data.filter(x=>x.priority_score>=81).length],['61–80',data.filter(x=>x.priority_score>=61&&x.priority_score<81).length],['31–60',data.filter(x=>x.priority_score>=31&&x.priority_score<61).length],['0–30',data.filter(x=>x.priority_score<31).length]];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
document.querySelector('#apply').onclick=load;load();
