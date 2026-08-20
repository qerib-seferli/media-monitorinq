import { avatarText, signOut } from './core.js';

export function renderShell(profile, active='dashboard') {
  const orgName = profile?.organizations?.short_name || profile?.organizations?.name || 'Media Monitorinq';
  const isAdmin = profile?.system_role === 'super_admin';
  const nav = isAdmin ? [
    ['admin.html','⌂','Dashboard','dashboard'],
    ['admin.html#organizations','▦','Təşkilatlar','organizations'],
    ['admin.html#users','👥','İstifadəçilər','users'],
    ['admin.html#catalogs','◎','Ərazi & Vəzifə','catalogs'],
    ['admin.html#monitoring','◉','Monitorinq','monitoring'],
    ['admin.html#billing','₼','Abunəlik','billing'],
    ['admin.html#audit','≡','Audit Log','audit']
  ] : [
    ['app.html','⌂','Əsas','dashboard'],
    ['monitorinq.html','◉','Monitorinq','monitoring'],
    ['app.html#notifications','!','Bildirişlər','notifications'],
    ['hesabat.html','▥','Hesabat','reports'],
    ['profile.html','●','Profil','profile']
  ];

  const sidebar = document.querySelector('#sidebar');
  if (sidebar) sidebar.innerHTML = `
    <div class="brand"><div class="brand-mark">MM</div><div><strong>Media Monitorinq</strong><small>Rəqəmsal monitorinq</small></div></div>
    <nav class="nav">${nav.map(([href,icon,label,key])=>`<a href="${href}" class="${key===active?'active':''}"><span>${icon}</span><span class="nav-label">${label}</span></a>`).join('')}</nav>
    <div class="sidebar-foot"><button class="sidebar-action" data-action="signout"><span>↪</span> Çıxış</button></div>`;

  const topbar = document.querySelector('#topbar');
  if (topbar) topbar.innerHTML = `
    <div class="topbar-left"><img class="state-emblem" src="./assets/img/state-emblem.svg" alt="Azərbaycan gerbi"><span class="topbar-kicker">Rəqəmsal Media<br>Monitorinq</span></div>
    <div class="topbar-center"><strong>${orgName}</strong><span>Rəqəmsal Media Monitorinq Sistemi</span></div>
    <div class="profile-chip" title="${profile.first_name||''} ${profile.last_name||''}"><div class="profile-text"><strong>${profile.first_name||''} ${profile.last_name||''}</strong><span>${profile.positions?.name || (isAdmin?'Super Administrator':'İstifadəçi')}</span></div><div class="avatar">${avatarText(profile)}</div></div>`;

  const bottom = document.querySelector('#bottom-nav');
  if (bottom) {
    const mobileNav = isAdmin ? nav.slice(0,5) : nav;
    bottom.innerHTML = mobileNav.map(([href,icon,label,key])=>`<a href="${href}" class="${key===active?'active':''}"><span class="bottom-icon">${icon}</span><small>${label}</small></a>`).join('');
  }

  document.querySelectorAll('[data-action="signout"]').forEach(el => el.addEventListener('click', signOut));
}
