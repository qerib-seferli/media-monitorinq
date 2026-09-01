import { avatarText, escapeHtml, signOut, supabase } from './core.js';

let outsideProfileHandler = null;

function notificationSeenKey(profile){return `media-monitor-notifications-seen:${profile?.id||profile?.organization_id||'user'}`;}
export function markNotificationsSeen(profile, stamp=new Date().toISOString()){
  try{localStorage.setItem(notificationSeenKey(profile),String(stamp||new Date().toISOString()));}catch{}
  document.querySelectorAll('.notification-unread-badge').forEach(x=>x.remove());
}
async function refreshNotificationBadge(profile){
  if(!profile || profile.system_role==='super_admin') return;
  const nav=document.querySelector('#bottom-nav a[href="bildirisler.html"],#bottom-nav a[href="./bildirisler.html"]');
  if(!nav) return;
  let seen='1970-01-01T00:00:00.000Z'; try{seen=localStorage.getItem(notificationSeenKey(profile))||seen;}catch{}
  let q=supabase.from('notifications').select('id',{count:'exact',head:true}).gt('created_at',seen);
  if(profile.organization_id) q=q.eq('organization_id',profile.organization_id);
  const {count,error}=await q; if(error)return;
  const n=Math.max(0,Number(count||0)); nav.querySelector('.notification-unread-badge')?.remove();
  if(n>0){const badge=document.createElement('span');badge.className='notification-unread-badge';badge.textContent=n>9?'9+':String(n);badge.setAttribute('aria-label',`${n} yeni bildiriş`);nav.appendChild(badge);}
}


const ICONS = {
  dashboard:'<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/></svg>',
  organizations:'<svg viewBox="0 0 24 24"><path d="M4 21V6l8-3 8 3v15M8 9h2m4 0h2M8 13h2m4 0h2M8 17h2m4 0h2"/></svg>',
  users:'<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  catalogs:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12m0-14.14-2.12 2.12m-9.9 9.9-2.12 2.12"/></svg>',
  monitoring:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/></svg>',
  billing:'<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 8h8M8 12h5M8 16h3"/></svg>',
  audit:'<svg viewBox="0 0 24 24"><path d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01"/></svg>',
  notifications:'<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>',
  reports:'<svg viewBox="0 0 24 24"><path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/></svg>',
  profile:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  signout:'<svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5m5 5H3m12-9h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5"/></svg>'
};

function icon(key) {
  return `<span class="nav-icon nav-icon-${key}">${ICONS[key] || ICONS.dashboard}</span>`;
}

function avatarMarkup(profile) {
  const initials = escapeHtml(avatarText(profile));
  const url = String(profile?.avatar_url || '').trim();
  return `<span class="avatar"><span class="avatar-initials">${initials}</span>${url ? `<img src="${escapeHtml(url)}" alt="Profil şəkli" loading="lazy">` : ''}</span>`;
}

export function renderShell(profile, active='dashboard') {
  const orgName = profile?.organizations?.short_name || profile?.organizations?.name || 'ADSEA';
  const isAdmin = profile?.system_role === 'super_admin';
  const fullName = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || (isAdmin ? 'Super Administrator' : 'İstifadəçi');
  const position = profile?.positions?.name || (isAdmin ? 'Super Administrator' : 'İstifadəçi');
  const nav = isAdmin ? [
    ['admin.html','dashboard','Dashboard','dashboard'],
    ['admin.html#organizations','organizations','Təşkilatlar','organizations'],
    ['admin.html#users','users','İstifadəçilər','users'],
    ['admin.html#catalogs','catalogs','Ərazi & Vəzifə','catalogs'],
    ['admin.html#monitoring','monitoring','Monitorinq','monitoring'],
    ['admin.html#audit','audit','Audit Log','audit']
  ] : [
    ['app.html','dashboard','Əsas','dashboard'],
    ['monitorinq.html','monitoring','Monitorinq','monitoring'],
    ['bildirisler.html','notifications','Bildirişlər','notifications'],
    ['hesabat.html','reports','Hesabat','reports'],
    ['profile.html','profile','Profil','profile']
  ];

  const sidebar = document.querySelector('#sidebar');
  if (sidebar) sidebar.innerHTML = `
    <div class="brand"><div class="brand-mark brand-emblem"><img src="./assets/img/state-emblem.svg" alt="Azərbaycan gerbi"></div><div><strong>ADSEA</strong><small>Media Monitorinq</small></div></div>
    <nav class="nav">${nav.map(([href,iconKey,label,key])=>`<a href="${href}" class="${key===active?'active':''}">${icon(iconKey)}<span class="nav-label">${label}</span></a>`).join('')}</nav>
    <div class="sidebar-foot"><button class="sidebar-action" data-action="signout">${icon('signout')}<span>Çıxış</span></button></div>`;

  const topbar = document.querySelector('#topbar');
  if (topbar) {
    const profileControl = isAdmin
      ? `<button type="button" class="profile-chip profile-chip-button" id="profile-menu-toggle" aria-expanded="false"><span class="profile-text"><strong>${escapeHtml(fullName)}</strong><span>${escapeHtml(position)}</span></span>${avatarMarkup(profile)}</button><div class="profile-menu hidden" id="profile-menu"><div class="profile-menu-user"><strong>${escapeHtml(fullName)}</strong><span>${escapeHtml(position)}</span></div><button type="button" data-action="signout">${icon('signout')}<span>Çıxış</span></button></div>`
      : `<a class="profile-chip profile-link" href="./profile.html" aria-label="Profili aç"><span class="profile-text"><strong>${escapeHtml(fullName)}</strong><span>${escapeHtml(position)}</span></span>${avatarMarkup(profile)}</a>`;
    topbar.innerHTML = `
      <div class="topbar-left"><img class="state-emblem" src="./assets/img/state-emblem.svg" alt="Azərbaycan gerbi"></div>
      <div class="topbar-center"><strong>${escapeHtml(orgName)}</strong><span>Rəqəmsal Media Monitorinq Sistemi</span></div>
      <div class="topbar-profile">${profileControl}</div>`;
  }

  const bottom = document.querySelector('#bottom-nav');
  if (bottom) {
    const mobileNav = isAdmin ? nav.slice(0,5) : nav;
    bottom.classList.toggle('admin-bottom-nav', isAdmin);
    bottom.innerHTML = mobileNav.map(([href,iconKey,label,key])=>`<a href="${href}" class="${key===active?'active':''}">${icon(iconKey)}<small>${label}</small></a>`).join('') + (isAdmin ? `<button type="button" class="bottom-signout" data-action="signout">${icon('signout')}<small>Çıxış</small></button>` : '');
    if(!isAdmin) setTimeout(()=>refreshNotificationBadge(profile),0);
  }

  document.querySelectorAll('[data-action="signout"]').forEach(el => el.addEventListener('click', signOut));
  const toggle = document.querySelector('#profile-menu-toggle');
  const menu = document.querySelector('#profile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
    });
    if (outsideProfileHandler) document.removeEventListener('click', outsideProfileHandler);
    outsideProfileHandler = e => {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) {
        menu.classList.add('hidden');
        toggle.setAttribute('aria-expanded','false');
      }
    };
    document.addEventListener('click', outsideProfileHandler);
  }
}
