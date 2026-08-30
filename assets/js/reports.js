import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, getCachedProfile, showPageLoader, hidePageLoader, toast } from './core.js';
import { applyOrganizationScope, setupOrganizationFilter } from './scope.js';
const cachedProfile=getCachedProfile(); if(cachedProfile) renderShell(cachedProfile,'reports'); showPageLoader();
const c=await requireAuth(); if(!c) throw new Error('auth'); renderShell(c.profile,'reports'); hidePageLoader();
const organizationFilter=document.querySelector('#organization-filter');
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
async function counted(filter=(q)=>q){
  const [a,b]=rangeIso();
  let q=supabase.from('mentions').select('id',{count:'exact',head:true})
    .gt('relevance_score',0)
    .or(`and(published_at.gte.${a},published_at.lte.${b}),and(published_at.is.null,detected_at.gte.${a},detected_at.lte.${b})`);
  q=applyOrganizationScope(q,c.profile,organizationFilter?.value||'');
  q=filter(q);
  const r=await q;
  if(r.error) throw r.error;
  return Number(r.count||0);
}
async function load(){
  showPageLoader();
  try{
    // Hesabat üçün minlərlə nəticəni brauzerə çəkmirik; Supabase yalnız sayları qaytarır.
    // 1000-lik səhifələmə əvvəl böyük egress yaradırdı.
    const [total,neg,pos,critical,youtube,web,p61,p31,p30]=await Promise.all([
      counted(),
      counted(q=>q.eq('sentiment','negative')),
      counted(q=>q.eq('sentiment','positive')),
      counted(q=>q.gte('priority_score',81)),
      counted(q=>q.ilike('source_platform','youtube')),
      counted(q=>q.in('source_platform',['Web','Google News'])),
      counted(q=>q.gte('priority_score',61).lt('priority_score',81)),
      counted(q=>q.gte('priority_score',31).lt('priority_score',61)),
      counted(q=>q.lt('priority_score',31))
    ]);
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Kritik',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms=[['YouTube',youtube],['Web',web]].filter(([,v])=>v>0);
    document.querySelector('#platforms').innerHTML=platforms.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const buckets=[['81–100',critical],['61–80',p61],['31–60',p31],['0–30',p30]];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
if(organizationFilter) organizationFilter.onchange=load;period.onchange=()=>{setPeriod(period.value);if(period.value!=='custom')load()};from.onchange=()=>period.value='custom';to.onchange=()=>period.value='custom';document.querySelector('#apply').onclick=load;load();
