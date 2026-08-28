import { supabase, escapeHtml } from './core.js';

export function isCentralScope(profile){
  return profile?.system_role === 'super_admin' || profile?.access_scope === 'all';
}

export async function setupOrganizationFilter(profile, select){
  if(!select || !isCentralScope(profile)){
    select?.classList.add('hidden');
    return select || null;
  }
  const {data,error}=await supabase.from('organizations').select('id,short_name,name,service_status').order('short_name');
  if(error) throw error;
  // Nazirlik / mərkəzi istifadəçi bütün reyestri görməlidir. Arxiv statusu yalnız
  // monitorinq işinin prioritetidir; filtrdən təşkilatı gizlətməməlidir.
  const items=(data||[]);
  select.innerHTML='<option value="">Bütün təşkilatlar</option>'+items.map(o=>`<option value="${o.id}">${escapeHtml(o.short_name||o.name||'Təşkilat')}</option>`).join('');
  select.classList.remove('hidden');
  return select;
}

export function applyOrganizationScope(query, profile, organizationId=''){
  if(isCentralScope(profile)) return organizationId ? query.eq('organization_id',organizationId) : query;
  return profile?.organization_id ? query.eq('organization_id',profile.organization_id) : query;
}
