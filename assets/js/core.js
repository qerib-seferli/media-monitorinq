import { APP_CONFIG } from './config.js';

const { createClient } = window.supabase;
export const supabase = createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
export const fmtDate = value => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('az-AZ', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
};
export const money = value => `${Number(value || 0).toFixed(2)} AZN`;

export function friendlyError(value) {
  const original = String(value?.message || value || '').trim();
  const text = original.toLocaleLowerCase('az-AZ');
  if (!original) return 'Əməliyyat tamamlanmadı. Yenidən yoxlayın.';
  if (/cors|failed to fetch|fetch failed|networkerror|failed to send|functionshttperror|edge function|github|supabase/.test(text)) return 'Sistem xidməti ilə əlaqə qurulmadı. Bir neçə saniyə sonra yenidən yoxlayın.';
  if (/jwt|row level security|rls|permission|not authorized|unauthorized|forbidden|icazəsiz/.test(text)) return 'Bu əməliyyat üçün hesabınızın icazəsi yoxdur.';
  if (/duplicate|already exists|unique constraint|23505/.test(text)) return 'Bu məlumat artıq sistemdə mövcuddur.';
  if (/invalid login|invalid credentials/.test(text)) return 'E-mail və ya şifrə yanlışdır.';
  if (/storage|bucket/.test(text)) return 'Fayl yadda saxlanmadı. Sistem yaddaş ayarlarını yoxlayın.';
  return original.length > 180 ? 'Əməliyyat tamamlanmadı. Yenidən yoxlayın.' : original;
}

export function toast(message, type='info') {
  let box = $('#toast-stack');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-stack';
    document.body.appendChild(box);
  }
  box.classList.add('toast-stack');
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  item.textContent = type === 'error' ? friendlyError(message) : String(message || '');
  box.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => { item.classList.remove('show'); setTimeout(()=>item.remove(),250); }, 3800);
}


function dialogRoot() {
  let root = document.querySelector('#app-dialog-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-dialog-root';
    document.body.appendChild(root);
  }
  return root;
}

export function confirmDialog({
  title='Təsdiq',
  message='',
  confirmText='Bəli',
  cancelText='Xeyr',
  tone='default'
}={}) {
  return new Promise(resolve => {
    const root = dialogRoot();
    const danger = tone === 'danger';
    root.innerHTML = `<div class="modal-backdrop app-confirm-backdrop"><div class="modal app-confirm" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title"><div class="modal-head"><div><span class="eyebrow">Sistem təsdiqi</span><h2 id="app-confirm-title">${escapeHtml(title)}</h2></div><button class="icon-btn" type="button" data-dialog-close aria-label="Bağla">✕</button></div><p class="app-confirm-message">${escapeHtml(message)}</p><div class="modal-actions app-confirm-actions"><button class="btn ${danger ? 'danger' : ''}" type="button" data-dialog-confirm>${escapeHtml(confirmText)}</button><button class="btn ghost" type="button" data-dialog-cancel>${escapeHtml(cancelText)}</button></div></div></div>`;
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      root.innerHTML = '';
      resolve(Boolean(value));
    };
    root.querySelector('[data-dialog-confirm]')?.addEventListener('click',()=>done(true));
    root.querySelector('[data-dialog-cancel]')?.addEventListener('click',()=>done(false));
    root.querySelector('[data-dialog-close]')?.addEventListener('click',()=>done(false));
    root.querySelector('.app-confirm-backdrop')?.addEventListener('click',e=>{ if(e.target===e.currentTarget) done(false); });
    const keyHandler = e => {
      if (finished) return document.removeEventListener('keydown',keyHandler);
      if (e.key === 'Escape') { document.removeEventListener('keydown',keyHandler); done(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown',keyHandler); done(true); }
    };
    document.addEventListener('keydown',keyHandler);
    requestAnimationFrame(()=>root.querySelector('[data-dialog-confirm]')?.focus());
  });
}

export function promptDialog({
  title='Məlumat daxil edin',
  message='',
  label='Dəyər',
  value='',
  placeholder='',
  confirmText='Yadda saxla',
  cancelText='Ləğv et',
  type='text'
}={}) {
  return new Promise(resolve => {
    const root = dialogRoot();
    root.innerHTML = `<div class="modal-backdrop app-confirm-backdrop"><form class="modal app-confirm" id="app-prompt-form" role="dialog" aria-modal="true" aria-labelledby="app-prompt-title"><div class="modal-head"><div><span class="eyebrow">Sistem əməliyyatı</span><h2 id="app-prompt-title">${escapeHtml(title)}</h2></div><button class="icon-btn" type="button" data-dialog-close aria-label="Bağla">✕</button></div>${message?`<p class="app-confirm-message">${escapeHtml(message)}</p>`:''}<div class="field"><label>${escapeHtml(label)}</label><input class="input" id="app-prompt-input" type="${escapeHtml(type)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" required></div><div class="modal-actions app-confirm-actions"><button class="btn" type="submit">${escapeHtml(confirmText)}</button><button class="btn ghost" type="button" data-dialog-cancel>${escapeHtml(cancelText)}</button></div></form></div>`;
    let finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      root.innerHTML = '';
      resolve(result);
    };
    const form=root.querySelector('#app-prompt-form');
    const input=root.querySelector('#app-prompt-input');
    form?.addEventListener('submit',e=>{ e.preventDefault(); done(input?.value ?? ''); });
    root.querySelector('[data-dialog-cancel]')?.addEventListener('click',()=>done(null));
    root.querySelector('[data-dialog-close]')?.addEventListener('click',()=>done(null));
    root.querySelector('.app-confirm-backdrop')?.addEventListener('click',e=>{ if(e.target===e.currentTarget) done(null); });
    requestAnimationFrame(()=>{ input?.focus(); input?.select(); });
  });
}

