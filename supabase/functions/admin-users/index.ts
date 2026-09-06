import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const admin = createClient(url, service);

    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) throw new Error('İcazəsiz sorğu');
    const { data: profile } = await admin.from('profiles').select('id,system_role,is_active,email').eq('auth_user_id', user.id).maybeSingle();
    if (!profile?.is_active || profile.system_role !== 'super_admin') throw new Error('Bu əməliyyat üçün Super Admin icazəsi lazımdır');

    const body = await req.json();
    if (body.action === 'create') {
      const accessScope = body.access_scope === 'all' ? 'all' : 'organization';
      if (!body.email || !body.password || (accessScope !== 'all' && !body.organization_id)) throw new Error('Məcburi sahələr çatışmır');
      let servicePointId = accessScope === 'all' ? null : (body.service_point_id || null);
      if (servicePointId) {
        const { data: point, error: pointError } = await admin.from('organization_service_points').select('id,organization_id,is_active').eq('id', servicePointId).maybeSingle();
        if (pointError) throw pointError;
        if (!point?.id || point.is_active === false) throw new Error('Seçilən tabeli vahid aktiv deyil və ya tapılmadı');
        if (String(point.organization_id) !== String(body.organization_id)) throw new Error('Tabeli vahid seçilən təşkilata aid deyil');
      }
      if (String(body.password).length < 8) throw new Error('Şifrə ən az 8 simvol olmalıdır');
      const { data, error } = await admin.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: { first_name: body.first_name || '', last_name: body.last_name || '' }
      });
      if (error) throw error;
      const profileRow = {
        auth_user_id: data.user.id,
        organization_id: accessScope === 'all' ? null : body.organization_id,
        service_point_id: servicePointId,
        access_scope: accessScope,
        position_id: body.position_id || null,
        first_name: body.first_name || '',
        last_name: body.last_name || '',
        email: body.email,
        system_role: body.system_role || 'viewer',
        is_active: true
      };
      const { error: pError } = await admin.from('profiles').upsert(profileRow, { onConflict:'auth_user_id' });
      if (pError) {
        await admin.auth.admin.deleteUser(data.user.id).catch(()=>{});
        throw pError;
      }
      await admin.from('audit_logs').insert({actor_profile_id:profile.id,actor_email:profile.email,organization_id:accessScope === 'all' ? null : body.organization_id,action:'İstifadəçi yaradıldı',entity_type:'profile',entity_id:data.user.id,details:{email:body.email,role:body.system_role,access_scope:accessScope,service_point_id:servicePointId}});
      return json({ ok: true, message: 'İstifadəçi hesabı yaradıldı', user_id: data.user.id });
    }

    if (body.action === 'reset_password') {
      if (!body.auth_user_id || !body.password) throw new Error('İstifadəçi və yeni şifrə tələb olunur');
      if (String(body.password).length < 8) throw new Error('Şifrə ən az 8 simvol olmalıdır');
      const { error } = await admin.auth.admin.updateUserById(body.auth_user_id, { password: body.password });
      if (error) throw error;
      await admin.from('audit_logs').insert({actor_profile_id:profile.id,actor_email:profile.email,action:'İstifadəçi şifrəsi sıfırlandı',entity_type:'auth_user',entity_id:body.auth_user_id});
      return json({ ok: true, message: 'Şifrə yeniləndi' });
    }

    throw new Error('Naməlum əməliyyat');
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 400);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
}
