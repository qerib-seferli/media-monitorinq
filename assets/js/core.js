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

export function toast(message, type='info') {
  let box = $('#toast-stack');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-stack';
    box.className = 'toast-stack';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  box.appendChild(item);
  setTimeout(() => item.classList.add('show'), 10);
  setTimeout(() => { item.classList.remove('show'); setTimeout(()=>item.remove(),250); }, 3500);
}

export async function getSessionProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, profile: null, organization: null };
  const { data: profile, error } = await supabase.from('profiles')
    .select('*, positions(name), organizations(*)')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();
  if (error) throw error;
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
