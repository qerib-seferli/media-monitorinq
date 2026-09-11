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
function reportPlatformIcon(id=''){
  const common='viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  const icons={
    YouTube:`<svg ${common}><path d="M21.2 7.05a2.9 2.9 0 0 0-2.04-2.05C17.35 4.5 12 4.5 12 4.5s-5.35 0-7.16.5A2.9 2.9 0 0 0 2.8 7.05C2.3 8.86 2.3 12 2.3 12s0 3.14.5 4.95A2.9 2.9 0 0 0 4.84 19C6.65 19.5 12 19.5 12 19.5s5.35 0 7.16-.5a2.9 2.9 0 0 0 2.04-2.05c.5-1.81.5-4.95.5-4.95s0-3.14-.5-4.95Z" fill="currentColor"/><path d="m10 15.35 5.1-3.35L10 8.65v6.7Z" fill="#fff"/></svg>`,
    Facebook:`<svg ${common}><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M13.55 20v-7h2.35l.36-2.74h-2.71V8.51c0-.79.22-1.33 1.36-1.33h1.45V4.73c-.25-.03-1.11-.1-2.12-.1-2.1 0-3.54 1.28-3.54 3.64v1.99H8.82V13h2.38v7h2.35Z" fill="#fff"/></svg>`,
    Instagram:`<svg ${common}><rect x="3.1" y="3.1" width="17.8" height="17.8" rx="5.3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.15" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.45" cy="6.65" r="1.2" fill="currentColor"/></svg>`,
    TikTok:`<svg ${common}><path d="M14.6 3.1h3.05c.27 1.72 1.23 3.02 3.05 3.55v3.07a7.3 7.3 0 0 1-3.04-.9v6.05a5.54 5.54 0 1 1-5.55-5.54c.36 0 .72.03 1.06.1v3.13a2.55 2.55 0 1 0 1.43 2.3V3.1Z" fill="currentColor"/></svg>`,
    LinkedIn:`<svg ${common}><rect x="2.7" y="2.7" width="18.6" height="18.6" rx="2.5" fill="currentColor"/><circle cx="7.2" cy="8.1" r="1.45" fill="#fff"/><path d="M5.95 10.2h2.5v7.35h-2.5V10.2Zm4.05 0h2.4v1c.75-.98 1.65-1.32 2.78-1.32 2.5 0 3.12 1.62 3.12 4.2v3.47h-2.5v-3.08c0-1.36-.05-2.47-1.5-2.47-1.52 0-1.8 1.18-1.8 2.64v2.91H10V10.2Z" fill="#fff"/></svg>`,
    X:`<svg ${common}><path d="M4.4 3.5h4.15l4.17 5.58 4.9-5.58h1.98l-5.97 6.81 6.15 8.19h-4.15l-4.55-6.08-5.34 6.08H3.76l6.4-7.31L4.4 3.5Zm3.08 1.45H6.94l9.43 12.11h.55L7.48 4.95Z" fill="currentColor"/></svg>`,
    Web:`<svg ${common}><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.4 12h17.2M12 3c2.25 2.45 3.42 5.43 3.42 9S14.25 18.55 12 21c-2.25-2.45-3.42-5.43-3.42-9S9.75 5.45 12 3Z" fill="none" stroke="currentColor" stroke-width="1.55"/></svg>`
  };
  return icons[id]||icons.Web;
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
  if(!includeWeak) q=q.gte('relevance_score',31);
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
      counted(q=>q.gte('relevance_score',81)),
      counted(q=>platformCountFilter(q,'YouTube')),
      counted(q=>platformCountFilter(q,'Facebook')),
      counted(q=>platformCountFilter(q,'Instagram')),
      counted(q=>platformCountFilter(q,'TikTok')),
      counted(q=>platformCountFilter(q,'LinkedIn')),
      counted(q=>platformCountFilter(q,'X')),
      counted(q=>platformCountFilter(q,'Web')),
      counted(q=>q.gte('relevance_score',61).lt('relevance_score',81)),
      counted(q=>q.gte('relevance_score',31).lt('relevance_score',61)),
      counted(q=>q.gt('relevance_score',0).lt('relevance_score',31),{includeWeak:true})
    ]);
    document.querySelector('#metrics').innerHTML=[['Ümumi',total],['Mənfi',neg],['Müsbət',pos],['Yüksək uyğunluq',critical]].map(([l,n])=>`<div class="card metric"><div class="label">${l}</div><div class="num">${n}</div></div>`).join('');
    const platforms=[['YouTube',youtube],['Web',web],['Facebook',facebook],['Instagram',instagram],['LinkedIn',linkedin],['TikTok',tiktok],['X',xPlatform]];
    document.querySelector('#platforms').innerHTML=platforms.map(([k,v])=>`<div class="report-row"><span class="report-platform-label report-platform-${k.toLowerCase()}"><span class="report-platform-icon">${reportPlatformIcon(k)}</span><span>${k}</span></span><strong>${v}</strong></div>`).join('')||'<div class="empty">Məlumat yoxdur</div>';
    const buckets=[
      ['81–100% • Yüksək uyğunluq',critical,''],
      ['61–80% • Yaxşı uyğunluq',p61,''],
      ['31–60% • Yoxlanmalı uyğunluq',p31,''],
      ['1–30% • Zəif — istifadəçidən gizli',p30,'weak-hidden']
    ];
    document.querySelector('#priorities').innerHTML=buckets.map(([k,v,cls])=>`<div class="report-row ${cls}"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }catch(e){toast(e,'error')}finally{hidePageLoader()}
}
if(organizationFilter) organizationFilter.onchange=load;period.onchange=()=>{setPeriod(period.value);if(period.value!=='custom')load()};from.onchange=()=>period.value='custom';to.onchange=()=>period.value='custom';document.querySelector('#apply').onclick=load;load();