export async function getSessionProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, profile: null, organization: null };
  const { data: profile, error } = await supabase.from('profiles')
    .select('*, positions(name), organizations(*), service_point:organization_service_points!profiles_service_point_id_fkey(id,name,short_name,organization_id,district_id)')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();
  if (error) throw error;
  if (profile) { try { sessionStorage.setItem('mm.cachedProfile', JSON.stringify(profile)); } catch {} }
  return { session, profile, organization: profile?.organizations || null };
}

export async function signOut() {
  await supabase.auth.signOut();
  location.href = './index.html';
}

export function avatarText(profile) {
  const a = profile?.first_name?.[0] || '';
  const b = profile?.last_name?.[0] || '';
  return (a+b || 'U').toUpperCase();
}

export function currentOrgName(profile) {
  return profile?.access_scope === 'all' ? 'ADSEA' : (profile?.service_point?.short_name || profile?.service_point?.name || profile?.organizations?.short_name || profile?.organizations?.name || 'Media Monitorinq');
}

export function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
}




export function installCompactMobileSelects(root=document){
  const mobile=()=>window.matchMedia('(max-width: 720px)').matches;
  const closeAll=except=>document.querySelectorAll('.mm-select-popover.is-open').forEach(x=>{
    if(x!==except){
      x.classList.remove('is-open','is-above','is-long');
      x.style.removeProperty('--mm-pop-left');
      x.style.removeProperty('--mm-pop-top');
      x.style.removeProperty('--mm-pop-width');
      x.style.removeProperty('--mm-pop-max-height');
    }
  });
  const positionPopover=(trigger,pop,optionCount)=>{
    const rect=trigger.getBoundingClientRect();
    const gap=6;
    const viewportW=document.documentElement.clientWidth||window.innerWidth;
    const viewportH=window.innerHeight||document.documentElement.clientHeight;
    const width=Math.min(viewportW-16,Math.max(rect.width,180));
    const left=Math.max(8,Math.min(rect.left,viewportW-width-8));
    const rowH=42;
    const groupCount=pop.querySelectorAll('.mm-select-group').length;
    const desired=Math.min(optionCount*rowH + groupCount*25 + 12, Math.round(viewportH*.48));
    const below=Math.max(0,viewportH-rect.bottom-gap-12);
    const above=Math.max(0,rect.top-gap-12);
    const openAbove=below<Math.min(desired,180) && above>below;
    const available=Math.max(90,Math.min(Math.round(viewportH*.48),openAbove?above:below));
    const top=openAbove?Math.max(8,rect.top-gap-Math.min(desired,available)):Math.min(viewportH-8,rect.bottom+gap);
    pop.classList.toggle('is-above',openAbove);
    pop.classList.toggle('is-long',desired>available || optionCount>8);
    pop.style.setProperty('--mm-pop-left',`${left}px`);
    pop.style.setProperty('--mm-pop-top',`${top}px`);
    pop.style.setProperty('--mm-pop-width',`${width}px`);
    pop.style.setProperty('--mm-pop-max-height',`${available}px`);
  };
  const enhance=select=>{
    if(!select || select.dataset.mmSelect==='1')return;
    select.dataset.mmSelect='1';
    select.classList.add('mm-native-select');
    const trigger=document.createElement('button');
    trigger.type='button';
    trigger.className='mm-select-trigger';
    trigger.dataset.selectId=select.id||'';
    trigger.setAttribute('aria-haspopup','listbox');
    trigger.setAttribute('aria-expanded','false');
    const pop=document.createElement('div');
    pop.className='mm-select-popover';
    pop.setAttribute('role','listbox');
    select.insertAdjacentElement('afterend',pop);
    select.insertAdjacentElement('afterend',trigger);

    const rebuild=()=>{
      const current=select.options[select.selectedIndex];
      trigger.textContent=current?.textContent||select.getAttribute('aria-label')||'Seçin';
      trigger.disabled=select.disabled;
      trigger.hidden=select.classList.contains('hidden');
      const opts=[...select.options];
      const rows=[];
      let currentGroup='';
      opts.forEach(opt=>{
        const group=opt.parentElement?.tagName==='OPTGROUP'?opt.parentElement.label:'';
        if(group&&group!==currentGroup){
          rows.push(`<div class="mm-select-group" data-mm-group>${escapeHtml(group)}</div>`);
          currentGroup=group;
        }
        if(!group)currentGroup='';
        rows.push(`<button type="button" class="mm-select-option${opt.selected?' is-selected':''}" role="option" aria-selected="${opt.selected?'true':'false'}" data-value="${escapeHtml(opt.value)}" ${opt.disabled?'disabled':''}>${escapeHtml(opt.textContent||'')}</button>`);
      });
      pop.innerHTML=`<div class="mm-select-options">${rows.join('')}</div>`;
      [...pop.querySelectorAll('.mm-select-option')].forEach(btn=>btn.onclick=()=>{
        select.value=btn.dataset.value||'';
        select.dispatchEvent(new Event('change',{bubbles:true}));
        rebuild();
        pop.classList.remove('is-open','is-above','is-long');
        trigger.setAttribute('aria-expanded','false');
        trigger.focus({preventScroll:true});
      });
    };

    trigger.onclick=e=>{
      e.preventDefault();
      e.stopPropagation();
      if(!mobile()||select.disabled)return;
      const opening=!pop.classList.contains('is-open');
      closeAll(pop);
      pop.classList.toggle('is-open',opening);
      trigger.setAttribute('aria-expanded',opening?'true':'false');
      if(opening){
        const optionCount=[...select.options].filter(o=>!o.disabled).length;
        positionPopover(trigger,pop,optionCount);
        requestAnimationFrame(()=>pop.querySelector('.mm-select-option.is-selected:not([disabled]),.mm-select-option:not([disabled])')?.focus({preventScroll:true}));
      }
    };
    select.addEventListener('change',rebuild);
    new MutationObserver(rebuild).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','class']});
    rebuild();
  };

  root.querySelectorAll?.('select.select').forEach(enhance);
  new MutationObserver(ms=>{
    for(const m of ms)for(const n of m.addedNodes){
      if(n.nodeType!==1)continue;
      if(n.matches?.('select.select'))enhance(n);
      n.querySelectorAll?.('select.select').forEach(enhance);
    }
  }).observe(root===document?document.body:root,{childList:true,subtree:true});

  if(!window.__mmSelectOutside){
    window.__mmSelectOutside=true;
    document.addEventListener('click',e=>{
      if(!e.target.closest?.('.mm-select-trigger,.mm-select-popover')){
        closeAll();
        document.querySelectorAll('.mm-select-trigger[aria-expanded="true"]').forEach(t=>t.setAttribute('aria-expanded','false'));
      }
    });
    window.addEventListener('resize',()=>closeAll());
    window.addEventListener('orientationchange',()=>closeAll());
    document.addEventListener('scroll',e=>{if(!e.target?.closest?.('.mm-select-popover'))closeAll();},{passive:true,capture:true});
  }
}

