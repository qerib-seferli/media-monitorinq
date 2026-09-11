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
function platformCountFilter(q,name){
  const p=String(name||'').toLowerCase();
  if(p==='web')return q.or('source_platform.ilike.Web,source_platform.ilike.Google News,source_platform.ilike.Bing News');
  if(p==='x')return q.or('source_platform.ilike.X,source_platform.ilike.Twitter');
  return q.ilike('source_platform',name);
}
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
async function counted(filter=(q)=>q,{includeWeak=false}={}){
  const [a,b]=rangeIso();
  let q=supabase.from('mentions').select('id',{count:'exact',head:true})
    .gt('relevance_score',0)
    .or(`and(published_at.gte.${a},published_at.lte.${b}),and(published_at.is.null,detected_at.gte.${a},detected_at.lte.${b})`);
  // Hesabatın əsas rəqəmləri istifadəçiyə real göstərilən keyfiyyət həddi ilə eyni olsun.
  // 1–30 zəif nəticələr silinmir; ayrıca "istifadəçidən gizli" kimi sayılır.
  if(!includeWeak) q=q.or('priority_score.gte.31,relevance_score.gte.31');
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
    const [total,neg,pos,critical,youtube,facebook,instagram,tiktok,linkedin,xPlatform,web,p61,p31,p30]=await Promise.all([
      counted(),
      counted(q=>q.eq('sentiment','negative')),
      counted(q=>q.eq('sentiment','positive')),
      counted(q=>q.gte('priority_score',81)),
      counted(q=>platformCountFilter(q,'YouTube')),
      counted(q=>platformCountFilter(q,'Facebook')),
      counted(q=>platformCountFilter(q,'Instagram')),
      counted(q=>platformCountFilter(q,'TikTok')),
      counted(q=>platformCountFilter(q,'LinkedIn')),
      counted(q=>platformCountFilter(q,'X')),
      counted(q=>platformCountFilter(q,'Web')),
      counted(q=>q.gte('priority_score',61).lt('priority_score',81)),
      counted(q=>q.gte('priority_score',31).lt('priority_score',61)),
      counted(q=>q.lt('priority_score',31),{includeWeak:true})
    ]);
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Kritik',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms=[['YouTube',youtube],['Web',web],['Facebook',facebook],['Instagram',instagram],['LinkedIn',linkedin],['TikTok',tiktok],['X',xPlatform]];
    document.querySelector('#platforms').innerHTML=platforms.map(([k,v])=>`<div class="report-row"><span>${k}</span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const buckets=[
      ['81–100 • Yüksək / kritik',critical,''],
      ['61–80 • Mühüm',p61,''],
      ['31–60 • Yoxlanmalı',p31,''],
      ['1–30 • Zəif — istifadəçidən gizli',p30,'weak-hidden']
    ];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v,cls])=>`<div class="report-row ${cls}"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
if(organizationFilter) organizationFilter.onchange=load;period.onchange=()=>{setPeriod(period.value);if(period.value!=='custom')load()};from.onchange=()=>period.value='custom';to.onchange=()=>period.value='custom';document.querySelector('#apply').onclick=load;load();
