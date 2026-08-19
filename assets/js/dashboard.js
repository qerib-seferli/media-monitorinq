import { requireAuth } from './guard.js';
import { renderShell } from './shell.js';
import { supabase, escapeHtml, fmtDate, registerSW } from './core.js';
registerSW();
const ctx=await requireAuth(); if(!ctx) throw new Error('auth'); renderShell(ctx.profile,'dashboard');
document.querySelector('#hello').textContent=`Salam, ${ctx.profile.first_name||'İstifadəçi'}`;
const today=new Date();today.setHours(0,0,0,0);
const [{count:total},{count:critical},{count:negative},{count:positive},{data:latest},{data:notifs}] = await Promise.all([
 supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()),
 supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).gte('priority_score',81),
 supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).eq('sentiment','negative'),
 supabase.from('mentions').select('*',{count:'exact',head:true}).gte('detected_at',today.toISOString()).eq('sentiment','positive'),
 supabase.from('mentions').select('id,title,summary,source_platform,source_url,priority_score,sentiment,detected_at,mention_media(url,media_type)').order('detected_at',{ascending:false}).limit(6),
 supabase.from('notifications').select('*').order('created_at',{ascending:false}).limit(6)
]);
const items=[['Yeni qeydlər',total||0,'info'],['Yüksək risk',critical||0,'danger'],['Mənfi',negative||0,'warn'],['Müsbət',positive||0,'ok']];
document.querySelector('#metrics').innerHTML=items.map(([l,n,c])=>`<article class="card metric"><span class="badge ${c}">${escapeHtml(l)}</span><div class="num">${n}</div><div class="label">Bu gün</div></article>`).join('');
const latestEl=document.querySelector('#latest');latestEl.innerHTML=latest?.length?latest.map(m=>`<article class="mention-card"><img class="thumb" src="${m.mention_media?.[0]?.url||'./assets/img/icon.svg'}" alt=""><div><h3>${escapeHtml(m.title||'Adsız qeyd')}</h3><p>${escapeHtml(m.summary||'')}</p><div class="mention-meta"><span class="badge info">${escapeHtml(m.source_platform||'Web')}</span><span class="badge ${m.priority_score>=81?'danger':'warn'}">${m.priority_score||0}%</span><span class="muted">${fmtDate(m.detected_at)}</span></div></div><a class="btn secondary" href="./monitorinq.html?id=${m.id}">Aç</a></article>`).join(''):'<div class="empty">Hələ nəticə yoxdur.</div>';
const n=document.querySelector('#notif-list');n.innerHTML=notifs?.length?notifs.map(x=>`<div style="padding:12px 0;border-bottom:1px solid var(--line)"><strong>${escapeHtml(x.title||'Bildiriş')}</strong><p class="muted" style="margin:4px 0 0">${escapeHtml(x.body||'')}</p></div>`).join(''):'<div class="empty">Yeni bildiriş yoxdur.</div>';