export function getCachedProfile() {
  try { return JSON.parse(sessionStorage.getItem('mm.cachedProfile') || 'null'); } catch { return null; }
}

let pageLoaderTimer = null;

export function showPageLoader() {
  let loader = document.querySelector('#page-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'page-loader';
    loader.className = 'page-loader is-hidden';
    loader.setAttribute('aria-hidden', 'true');
    loader.innerHTML = '<span class="page-loader-disc"><img src="./assets/img/loading.gif" alt=""></span>';
    document.body.appendChild(loader);
  }

  if (pageLoaderTimer) clearTimeout(pageLoaderTimer);
  loader.classList.remove('is-hidden');
  loader.setAttribute('aria-hidden', 'false');

  // Heç bir route/fetch loader-i ekranda ilişdirib saxlamasın.
  pageLoaderTimer = setTimeout(() => hidePageLoader(), 4500);
}

export function hidePageLoader() {
  if (pageLoaderTimer) {
    clearTimeout(pageLoaderTimer);
    pageLoaderTimer = null;
  }
  const loader = document.querySelector('#page-loader');
  if (!loader) return;
  loader.classList.add('is-hidden');
  loader.setAttribute('aria-hidden', 'true');
}

function installNavigationLoader() {
  if (window.__mmNavigationLoaderInstalled) return;
  window.__mmNavigationLoaderInstalled = true;

  document.addEventListener('click', (event) => {
    const a = event.target.closest?.('a[href]');
    if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:') || a.target === '_blank' || a.hasAttribute('download')) return;

    try {
      const target = new URL(a.href, location.href);
      if (target.origin !== location.origin) return;

      // Eyni HTML daxilində hash-route dəyişəndə tam səhifə loader-i göstərilmir.
      if (target.pathname === location.pathname && target.search === location.search) return;

      showPageLoader();
    } catch {}
  }, true);

  window.addEventListener('pageshow', hidePageLoader);
  window.addEventListener('load', hidePageLoader);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) hidePageLoader();
  });
}

installNavigationLoader();
installCompactMobileSelects();

window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  const text = String(reason?.message || reason || '');
  if (/github|supabase|edge function|failed to fetch|networkerror|functionshttp/i.test(text)) {
    event.preventDefault();
    toast(reason, 'error');
  }
});
