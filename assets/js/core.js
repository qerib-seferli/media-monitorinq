import { APP_CONFIG } from './config.js';

const { createClient } = window.supabase;
export const supabase = createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
export const fmtDate = value => value ? new Intl.DateTimeFormat('az-AZ',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '—';
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

export async function getSessionProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, profile: null, organization: null };
  const { data: profile, error } = await supabase.from('profiles')
    .select('*, positions(name), organizations(*)')
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
  return profile?.organizations?.short_name || profile?.organizations?.name || 'Media Monitorinq';
}

export function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
}


export function getCachedProfile() {
  try { return JSON.parse(sessionStorage.getItem('mm.cachedProfile') || 'null'); } catch { return null; }
}

export function showPageLoader() {
  let loader = document.querySelector('#page-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'page-loader';
    loader.className = 'page-loader';
    loader.innerHTML = '<span class="page-loader-disc"><img src="./assets/img/loading.gif" alt="Yüklənir"></span>';
    document.body.appendChild(loader);
  }
  loader.classList.remove('is-hidden');
}

export function hidePageLoader() {
  const loader = document.querySelector('#page-loader');
  if (!loader) return;
  loader.classList.add('is-hidden');
}

function installNavigationLoader() {
  if (window.__mmNavigationLoaderInstalled) return;
  window.__mmNavigationLoaderInstalled = true;
  document.addEventListener('click', (event) => {
    const a = event.target.closest?.('a[href]');
    if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || a.target === '_blank' || a.hasAttribute('download')) return;
    try {
      const target = new URL(a.href, location.href);
      if (target.origin === location.origin) showPageLoader();
    } catch {}
  }, true);
}

installNavigationLoader();

window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  const text = String(reason?.message || reason || '');
  if (/github|supabase|edge function|failed to fetch|networkerror|functionshttp/i.test(text)) {
    event.preventDefault();
    toast(reason, 'error');
  }
});
