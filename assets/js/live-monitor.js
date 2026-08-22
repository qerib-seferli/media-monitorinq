import { supabase } from './core.js';

const QUICK_INTERVAL_MS = 20_000;
const IDLE_INTERVAL_MS = 120_000;
const BURST_MS = 10 * 60_000;
const FULL_SWEEP_COOLDOWN_MS = 2 * 60_000;
const TAB_LOCK_MS = 18_000;

let running = false;
let timer = null;
let startedAt = 0;
let stopped = false;
let realtimeChannel = null;

function storageGet(key){ try{return Number(localStorage.getItem(key)||0)||0}catch{return 0} }
function storageSet(key,value){ try{localStorage.setItem(key,String(value))}catch{} }

function focusIds(){
  try{
    const raw=JSON.parse(localStorage.getItem('mm.youtubeFocusIds')||'[]');
    return [...new Set((Array.isArray(raw)?raw:[]).map(String).filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x)))].slice(0,8);
  }catch{return []}
}
function rememberFocusFromUrl(value){
  try{
    const u=new URL(value,location.href);
    if(!u.hostname.includes('youtube.com')&&!u.hostname.includes('youtu.be')) return;
    const id=u.hostname.includes('youtu.be')?u.pathname.replace(/^\//,'').split('/')[0]:u.searchParams.get('v');
    if(!id||!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    const next=[id,...focusIds().filter(x=>x!==id)].slice(0,8);
    localStorage.setItem('mm.youtubeFocusIds',JSON.stringify(next));
  }catch{}
}


async function invokeQuick({full=false,refilter=false}={}){
  if(running || stopped || document.hidden) return null;
  const now=Date.now();
  const lockKey='mm.liveMonitor.lock';
  if(now-storageGet(lockKey)<TAB_LOCK_MS) return null;
  storageSet(lockKey,now);
  running=true;
  try{
    const {data,error}=await supabase.functions.invoke('monitor-worker',{
      body:{
        quick_youtube_comments:true,
        full_comment_sweep:full,
        refilter_existing:refilter,
        focus_video_ids:focusIds(),
        verify_existing:false,
        debug:false
      }
    });
    if(error) throw error;
    return data||null;
  }catch(error){
    console.warn('Canlı monitorinq sorğusu tamamlanmadı',error);
    return null;
  }finally{
    running=false;
  }
}

export function startLiveMonitor({organizationId=null,onNew=null,fullFirst=false}={}){
  if(window.__mmLiveMonitorStarted) return;
  window.__mmLiveMonitorStarted=true;
  startedAt=Date.now();

  const emit=(payload)=>{
    try{window.dispatchEvent(new CustomEvent('media-monitor:new',{detail:payload||{}}))}catch{}
    if(typeof onNew==='function') onNew(payload||{});
  };

  if(organizationId){
    try{
      realtimeChannel=supabase.channel(`mentions-live-${organizationId}`)
        .on('postgres_changes',{event:'INSERT',schema:'public',table:'mentions',filter:`organization_id=eq.${organizationId}`},payload=>emit({realtime:true,row:payload.new}))
        .subscribe();
    }catch(error){ console.warn('Realtime kanal qoşulmadı',error); }
  }

  const tick=async(first=false)=>{
    if(stopped) return;
    const now=Date.now();
    const fullKey=`mm.liveMonitor.full.v2.${organizationId||'global'}`;
    const canFull=first && (fullFirst || now-storageGet(fullKey)>FULL_SWEEP_COOLDOWN_MS);
    if(canFull) storageSet(fullKey,now);
    const result=await invokeQuick({full:canFull,refilter:canFull});
    if(Number(result?.new_mentions||0)>0 || Number(result?.details?.find?.(x=>x?.filtered_out)?.filtered_out||0)>0) emit(result);
    const burst=Date.now()-startedAt<BURST_MS;
    timer=setTimeout(()=>tick(false),burst?QUICK_INTERVAL_MS:IDLE_INTERVAL_MS);
  };

  
  document.addEventListener('click',e=>{
    const a=e.target?.closest?.('a[href]');
    if(a) rememberFocusFromUrl(a.href);
  },true);

document.addEventListener('visibilitychange',()=>{
    if(!document.hidden && !stopped){
      if(timer) clearTimeout(timer);
      timer=setTimeout(()=>tick(false),1200);
    }
  });

  window.addEventListener('beforeunload',()=>{
    stopped=true;
    if(timer) clearTimeout(timer);
    if(realtimeChannel) supabase.removeChannel(realtimeChannel).catch(()=>{});
  },{once:true});

  timer=setTimeout(()=>tick(true),900);
}
