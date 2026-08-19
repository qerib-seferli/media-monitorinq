import { getSessionProfile } from './core.js';

export async function requireAuth({ superAdmin = false } = {}) {
  const ctx = await getSessionProfile();
  if (!ctx.session) { location.href = './index.html'; return null; }
  if (!ctx.profile) { location.href = './index.html?error=profile'; return null; }
  if (!ctx.profile.is_active) { location.href = './blocked.html?reason=user'; return null; }
  if (superAdmin && ctx.profile.system_role !== 'super_admin') { location.href = './app.html'; return null; }
  if (!superAdmin && ctx.profile.system_role !== 'super_admin') {
    const status = ctx.organization?.service_status;
    if (!['active','grace'].includes(status)) { location.href = './blocked.html?reason=organization'; return null; }
  }
  return ctx;
}
