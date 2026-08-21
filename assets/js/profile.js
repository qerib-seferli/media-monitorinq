import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, toast, avatarText } from './core.js';
import { toggleTheme } from './theme.js';

const ctx = await requireAuth();
if (!ctx) throw new Error('auth');
let profile = ctx.profile;
renderShell(profile,'profile');

const nameEl = document.querySelector('#name');
const metaEl = document.querySelector('#meta');
const phoneEl = document.querySelector('#phone');
const emailEl = document.querySelector('#email');
const avatarEl = document.querySelector('#profile-avatar');
const avatarFile = document.querySelector('#avatar-file');
const uploadBtn = document.querySelector('#avatar-upload');
const removeBtn = document.querySelector('#avatar-remove');

function renderProfile() {
  const full = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'İstifadəçi';
  nameEl.textContent = full;
  metaEl.textContent = `${profile.positions?.name || 'İstifadəçi'} • ${profile.organizations?.short_name || ''}`;
  emailEl.value = profile.email || ctx.session.user.email || '';
  const currentPhone = String(profile.phone || '');
  phoneEl.value = currentPhone.includes('@') ? '' : currentPhone;
  const initials = avatarText(profile);
  avatarEl.innerHTML = profile.avatar_url
    ? `<span>${initials}</span><img src="${profile.avatar_url}" alt="${full}">`
    : `<span>${initials}</span>`;
  removeBtn.classList.toggle('hidden', !profile.avatar_url);
}
renderProfile();

async function imageToBitmap(file) {
  if ('createImageBitmap' in window) return await createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve,reject)=>{ const x=new Image(); x.onload=()=>resolve(x); x.onerror=reject; x.src=url; });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

async function canvasBlob(canvas, quality) {
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
}

async function compressAvatar(file) {
  if (!file.type.startsWith('image/')) throw new Error('Yalnız şəkil faylı seçin.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Şəkil çox böyükdür. Maksimum 12 MB fayl seçin.');
  const image = await imageToBitmap(file);
  const sourceW = image.width || image.naturalWidth;
  const sourceH = image.height || image.naturalHeight;
  const side = Math.min(sourceW, sourceH);
  const sx = Math.max(0, (sourceW - side) / 2);
  const sy = Math.max(0, (sourceH - side) / 2);
  const size = Math.min(512, side);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d', { alpha:false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  image.close?.();
  let quality = .82;
  let blob = await canvasBlob(canvas, quality);
  while (blob && blob.size > 220 * 1024 && quality > .5) {
    quality -= .08;
    blob = await canvasBlob(canvas, quality);
  }
  if (!blob) throw new Error('Şəkil optimallaşdırılmadı. Başqa şəkil seçin.');
  return blob;
}

uploadBtn.addEventListener('click', () => avatarFile.click());
avatarEl.addEventListener('click', () => avatarFile.click());
avatarFile.addEventListener('change', async () => {
  const file = avatarFile.files?.[0];
  if (!file) return;
  uploadBtn.disabled = true;
  const oldText = uploadBtn.textContent;
  uploadBtn.textContent = 'Optimallaşdırılır…';
  try {
    const blob = await compressAvatar(file);
    const path = `${ctx.session.user.id}/avatar.webp`;
    uploadBtn.textContent = 'Yüklənir…';
    const { error: uploadError } = await supabase.storage.from('profile-avatars').upload(path, blob, {
      upsert:true, contentType:'image/webp', cacheControl:'3600'
    });
    if (uploadError) throw uploadError;
    const { data } = supabase.storage.from('profile-avatars').getPublicUrl(path);
    const avatarUrl = `${data.publicUrl}?v=${Date.now()}`;
    const { error } = await supabase.from('profiles').update({ avatar_url:avatarUrl }).eq('id',profile.id);
    if (error) throw error;
    profile = { ...profile, avatar_url:avatarUrl };
    renderProfile();
    renderShell(profile,'profile');
    toast(`Profil şəkli optimallaşdırıldı (${Math.round(blob.size/1024)} KB) və yadda saxlanıldı`,'success');
  } catch (e) {
    toast(e,'error');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = oldText;
    avatarFile.value = '';
  }
});

removeBtn.addEventListener('click', async () => {
  if (!confirm('Profil şəkli silinsin?')) return;
  const path = `${ctx.session.user.id}/avatar.webp`;
  const { error: removeError } = await supabase.storage.from('profile-avatars').remove([path]);
  if (removeError) return toast(removeError,'error');
  const { error } = await supabase.from('profiles').update({ avatar_url:null }).eq('id',profile.id);
  if (error) return toast(error,'error');
  profile = { ...profile, avatar_url:null };
  renderProfile();
  renderShell(profile,'profile');
  toast('Profil şəkli silindi','success');
});

document.querySelector('#save').onclick = async () => {
  const phone = phoneEl.value.trim();
  const { error } = await supabase.from('profiles').update({ phone }).eq('id',profile.id);
  if (!error) profile.phone = phone;
  toast(error || 'Profil məlumatları yeniləndi', error ? 'error' : 'success');
};

document.querySelector('#password').onclick = async () => {
  const p = document.querySelector('#pass').value;
  if (p.length < 8) return toast('Şifrə ən az 8 simvol olmalıdır','error');
  const { error } = await supabase.auth.updateUser({ password:p });
  if (!error) document.querySelector('#pass').value = '';
  toast(error || 'Şifrə dəyişdirildi', error ? 'error' : 'success');
};

document.querySelector('#theme').onclick = toggleTheme;
