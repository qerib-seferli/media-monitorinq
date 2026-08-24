import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

type Item = { title?:string; text?:string; url?:string; published_at?:string|null; image?:string|null; author?:string|null; raw?:unknown };
type DiagnosticError = { stage:string; organization?:string|null; source?:string|null; message:string; code?:string|null; status?:number|null };

const RUN_BUDGET_MS = 48000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});

  const startedAt = Date.now();
  const stopAt = startedAt + RUN_BUDGET_MS;
  const runId = crypto.randomUUID();
  const details:any[] = [];
  const errors:DiagnosticError[] = [];
  let checked = 0;
  let inserted = 0;
  let failures = 0;
  let currentStage = 'bootstrap';

  const fail = (stage:string, e:unknown, organization?:string|null, source?:string|null) => {
    failures++;
    const info = errorInfo(e);
    const row:DiagnosticError = { stage, organization:organization || null, source:source || null, ...info };
    errors.push(row);
    console.error(`[monitor-worker:${runId}]`, row);
  };

  try {
    currentStage = 'environment';
    const url = Deno.env.get('SUPABASE_URL') || '';
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !service) {
      return json({ok:false,run_id:runId,stage:currentStage,failures:1,errors:[{stage:currentStage,message:'Supabase environment dəyişənləri tapılmadı'}],details},200);
    }

    const admin = createClient(url, service);
    const options = await readRunOptions(req);
    let callerOrganizationId:string|null = null;

    currentStage = 'authorization';
    const expected = Deno.env.get('MONITOR_SECRET') || '';
    const secretOk = Boolean(expected && req.headers.get('x-monitor-secret') === expected);
    if (!secretOk) {
      const authHeader = req.headers.get('Authorization') || '';
      const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
      if (!anon) return json({ok:false,run_id:runId,stage:currentStage,error:'SUPABASE_ANON_KEY tapılmadı'},403);
      const caller = createClient(url, anon, { global:{ headers:{ Authorization:authHeader } } });
      const authResult:any = await caller.auth.getUser().catch((e:unknown)=>({data:null,error:e}));
      const user = authResult?.data?.user || null;
      if (!user) return json({ok:false,run_id:runId,stage:currentStage,error:'İcazəsiz monitor sorğusu'},403);

      const profileResult:any = await admin.from('profiles').select('system_role,is_active,organization_id').eq('auth_user_id',user.id).maybeSingle();
      if (profileResult?.error) return json({ok:false,run_id:runId,stage:currentStage,error:errorInfo(profileResult.error).message},403);
      const profile = profileResult?.data || null;
      if (!profile?.is_active) return json({ok:false,run_id:runId,stage:currentStage,error:'Hesab aktiv deyil'},403);
      if (profile.system_role !== 'super_admin') {
        if (!options.quick_youtube_comments || !profile.organization_id) {
          return json({ok:false,run_id:runId,stage:currentStage,error:'Bu monitor sorğusu üçün icazə yoxdur'},403);
        }
        callerOrganizationId = String(profile.organization_id);
      }
    }

    currentStage = 'organizations';
    let orgQuery:any = admin.from('organizations')
      .select('id,name,short_name,district_id,districts(name),show_district_wide,sources(*)')
      .in('service_status',['active','grace']);
    if (callerOrganizationId) orgQuery = orgQuery.eq('id', callerOrganizationId);
    const orgResult:any = await orgQuery;
    if (!orgResult || orgResult.error) {
      const err = orgResult?.error || new Error('Təşkilat sorğusundan cavab alınmadı');
      return json({ok:false,run_id:runId,stage:currentStage,failures:1,errors:[{stage:currentStage,...errorInfo(err)}],details},200);
    }
    const orgs = Array.isArray(orgResult.data) ? orgResult.data : [];

    // Web/Xəbər xarici şəbəkə sorğuları Supabase Edge datacenter-lərində Google News
    // və GDELT tərəfindən abort/503 ala bilir. Production discovery GitHub Actions
    // gateway-dən aparılır; Edge Function isə yalnız planı verir və tapılan materialları
    // mövcud eyni filtr/saxlama məntiqi ilə qəbul edir. Beləliklə tenant məntiqi və
    // aidiyyət filtri iki yerdə təkrarlanmır.
    if (options.mode === 'news_plan') {
      const organizations = orgs.map((org:any)=>({
        id:String(org.id),
        name:String(org.name || ''),
        short_name:String(org.short_name || ''),
        district:String(org.districts?.name || ''),
        // GitHub gateway bir run-da bütün sorğuları eyni anda vurmayacaq. Burada geniş
        // namizəd bankı veririk, gateway identity + rotasiya olunan mövzu sorğularını
        // seçir. Bu həm 429/503 riskini azaldır, həm də hər 5 dəqiqə fərqli mövzunu
        // yoxlayaraq suvarma/meliorasiya əhatəsini mərhələli şəkildə genişləndirir.
        google_queries:buildGoogleNewsGatewayQueries(org),
        gdelt_queries:buildGdeltGatewayQueries(org),
        rss_sources:(Array.isArray(org.sources)?org.sources:[])
          .filter((source:any)=>source?.is_active !== false)
          .map((source:any)=>({
            id:String(source?.id || ''),
            platform:String(source?.platform || ''),
            url:String(source?.url || ''),
            name:String(source?.name || source?.platform || source?.url || '')
          }))
          .filter((source:any)=>Boolean(source.url) && !/youtube\.com|youtu\.be/i.test(source.url))
          // Media portal bankı yüzlərlə mənbə ola bilər. Gateway özü onları
          // rotasiya ilə kiçik paketlərdə yoxlayır; burada ilk 30 mənbə ilə
          // kəsmək qalan saytların heç vaxt monitorinqə düşməsinə səbəb olurdu.
          .slice(0,1000)
      }));
      return json({ok:true,run_id:runId,mode:'news_plan',organizations},200);
    }

    if (options.mode === 'news_enrich') {
      const org = orgs.find((x:any)=>String(x.id) === String(options.organization_id || ''));
      if (!org) return json({ok:false,run_id:runId,mode:'news_enrich',error:'Təşkilat tapılmadı'},200);
      if (!options.source_url) return json({ok:false,run_id:runId,mode:'news_enrich',error:'source_url tələb olunur'},200);
      try {
        const current:any = await admin.from('mentions')
          .select('id,raw_payload')
          .eq('organization_id',org.id)
          .eq('source_url',options.source_url)
          .order('published_at',{ascending:false,nullsFirst:false})
          .limit(1)
          .maybeSingle();
        if (current?.error) throw current.error;
        if (!current?.data?.id) return json({ok:true,run_id:runId,mode:'news_enrich',updated:false,skipped:'mention-not-found'},200);
        const patch:any = {last_seen_at:new Date().toISOString(),last_verified_at:new Date().toISOString(),source_status:'active'};
        if (options.news_title) patch.title=options.news_title;
        if (options.news_text) {
          patch.original_text=options.news_text;
          patch.summary=clean(options.news_text).slice(0,700);
        }
        if (options.news_published_at) patch.published_at=options.news_published_at;
        if (options.news_author) patch.author_name=options.news_author;
        patch.raw_payload={...(current.data.raw_payload||{}),enriched:true,canonical_url:options.canonical_url||options.source_url,image_url:options.image_url||undefined};
        const updated:any = await admin.from('mentions').update(patch).eq('id',current.data.id);
        if (updated?.error) throw updated.error;
        return json({ok:true,run_id:runId,mode:'news_enrich',updated:true,mention_id:current.data.id},200);
      } catch(e) {
        return json({ok:false,run_id:runId,mode:'news_enrich',updated:false,error:errorInfo(e).message},200);
      }
    }

    if (options.mode === 'news_media') {
      const org = orgs.find((x:any)=>String(x.id) === String(options.organization_id || ''));
      if (!org) return json({ok:false,run_id:runId,mode:'news_media',error:'Təşkilat tapılmadı'},200);
      if (!options.source_url || !options.image_base64) return json({ok:false,run_id:runId,mode:'news_media',error:'source_url və image_base64 tələb olunur'},200);
      try {
        const mentionResult:any = await admin.from('mentions')
          .select('id,title,mention_media(id,media_type,url)')
          .eq('organization_id',org.id)
          .eq('source_url',options.source_url)
          .order('published_at',{ascending:false,nullsFirst:false})
          .limit(1)
          .maybeSingle();
        if (mentionResult?.error) throw mentionResult.error;
        const mention=mentionResult?.data||null;
        if(!mention?.id) return json({ok:true,run_id:runId,mode:'news_media',saved:false,skipped:'mention-not-found'},200);
        const mediaType=options.media_type==='screenshot'?'screenshot':'preview';
        const already=(Array.isArray(mention.mention_media)?mention.mention_media:[]).some((m:any)=>String(m?.media_type||'').toLowerCase()===mediaType && /supabase\.co\/storage\/v1\/object\/public\//i.test(String(m?.url||'')));
        if(already) return json({ok:true,run_id:runId,mode:'news_media',saved:false,skipped:'already-exists'},200);
        const mime=/^image\/(png|jpeg|webp)$/i.test(options.mime_type)?options.mime_type.toLowerCase():'image/jpeg';
        const ext=mime.includes('png')?'png':mime.includes('webp')?'webp':'jpg';
        const binary=decodeBase64(options.image_base64);
        if(!binary.length||binary.length>3_000_000) return json({ok:true,run_id:runId,mode:'news_media',saved:false,skipped:'invalid-or-too-large'},200);
        const bucket='monitor-screenshots';
        await ensurePublicBucket(admin,bucket);
        const now=new Date();
        const path=`${org.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${mention.id}-${mediaType}-${crypto.randomUUID().slice(0,8)}.${ext}`;
        const upload:any=await admin.storage.from(bucket).upload(path,binary,{contentType:mime,upsert:false,cacheControl:'31536000'});
        if(upload?.error) throw upload.error;
        const publicResult:any=admin.storage.from(bucket).getPublicUrl(path);
        const publicUrl=publicResult?.data?.publicUrl||'';
        if(!publicUrl) throw new Error('Media public URL yaradılmadı');
        const mediaInsert:any=await admin.from('mention_media').insert({mention_id:mention.id,media_type:mediaType,url:publicUrl,captured_at:new Date().toISOString()});
        if(mediaInsert?.error) throw mediaInsert.error;
        return json({ok:true,run_id:runId,mode:'news_media',saved:true,mention_id:mention.id,url:publicUrl,media_type:mediaType},200);
      }catch(e){return json({ok:false,run_id:runId,mode:'news_media',saved:false,error:errorInfo(e).message},200);}
    }

    if (options.mode === 'news_screenshot') {
      const org = orgs.find((x:any)=>String(x.id) === String(options.organization_id || ''));
      if (!org) return json({ok:false,run_id:runId,mode:'news_screenshot',error:'Təşkilat tapılmadı'},200);
      if (!options.source_url || !options.image_base64) {
        return json({ok:false,run_id:runId,mode:'news_screenshot',error:'source_url və image_base64 tələb olunur'},200);
      }
      try {
        const mentionResult:any = await admin.from('mentions')
          .select('id,title,mention_media(id,media_type,url)')
          .eq('organization_id',org.id)
          .eq('source_url',options.source_url)
          .order('published_at',{ascending:false,nullsFirst:false})
          .limit(1)
          .maybeSingle();
        if (mentionResult?.error) throw mentionResult.error;
        const mention = mentionResult?.data || null;
        if (!mention?.id) return json({ok:true,run_id:runId,mode:'news_screenshot',saved:false,skipped:'mention-not-found'},200);
        const already = (Array.isArray(mention.mention_media)?mention.mention_media:[])
          .some((m:any)=>String(m?.media_type||'').toLowerCase()==='screenshot');
        if (already) return json({ok:true,run_id:runId,mode:'news_screenshot',saved:false,skipped:'already-exists'},200);

        const mime = /^image\/(png|jpeg|webp)$/i.test(options.mime_type) ? options.mime_type.toLowerCase() : 'image/jpeg';
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        const binary = decodeBase64(options.image_base64);
        if (!binary.length || binary.length > 3_000_000) {
          return json({ok:true,run_id:runId,mode:'news_screenshot',saved:false,skipped:'invalid-or-too-large'},200);
        }
        const bucket='monitor-screenshots';
        await ensurePublicBucket(admin,bucket);
        const now=new Date();
        const path=`${org.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${mention.id}-${crypto.randomUUID().slice(0,8)}.${ext}`;
        const upload:any = await admin.storage.from(bucket).upload(path,binary,{contentType:mime,upsert:false,cacheControl:'31536000'});
        if (upload?.error) throw upload.error;
        const publicResult:any = admin.storage.from(bucket).getPublicUrl(path);
        const publicUrl = publicResult?.data?.publicUrl || '';
        if (!publicUrl) throw new Error('Screenshot public URL yaradılmadı');
        const mediaInsert:any = await admin.from('mention_media').insert({mention_id:mention.id,media_type:'screenshot',url:publicUrl,captured_at:new Date().toISOString()});
        if (mediaInsert?.error) throw mediaInsert.error;
        return json({ok:true,run_id:runId,mode:'news_screenshot',saved:true,mention_id:mention.id,url:publicUrl},200);
      } catch (e) {
        return json({ok:false,run_id:runId,mode:'news_screenshot',saved:false,error:errorInfo(e).message},200);
      }
    }

    if (options.mode === 'news_ingest') {
      const org = orgs.find((x:any)=>String(x.id) === String(options.organization_id || ''));
      if (!org) return json({ok:false,run_id:runId,mode:'news_ingest',error:'Təşkilat tapılmadı'},200);

      const activeKeywordRows = await fetchOrganizationKeywords(admin, org.id, 12000);
      const keywords = activeKeywordRows
        .filter((k:any)=>String(k?.kind || '').toLowerCase() !== 'exclude')
        .map((k:any)=>String(k?.value || '').trim()).filter(Boolean);
      const excludeTerms = activeKeywordRows
        .filter((k:any)=>String(k?.kind || '').toLowerCase() === 'exclude')
        .map((k:any)=>String(k?.value || '').trim()).filter(Boolean);
      org.__exclude_terms = excludeTerms;
      org.__normalized_keywords = [...new Set(keywords.map((k:string)=>normalizeForMatch(k)).filter(Boolean))];
      org.__normalized_excludes = [...new Set(excludeTerms.map((k:string)=>normalizeForMatch(k)).filter(Boolean))];
      const lowerKeywords = keywords.map((k:string)=>k.toLocaleLowerCase('az-AZ'));

      let villageNames:string[] = [];
      if (org.district_id) {
        const villageResult:any = await admin.from('villages').select('name').eq('district_id', org.district_id).order('name');
        if (villageResult?.error) throw villageResult.error;
        villageNames = (Array.isArray(villageResult?.data) ? villageResult.data : []).map((x:any)=>String(x?.name || '').trim()).filter(Boolean);
      }

      const source = {platform:canonicalPlatform(options.source_platform || 'Web'),url:options.source_label || 'GitHub News Gateway'};
      let accepted = 0;
      let rejected = 0;
      let saved = 0;
      const samples:any[] = [];
      const acceptedItems:Item[] = [];
      for (const item of dedupeItems(options.news_items || []).slice(0,250)) {
        const match = evaluateMatch(org,item,lowerKeywords,villageNames);
        if (match.accepted) accepted++; else rejected++;
        if (samples.length < 10) samples.push({title:item.title || '',url:item.url || '',accepted:match.accepted,reason:match.reason,matched_terms:match.matches});
        if (!match.accepted) continue;
        acceptedItems.push(item);
        saved += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,options.source_label || options.source_platform || 'News Gateway');
      }

      const acceptedTargets=acceptedItems.map((x:Item)=>({title:x.title||'',text:x.text||'',url:x.url||'',published_at:x.published_at||null,image:x.image||null,author:x.author||null,raw:x.raw||{}})).filter((x:any)=>Boolean(x.url)).slice(0,80);
      const acceptedUrls=[...new Set(acceptedTargets.map((x:any)=>String(x.url||'')).filter(Boolean))].slice(0,80);
      const screenshotTargets:any[]=[];
      if (acceptedUrls.length) {
        const mr:any = await admin.from('mentions')
          .select('id,title,source_url,published_at,mention_media(media_type,url)')
          .eq('organization_id',org.id)
          .in('source_url',acceptedUrls)
          .order('published_at',{ascending:false,nullsFirst:false});
        if (!mr?.error) {
          for (const row of (Array.isArray(mr?.data)?mr.data:[])) {
            const hasScreenshot=(Array.isArray(row?.mention_media)?row.mention_media:[]).some((m:any)=>String(m?.media_type||'').toLowerCase()==='screenshot');
            if (!hasScreenshot && row?.source_url) screenshotTargets.push({mention_id:row.id,title:row.title||'',url:row.source_url,published_at:row.published_at||null});
            if (screenshotTargets.length >= 12) break;
          }
        }
      }
      return json({ok:true,run_id:runId,mode:'news_ingest',organization:org.short_name,source_platform:source.platform,received:(options.news_items||[]).length,accepted,rejected,inserted:saved,sample_results:samples,accepted_targets:acceptedTargets,screenshot_targets:screenshotTargets,errors},200);
    }

    for (const org of orgs) {
      if (Date.now() >= stopAt) {
        details.push({organization:org.short_name,source:'Run büdcəsi',skipped:'time-budget'});
        break;
      }

      // Açar söz bankı minlərlə sətrə çata bilər. Embedded relation və PostgREST
      // limitlərinə ilişməmək üçün təşkilat üzrə səhifəli şəkildə ayrıca oxuyuruq.
      const activeKeywordRows = await fetchOrganizationKeywords(admin, org.id, 12000);
      const keywords = activeKeywordRows
        .filter((k:any)=>String(k?.kind || '').toLowerCase() !== 'exclude')
        .map((k:any)=>String(k?.value || '').trim())
        .filter(Boolean);
      const excludeTerms = activeKeywordRows
        .filter((k:any)=>String(k?.kind || '').toLowerCase() === 'exclude')
        .map((k:any)=>String(k?.value || '').trim())
        .filter(Boolean);
      org.__exclude_terms = excludeTerms;
      org.__normalized_keywords = [...new Set(keywords.map((k:string)=>normalizeForMatch(k)).filter(Boolean))];
      org.__normalized_excludes = [...new Set(excludeTerms.map((k:string)=>normalizeForMatch(k)).filter(Boolean))];
      const lowerKeywords = keywords.map((k:string)=>k.toLocaleLowerCase('az-AZ'));
      const sources = (Array.isArray(org.sources) ? org.sources : []).filter((s:any)=>s?.is_active !== false);

      let villageNames:string[] = [];
      if (org.district_id && Date.now() < stopAt) {
        currentStage = 'villages';
        try {
          const villageResult:any = await admin.from('villages').select('name').eq('district_id', org.district_id).order('name');
          if (villageResult?.error) throw villageResult.error;
          villageNames = (Array.isArray(villageResult?.data) ? villageResult.data : [])
            .map((x:any)=>String(x?.name || '').trim()).filter(Boolean);
        } catch (e) {
          fail(currentStage,e,org.short_name,'villages');
        }
      }

      if (!options.youtube_backfill && !options.quick_youtube_comments && options.edge_news_probe) {
        // Yalnız diaqnostik edge_news_probe=true olduqda Supabase datacenter-dən birbaşa
        // Google/GDELT sorğusu edilir. Production Web/Xəbər discovery GitHub gateway-dədir.
        if (timeLeft(stopAt) > 10000) {
          checked += 2;
          const [rssSettled, webSettled] = await Promise.allSettled([
            googleNewsItems(org, keywords, villageNames),
            gdeltNewsItems(org, keywords, villageNames)
          ]);

          currentStage = 'google-news';
          if (rssSettled.status === 'fulfilled') {
            const rssBatch = rssSettled.value;
            const rssItems = rssBatch.items;
            let newsCount = 0;
            for (const item of rssItems.slice(0,80)) {
              if (timeLeft(stopAt) < 1500) break;
              newsCount += await safeSave(admin,org,{platform:'Google News',url:'https://news.google.com/'},item,lowerKeywords,villageNames,errors,org.short_name,'Google News');
            }
            inserted += newsCount;
            details.push({ organization:org.short_name, source:'Google News RSS', found:rssItems.length, inserted:newsCount, query_count:rssBatch.queries.length, query_failures:rssBatch.failures.length, locales:rssBatch.locales, ...((options.debug || rssItems.length===0) ? { queries:rssBatch.queries, fetch_errors:rssBatch.failures.slice(0,4), sample_results:debugSamples(rssItems, org, lowerKeywords, villageNames, 8) } : {}) });
          } else fail(currentStage,rssSettled.reason,org.short_name,'Google News RSS');

          currentStage = 'gdelt-web-news';
          if (webSettled.status === 'fulfilled') {
            const webBatch = webSettled.value;
            const webItems = webBatch.items;
            let webCount = 0;
            for (const item of webItems.slice(0,100)) {
              if (timeLeft(stopAt) < 1500) break;
              webCount += await safeSave(admin,org,{platform:'Web',url:'https://api.gdeltproject.org/'},item,lowerKeywords,villageNames,errors,org.short_name,'GDELT');
            }
            inserted += webCount;
            details.push({ organization:org.short_name, source:'GDELT Web / Xəbər', found:webItems.length, inserted:webCount, query_count:webBatch.queries.length, query_failures:webBatch.failures.length, transport:webBatch.transport, ...((options.debug || webItems.length===0) ? { queries:webBatch.queries, fetch_errors:webBatch.failures.slice(0,4), sample_results:debugSamples(webItems, org, lowerKeywords, villageNames, 10) } : {}) });
          } else fail(currentStage,webSettled.reason,org.short_name,'GDELT');
        } else if (options.debug) {
          details.push({organization:org.short_name,source:'Google News RSS',skipped:'time-budget'});
          details.push({organization:org.short_name,source:'GDELT Web / Xəbər',skipped:'time-budget'});
        }
      } else if (options.debug) {
        details.push({
          organization:org.short_name,
          source:'Web / Xəbər lane-ləri',
          skipped:options.quick_youtube_comments
            ? 'quick-youtube-comments-focus'
            : options.youtube_backfill
              ? 'youtube-backfill-focus'
              : 'github-news-gateway',
          gateway:'GitHub Actions / scripts/news-gateway.mjs'
        });
      }

      for (const source of sources) {
        if (Date.now() >= stopAt) {
          details.push({organization:org.short_name,source:source?.url || source?.platform || 'Mənbə',skipped:'time-budget'});
          break;
        }
        checked++;
        const sourceLabel = String(source?.url || source?.platform || 'Mənbə');
        currentStage = `source:${String(source?.platform || 'web').toLowerCase()}`;
        try {
          const platform = String(source?.platform || 'Web').toLowerCase();
          if (options.quick_youtube_comments && platform !== 'youtube') {
            if (options.debug) details.push({organization:org.short_name,source:sourceLabel,skipped:'quick-youtube-comments-focus'});
            continue;
          }

          if (platform === 'youtube') {
            const last = source?.last_checked_at ? new Date(source.last_checked_at).getTime() : 0;
            const key = Deno.env.get('YOUTUBE_API_KEY') || '';
            if (!key) {
              details.push({ organization:org.short_name, source:'YouTube', skipped:'missing-youtube-api-key' });
              continue;
            }

            if (options.quick_youtube_comments || (!options.force_youtube && last && Date.now() - last < 6 * 3600 * 1000)) {
              const live = await storedYoutubeRecentCommentItems(
                admin, org, key,
                options.full_comment_sweep ? 240 : 20,
                options.full_comment_sweep,
                Math.min(options.full_comment_sweep ? 30000 : 18000, Math.max(7000,timeLeft(stopAt)-3500)),
                options.focus_video_ids
              );
              let liveInserted = 0;
              let accepted = 0;
              let rejected = 0;
              for (const item of live.items) {
                if (Date.now() >= stopAt) break;
                const match = evaluateMatch(org,item,lowerKeywords,villageNames);
                if (match.accepted) accepted++; else rejected++;
                liveInserted += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,'YouTube şərhi');
              }
              let totalInserted = liveInserted;

              let backfill:any = null;
              if (!options.quick_youtube_comments && timeLeft(stopAt) > 9000) {
                try {
                  backfill = await storedYoutubeCommentBackfillStep(admin,org,key,6,Math.min(9000,timeLeft(stopAt)-2500));
                  for (const item of backfill.items) {
                    if (Date.now() >= stopAt) break;
                    totalInserted += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,'YouTube şərhi arxivi');
                  }
                  inserted += totalInserted;
                } catch (e) { fail('youtube-comment-backfill',e,org.short_name,'YouTube şərh arxivi'); }
              }

              if (!backfill) inserted += totalInserted;

              if (options.refilter_existing && timeLeft(stopAt) > 5000) {
                try {
                  const refilter = await refilterExistingMentions(admin,org,lowerKeywords,villageNames,250);
                  if (options.debug || refilter.filtered_out) details.push({organization:org.short_name,source:'Mövcud qeydlərin aidiyyət yoxlaması',...refilter});
                } catch (e) { fail('refilter-existing',e,org.short_name,'Aidiyyət yoxlaması'); }
              }

              details.push({
                organization:org.short_name,
                source:options.full_comment_sweep?'YouTube şərhləri — tam sürətli sweep':'YouTube şərhləri — sürətli yoxlama',
                videos_checked:live.videos_checked,
                comments_seen:live.comments_seen,
                candidate_videos:live.candidate_videos,
                focus_videos:live.focus_videos,
                comments_checked:live.items.length,
                comments_accepted:accepted,
                comments_rejected:rejected,
                inserted:totalInserted,
                video_search:'quota-window',
                ...(backfill ? { backfill_videos:backfill.videos_checked, backfill_comments:backfill.items.length } : {}),
                ...(options.debug ? { sample_results:debugSamples(live.items, org, lowerKeywords, villageNames, 10) } : {})
              });
              // last_checked_at yalnız video discovery baş verəndə yenilənir; şərh poll-u onu dəyişmir.
              continue;
            }

            const countResult:any = await admin.from('mentions')
              .select('id', { count:'exact', head:true })
              .eq('organization_id', org.id)
              .ilike('source_platform', 'youtube');
            if (countResult?.error) throw countResult.error;
            const existingYoutubeCount = Number(countResult?.count || 0);

            const discovery = await youtubeItems(
              org, keywords, villageNames, key,
              options.youtube_backfill ? null : (existingYoutubeCount ? source?.last_checked_at : null),
              1
            );

            let count = 0;
            for (const item of discovery.items) {
              if (Date.now() >= stopAt) break;
              count += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,'YouTube video');
            }
            for (const item of discovery.comments) {
              if (Date.now() >= stopAt) break;
              count += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,'YouTube şərhi');
            }

            inserted += count;
            details.push({
              organization:org.short_name,
              source:'YouTube Data API v3',
              queries:discovery.queries,
              videos_found:discovery.items.length,
              comments_checked:discovery.comments.length,
              inserted:count,
              ...(options.debug ? { sample_results:debugSamples([...discovery.items, ...discovery.comments], org, lowerKeywords, villageNames, 12) } : {})
            });
          } else if (
            platform === 'rss' ||
            source?.url?.match(/(\.xml|\.rss)(\?|$)/i) ||
            String(source?.url || '').includes('/rss')
          ) {
            const sourceUrl = String(source?.url || '').trim();
            if (sourceUrl.includes('news.google.com/rss/')) {
              details.push({ organization:org.short_name, source:sourceUrl, skipped:'duplicate-google-news-source' });
              await safeSourceTouch(admin,source?.id,errors,org.short_name,sourceLabel);
              continue;
            }
            const xml = await fetchTextWithRetry(sourceUrl, {headers:{'user-agent':'Mozilla/5.0 MediaMonitorinq/4.0','accept':'application/rss+xml, application/xml, text/xml, */*'}}, 1);
            const items = parseRss(xml);
            let count = 0;
            for (const item of items.slice(0,50)) {
              if (Date.now() >= stopAt) break;
              count += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,sourceUrl);
            }
            inserted += count;
            details.push({ organization:org.short_name, source:sourceUrl, found:items.length, inserted:count });
          } else {
            const web = await webSourceItems(source?.url, source?.name || source?.url);
            let count = 0;
            for (const item of web.items.slice(0,50)) {
              if (Date.now() >= stopAt) break;
              count += await safeSave(admin,org,source,item,lowerKeywords,villageNames,errors,org.short_name,sourceLabel);
            }
            inserted += count;
            details.push({ organization:org.short_name, source:source?.url, web_items:web.items.length, discovered_feeds:web.feeds, inserted:count });
          }

          await safeSourceTouch(admin,source?.id,errors,org.short_name,sourceLabel);
        } catch (e) {
          fail(currentStage,e,org.short_name,sourceLabel);
        }
      }

      if (options.verify_existing !== false && timeLeft(stopAt) > 7000) {
        currentStage = 'source-verification';
        try {
          const verification = await verifyExistingMentions(admin, org, Deno.env.get('YOUTUBE_API_KEY') || '');
          if (verification.checked || options.debug) details.push({ organization:org.short_name, source:'Mənbə mövcudluğu yoxlaması', ...verification });
        } catch (e) { fail(currentStage,e,org.short_name,'Mənbə mövcudluğu yoxlaması'); }
      }
    }

    return json({
      ok:failures === 0,
      run_id:runId,
      checked_sources:checked,
      new_mentions:inserted,
      failures,
      elapsed_ms:Date.now()-startedAt,
      stopped_by_budget:Date.now() >= stopAt,
      details,
      errors:options.debug ? errors.slice(0,40) : errors.slice(0,10)
    },200);
  } catch (e) {
    fail(currentStage,e,null,null);
    return json({
      ok:false,
      run_id:runId,
      stage:currentStage,
      checked_sources:checked,
      new_mentions:inserted,
      failures,
      elapsed_ms:Date.now()-startedAt,
      details,
      errors:errors.slice(0,40)
    },200);
  }
});

function timeLeft(stopAt:number) { return Math.max(0, stopAt - Date.now()); }
function sleep(ms:number) { return new Promise(resolve=>setTimeout(resolve,ms)); }

function errorInfo(e:unknown):{message:string;code?:string|null;status?:number|null} {
  if (e instanceof Error) return {message:e.message || 'Naməlum xəta',code:(e as any)?.code || null,status:Number((e as any)?.status || 0) || null};
  if (e && typeof e === 'object') {
    const x:any = e;
    return {message:String(x?.message || x?.error_description || x?.details || x?.hint || JSON.stringify(x) || 'Naməlum xəta'),code:x?.code || null,status:Number(x?.status || x?.statusCode || 0) || null};
  }
  return {message:String(e ?? 'Naməlum xəta'),code:null,status:null};
}

async function safeSave(admin:any,org:any,source:any,item:Item,keywords:string[],villages:string[],errors:DiagnosticError[],organization:string,sourceLabel:string) {
  try { return await save(admin,org,source,item,keywords,villages); }
  catch (e) {
    if (errors.length < 40) errors.push({stage:'save',organization,source:sourceLabel,...errorInfo(e)});
    console.error('save',organization,sourceLabel,errorInfo(e));
    return 0;
  }
}

async function safeSourceTouch(admin:any,sourceId:any,errors:DiagnosticError[],organization:string,sourceLabel:string) {
  if (!sourceId) return;
  try {
    const result:any = await admin.from('sources').update({last_checked_at:new Date().toISOString()}).eq('id',sourceId);
    if (result?.error && errors.length < 40) errors.push({stage:'source-touch',organization,source:sourceLabel,...errorInfo(result.error)});
  } catch (e) {
    if (errors.length < 40) errors.push({stage:'source-touch',organization,source:sourceLabel,...errorInfo(e)});
  }
}

async function googleNewsItems(org:any, keywords:string[], villages:string[]=[]):Promise<{items:Item[];queries:string[];failures:any[];locales:string[]}> {
  const bank = buildGoogleNewsQueries(org, keywords, villages);
  const queries = bank.length ? [bank[Math.floor(Date.now()/60000) % bank.length]] : [];
  const failures:any[] = [];
  const items:Item[] = [];
  const locales = [
    {hl:'az',gl:'AZ',ceid:'AZ:az',label:'az-AZ'},
    // Google News-in AZ endpoint-i bəzi datacenter-lərdən 503 verə bilir.
    // RU/EN endpoint-ləri eyni indeksə alternativ giriş rolunu oynayır.
    {hl:'ru',gl:'RU',ceid:'RU:ru',label:'ru-RU'},
    {hl:'en-US',gl:'US',ceid:'US:en',label:'en-US'}
  ];

  for (const query of queries) {
    const settled = await Promise.allSettled(locales.map(async locale=>{
      const googleUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(locale.hl)}&gl=${encodeURIComponent(locale.gl)}&ceid=${encodeURIComponent(locale.ceid)}`;
      const xml = await fetchTextWithRetry(googleUrl, {
        headers:{
          'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'accept':'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
          'accept-language':'az-AZ,az;q=0.9,ru;q=0.7,en;q=0.6',
          'cache-control':'no-cache'
        }
      },1,6500);
      return {locale:locale.label, items:parseRss(xml)};
    }));

    settled.forEach((result,index)=>{
      const locale = locales[index]?.label || 'unknown';
      if (result.status === 'fulfilled') {
        for (const item of result.value.items) {
          items.push({...item,raw:{...((item.raw as any)||{}),kind:'google_news',discovery_query:query,google_locale:locale}});
        }
      } else {
        failures.push({query,locale,...errorInfo(result.reason)});
      }
    });
  }
  return {items:dedupeItems(items),queries,failures,locales:locales.map(x=>x.label)};
}

async function gdeltNewsItems(org:any, keywords:string[], villages:string[]=[]):Promise<{items:Item[];queries:string[];failures:any[];transport:string}> {
  const queries = buildGdeltQueries(org, keywords, villages, 1);
  const failures:any[] = [];
  const items:Item[] = [];
  const transport = 'rssarchive';

  // DOC 2.0 ArtList RSS çıxışı JSON-dan daha yüngüldür və Edge runtime-da
  // response.json() gözləməsini aradan qaldırır. GDELT-in rəsmi sənədlərində
  // ArtList + format=rssarchive kombinasiyası dəstəklənir.
  for (const query of queries) {
    try {
      const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('mode', 'artlist');
      endpoint.searchParams.set('maxrecords', '35');
      endpoint.searchParams.set('format', 'rssarchive');
      endpoint.searchParams.set('sort', 'datedesc');
      endpoint.searchParams.set('timespan', '3months');

      const xml = await fetchTextWithRetry(endpoint.toString(), {
        headers:{
          'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/5.4; +public-news-monitoring)',
          'accept':'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.7',
          'accept-language':'az,en;q=0.8'
        }
      },1,11000);

      for (const item of parseRss(xml)) {
        items.push({...item,raw:{...((item.raw as any)||{}),kind:'gdelt_article',discovery_query:query,transport}});
      }
    } catch (e) {
      const info = errorInfo(e);
      failures.push({query,transport,...info});
      console.error('gdelt-query', query, info);
    }
  }

  return {items:dedupeItems(items),queries,failures,transport};
}

async function fetchOrganizationKeywords(admin:any, organizationId:string, maxRows=12000):Promise<any[]> {
  const pageSize = 1000;
  const rows:any[] = [];
  for (let from=0; from<maxRows; from+=pageSize) {
    const to = Math.min(from + pageSize - 1, maxRows - 1);
    const result:any = await admin.from('keywords')
      .select('id,organization_id,value,kind,is_active,created_at')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('created_at', {ascending:true})
      .range(from, to);
    if (!result || result.error) throw (result?.error || new Error('Açar söz bankı oxunmadı'));
    const batch = Array.isArray(result.data) ? result.data : [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

function buildDiscoveryQueries(org:any, keywords:string[], villages:string[] = [], max=8):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();

  const identity = [shortName, fullName].filter(Boolean);
  const coreTopics = [
    'suvarma','suvarma kanalı','kanal','arx','subartezian','artezian',
    'kollektor drenaj','meliorasiya','su təsərrüfatı','fermer su','su gəlmir','su çatışmazlığı'
  ];
  const core = district ? coreTopics.map(topic=>`${district} ${topic}`) : [];

  // Böyük açar-söz bankını hər run-da eyni ilk sətrlərlə məhdudlaşdırmırıq.
  // Dəqiqəlik rotasiya sayəsində discovery sorğuları kvotanı partlatmadan zamanla bütün
  // bankı dolaşır. Rayon/kənd adı olan frazalara üstünlük verilir.
  const nd = normalizeForMatch(district);
  const villageNorms = villages.map(normalizeForMatch).filter(Boolean);
  const bank = keywords.filter(value=>{
    const nk=normalizeForMatch(value);
    if (!nk || nk.length < 5) return false;
    if (nd && nk.includes(nd)) return true;
    return villageNorms.some(v=>v.length>=4 && nk.includes(v));
  });
  const bucket = Math.floor(Date.now()/60000);
  const rotated:string[] = [];
  if (bank.length) {
    const start = (bucket * Math.max(1, max-2)) % bank.length;
    for (let i=0;i<Math.min(bank.length, Math.max(4,max*3));i++) rotated.push(bank[(start+i)%bank.length]);
  }

  const pools = [identity.slice(0,1), core.slice(bucket % Math.max(1,core.length)), rotated, identity.slice(1), core];
  const seen = new Set<string>();
  const out:string[] = [];
  for (const pool of pools) {
    for (const candidate of pool) {
      const key = normalizeForMatch(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= max) return out;
    }
  }
  return out;
}
function buildGoogleNewsGatewayQueries(org:any):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();
  const candidates:string[] = [];

  // Əsas problem: dar təşkilat adı ilə RSS çox vaxt 0 qaytarır. İlk sorğular geniş
  // rayon discovery-sidir; news_ingest mərhələsində mövcud aidiyyət filtri lazımsız
  // materialları onsuz da rədd edir. Bu üç sorğu hər run-da işləyir.
  if (district) {
    candidates.push(`"${district}"`);
    candidates.push(`"${district}" suvarma`);
    candidates.push(`"${district}" subartezian`);
  }

  // 2026-cı ildə işlənən aktual adlandırmanı da ayrıca nəzərə alırıq. Bazadakı köhnə
  // "Suvarma Sistemlərinin..." adı saxlanılsa belə discovery yeni "Su Meliorasiya..."
  // formasını da yoxlayır; bazadakı məlumatı dəyişmirik.
  if (shortName) candidates.push(`"${shortName}"`);
  if (fullName) {
    candidates.push(`"${fullName}"`);
    const currentName = fullName.replace(/Suvarma Sistemlərinin/gi,'Su Meliorasiya Sistemlərinin');
    if (normalizeForMatch(currentName) !== normalizeForMatch(fullName)) candidates.push(`"${currentName}"`);
  }

  if (district) {
    const topicQueries = [
      'meliorasiya','suvarma suyu','su problemi','su gəlmir','su çatışmazlığı',
      'kanal','arx','drenaj','kollektor','artezian','su quyusu','nasos stansiyası',
      'əkin sahəsi','fermer','lildən təmizlənir','şoranlaşma'
    ];
    for (const topic of topicQueries) candidates.push(`"${district}" "${topic}"`);
  }

  const seen=new Set<string>();
  return candidates.filter(q=>{
    const key=normalizeForMatch(q);
    if(!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,28);
}

function buildGdeltGatewayQueries(org:any):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();
  const candidates:string[] = [];
  if (district) {
    candidates.push(`"${district}" (suvarma OR meliorasiya OR kanal OR arx OR subartezian OR artezian OR drenaj)`);
    candidates.push(`"${district}" ("su gəlmir" OR "su çatışmazlığı" OR fermer)`);
  }
  if (shortName) candidates.push(`"${shortName}"`);
  if (fullName && normalizeForMatch(fullName)!==normalizeForMatch(shortName)) candidates.push(`"${fullName}"`);
  const seen=new Set<string>();
  return candidates.filter(q=>{
    const key=normalizeForMatch(q);
    if(!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,6);
}

function buildGdeltQueries(org:any, keywords:string[], villages:string[] = [], max=1):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();
  const candidates:string[] = [];

  // GDELT üçün birinci sorğu geniş, amma aidiyyətli rayon+mövzu sorğusudur.
  // DOC API mötərizə daxilində OR bloklarını dəstəkləyir; boşluq terminlərin birlikdə
  // axtarılmasını təmin edir. Rayon yoxdursa təşkilat adı ilə fallback edirik.
  if (district) {
    candidates.push(`"${district}" (suvarma OR meliorasiya OR kanal OR arx OR subartezian OR artezian OR drenaj OR fermer)`);
    candidates.push(`"${district}" ("su gəlmir" OR "su çatışmazlığı")`);
  }
  if (shortName) candidates.push(`"${shortName}"`);
  if (fullName && normalizeForMatch(fullName) !== normalizeForMatch(shortName)) candidates.push(`"${fullName}"`);

  const seen=new Set<string>();
  const out:string[]=[];
  for (const q of candidates) {
    const key=normalizeForMatch(q);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if(out.length>=Math.max(1,max)) break;
  }
  return out;
}

function buildGoogleNewsQueries(org:any, keywords:string[], villages:string[]=[]):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();
  const candidates:string[] = [];

  // Google News üçün iki yüksək siqnallı sorğu kifayətdir. Minlərlə açar sözü
  // ayrıca HTTP sorğusuna çevirmək Supabase egress-dən Google-a burst yaradıb 503 verirdi.
  const identityParts = [shortName, fullName]
    .filter(Boolean)
    .filter((value,index,arr)=>arr.findIndex(x=>normalizeForMatch(x)===normalizeForMatch(value))===index)
    .map(value=>`"${value}"`);
  if (identityParts.length) candidates.push(identityParts.join(' OR '));
  if (district) {
    const aliases = districtAliases(district).map(value=>`"${value}"`).join(' OR ');
    candidates.push(`(${aliases}) (suvarma OR meliorasiya OR kanal OR arx OR subartezian OR artezian OR drenaj OR fermer OR "su gəlmir" OR "su çatışmazlığı")`);
  }

  // Rayon/təşkilat məlumatı natamamdırsa böyük bankdan yalnız bir fallback sorğu götür.
  if (candidates.length < 2) candidates.push(...buildDiscoveryQueries(org, keywords, villages, 1));

  const seen=new Set<string>();
  const out:string[]=[];
  for (const q of candidates) {
    const key=normalizeForMatch(q);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if(out.length>=2) break;
  }
  return out;
}

function districtAliases(value:string):string[] {
  const original = String(value || '').trim();
  if (!original) return [];
  const ascii = original
    .replace(/ə/g,'e').replace(/Ə/g,'E')
    .replace(/ğ/g,'g').replace(/Ğ/g,'G')
    .replace(/ı/g,'i').replace(/İ/g,'I')
    .replace(/ö/g,'o').replace(/Ö/g,'O')
    .replace(/ü/g,'u').replace(/Ü/g,'U')
    .replace(/ş/g,'s').replace(/Ş/g,'S')
    .replace(/ç/g,'c').replace(/Ç/g,'C');
  const aliases = [original, ascii];
  if (normalizeForMatch(original) === 'berde') aliases.push('Barda');
  if (normalizeForMatch(original) === 'agdam') aliases.push('Agdam');
  return [...new Set(aliases.filter(Boolean))];
}

function dedupeItems(items:Item[]):Item[] {
  const seen = new Set<string>();
  return items.filter(item=>{
    const key = String(item.url || '').trim() || normalizeForMatch(item.title || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gdeltDate(value:any):string|null {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return s || null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function canonicalPlatform(value:string) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'youtube') return 'YouTube';
  if (v === 'google news' || v === 'googlenews') return 'Web';
  if (v === 'facebook') return 'Facebook';
  if (v === 'instagram') return 'Instagram';
  if (v === 'tiktok') return 'TikTok';
  if (v === 'linkedin') return 'LinkedIn';
  if (v === 'x' || v === 'twitter') return 'X';
  return value ? String(value).trim() : 'Web';
}

function inferPlatform(value:string) {
  const host = String(value || '').toLowerCase();
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'YouTube';
  if (host.includes('instagram.com')) return 'Instagram';
  if (host.includes('tiktok.com')) return 'TikTok';
  if (host.includes('linkedin.com')) return 'LinkedIn';
  if (host.includes('x.com') || host.includes('twitter.com')) return 'X';
  if (host.includes('facebook.com')) return 'Facebook';
  return 'Web';
}

async function youtubeItems(
  org:any,
  keywords:string[],
  villages:string[],
  key:string,
  lastCheckedAt:string|null,
  maxPagesPerQuery=1
):Promise<{items:Item[]; comments:Item[]; queries:string[]}> {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();

  // Hər anlayış ayrıca sorğudur. Bir neçə açar sözü bir uzun cümləyə
  // birləşdirmək YouTube nəticələrini sıfırlayırdı.
  const queries = buildDiscoveryQueries(org, keywords, villages, 4);

  const lastMs = lastCheckedAt ? new Date(lastCheckedAt).getTime() : 0;
  const overlapMs = 2 * 3600 * 1000;
  const publishedAfter = lastMs && Number.isFinite(lastMs)
    ? new Date(lastMs - overlapMs).toISOString()
    : null;

  const searchItems:any[] = [];

  for (const q of queries) {
    let pageToken = '';
    for (let page = 0; page < Math.max(1, Math.min(maxPagesPerQuery, 3)); page++) {
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
      endpoint.searchParams.set('part','snippet');
      endpoint.searchParams.set('type','video');
      endpoint.searchParams.set('maxResults','25');
      endpoint.searchParams.set('order', lastCheckedAt ? 'date' : 'relevance');
      if (publishedAfter) endpoint.searchParams.set('publishedAfter',publishedAfter);
      endpoint.searchParams.set('q',q);
      endpoint.searchParams.set('relevanceLanguage','az');
      endpoint.searchParams.set('regionCode','AZ');
      endpoint.searchParams.set('key',key);
      if (pageToken) endpoint.searchParams.set('pageToken', pageToken);

      const data = await fetchJsonWithRetry(endpoint.toString(), {}, 2);
      if (data?.error) throw new Error(data.error?.message || 'YouTube Search API xətası');
      searchItems.push(...(data?.items || []));
      pageToken = String(data?.nextPageToken || '');
      if (!pageToken) break;
    }
  }

  const byVideoId = new Map<string,any>();
  for (const x of searchItems) {
    const id = String(x?.id?.videoId || '');
    if (id && !byVideoId.has(id)) byVideoId.set(id,x);
  }

  const videoIds = [...byVideoId.keys()].slice(0,250);
  const detailsById = new Map<string,any>();

  if (videoIds.length) {
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
      endpoint.searchParams.set('part','snippet,statistics,contentDetails');
      endpoint.searchParams.set('id',batch.join(','));
      endpoint.searchParams.set('key',key);
      const data = await fetchJsonWithRetry(endpoint.toString(), {}, 2);
      if (data?.error) throw new Error(data.error?.message || 'YouTube Videos API xətası');
      for (const v of data?.items || []) detailsById.set(String(v.id),v);
    }
  }

  const items:Item[] = videoIds.map((videoId:string)=>{
    const search = byVideoId.get(videoId) || {};
    const detail = detailsById.get(videoId) || {};
    const snippet = detail.snippet || search.snippet || {};
    return {
      title:snippet.title || '',
      text:snippet.description || '',
      url:`https://www.youtube.com/watch?v=${videoId}`,
      published_at:snippet.publishedAt || null,
      image:snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || null,
      author:snippet.channelTitle || null,
      raw:{
        kind:'youtube_video',
        video_id:videoId,
        channel_id:snippet.channelId || null,
        statistics:detail.statistics || null,
        content_details:detail.contentDetails || null,
        search
      }
    };
  });

  const comments:Item[] = [];
  // Yalnız təşkilata uyğun videoların şərhləri oxunur. Hər videoda commentThreads
  // səhifələri ardıcıl gəzir; top-level şərhlərlə yanaşı API-nin qaytardığı cavablar
  // da ayrıca qeyd kimi saxlanılır. Uzun arxiv run-larında vaxt limiti aşılmasın deyə
  // təhlükəsiz deadline tətbiq olunur və növbəti run qalan videoları yenidən yoxlaya bilir.
  const relevantForComments = items.filter(item=>evaluateMatch(org,item,keywords,villages).accepted).slice(0,12);
  const commentDeadline = Date.now() + 35000;
  for (const item of relevantForComments) {
    if (Date.now() > commentDeadline) break;
    const raw:any = item.raw || {};
    const videoId = String(raw.video_id || '');
    if (!videoId) continue;
    try {
      let pageToken = '';
      let pageCount = 0;
      while (pageCount < 12 && Date.now() <= commentDeadline) {
        const endpoint = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
        endpoint.searchParams.set('part','snippet,replies');
        endpoint.searchParams.set('videoId',videoId);
        endpoint.searchParams.set('maxResults','100');
        endpoint.searchParams.set('order','time');
        endpoint.searchParams.set('textFormat','plainText');
        if (pageToken) endpoint.searchParams.set('pageToken',pageToken);
        endpoint.searchParams.set('key',key);
        const data = await fetchJsonWithRetry(endpoint.toString(), {}, 1);
        if (data?.error) break;

        for (const thread of data?.items || []) {
          const top = thread?.snippet?.topLevelComment;
          const sn = top?.snippet || {};
          const commentId = String(top?.id || thread?.id || '');
          const text = String(sn.textDisplay || sn.textOriginal || '').trim();
          if (commentId && text) comments.push({
            title:`YouTube şərhi — ${sn.authorDisplayName || 'istifadəçi'}`,
            text:`Video: ${item.title || ''}
Şərh: ${text}`,
            url:`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(commentId)}`,
            published_at:sn.publishedAt || null,
            image:item.image || null,
            author:sn.authorDisplayName || null,
            raw:{
              kind:'youtube_comment',
              video_id:videoId,
              comment_id:commentId,
              video_title:item.title || '',
              like_count:sn.likeCount ?? null,
              reply_count:thread?.snippet?.totalReplyCount ?? 0,
              author_channel_url:sn.authorChannelUrl || null,
              author_channel_id:sn.authorChannelId?.value || null
            }
          });

          for (const reply of thread?.replies?.comments || []) {
            const rs = reply?.snippet || {};
            const replyId = String(reply?.id || '');
            const replyText = String(rs.textDisplay || rs.textOriginal || '').trim();
            if (!replyId || !replyText) continue;
            comments.push({
              title:`YouTube cavabı — ${rs.authorDisplayName || 'istifadəçi'}`,
              text:`Video: ${item.title || ''}
Cavab: ${replyText}`,
              url:`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(replyId)}`,
              published_at:rs.publishedAt || null,
              image:item.image || null,
              author:rs.authorDisplayName || null,
              raw:{
                kind:'youtube_comment_reply',
                video_id:videoId,
                comment_id:replyId,
                parent_id:rs.parentId || commentId || null,
                video_title:item.title || '',
                like_count:rs.likeCount ?? null,
                author_channel_url:rs.authorChannelUrl || null,
                author_channel_id:rs.authorChannelId?.value || null
              }
            });
          }
        }
        pageCount++;
        pageToken = String(data?.nextPageToken || '');
        if (!pageToken) break;
      }
    } catch (e) {
      console.error('youtube-comments',videoId,e);
    }
  }

  return { items, comments:dedupeItems(comments), queries };
}



async function storedYoutubeRecentCommentItems(
  admin:any,
  org:any,
  key:string,
  videoLimit=16,
  fullSweep=false,
  deadlineMs=18000,
  focusVideoIds:string[]=[]
):Promise<{items:Item[];videos_checked:number;comments_seen:number;candidate_videos:number;focus_videos:number}> {
  const result:any = await admin.from('mentions')
    .select('id,title,source_url,published_at,relevance_score,raw_payload,mention_media(url,media_type)')
    .eq('organization_id',org.id)
    .ilike('source_platform','youtube')
    .gt('relevance_score',0)
    .not('source_url','is',null)
    .order('published_at',{ascending:false,nullsFirst:false})
    .limit(300);
  if (result?.error) throw result.error;

  const byId = new Map<string,any>();
  for (const row of (Array.isArray(result?.data)?result.data:[])) {
    const raw=row?.raw_payload||{};
    if (String(raw?.kind||'').includes('comment') || raw?.comment_id) continue;
    const videoId=String(raw?.video_id||youtubeVideoId(row?.source_url||'')||'');
    if(!videoId || byId.has(videoId)) continue;
    byId.set(videoId,row);
  }
  const allRows=[...byId.entries()].map(([videoId,row])=>({videoId,row}));
  if(!allRows.length) return {items:[],videos_checked:0,comments_seen:0,candidate_videos:0,focus_videos:0};

  const chosen:any[]=[];
  const seen=new Set<string>();
  const push=(entry:any)=>{
    if(!entry || seen.has(entry.videoId)) return;
    seen.add(entry.videoId); chosen.push(entry);
  };

  for(const id of focusVideoIds||[]) push(allRows.find(x=>x.videoId===id));

  if(fullSweep){
    for(const entry of allRows) {
      push(entry);
      if(chosen.length>=Math.max(1,Math.min(videoLimit,240))) break;
    }
  }else{
    // Ən yeni real materiallar hər poll-da yoxlanılır.
    for(const entry of allRows.slice(0,8)) push(entry);

    // Qalan videolar dövr edən pəncərə ilə yoxlanılır ki, köhnə videoya yeni şərh də gecikməsin.
    const rest=allRows.filter(x=>!seen.has(x.videoId));
    const rotateCount=Math.max(0,videoLimit-chosen.length);
    if(rest.length && rotateCount){
      const slot=Math.floor(Date.now()/25000);
      const start=(slot*rotateCount)%rest.length;
      for(let i=0;i<rotateCount;i++) push(rest[(start+i)%rest.length]);
    }
  }

  const videoItems:Item[] = chosen.map(({videoId,row}:any)=>({
    title:row?.title||'',
    text:'',
    url:row?.source_url||`https://www.youtube.com/watch?v=${videoId}`,
    published_at:row?.published_at||null,
    image:(row?.mention_media||[])[0]?.url||null,
    raw:{
      kind:'youtube_video',
      video_id:videoId,
      parent_mention_id:row?.id||null,
      parent_relevance_score:Number(row?.relevance_score||1),
      parent_is_relevant:true
    }
  }));

  const sinceMs=Date.now()-72*3600*1000;
  const live=await youtubeRecentCommentsForItems(videoItems,key,50,sinceMs,deadlineMs);
  return {
    items:live.items,
    videos_checked:live.videos_checked,
    comments_seen:live.comments_seen,
    candidate_videos:allRows.length,
    focus_videos:chosen.filter(x=>(focusVideoIds||[]).includes(x.videoId)).length
  };
}

async function youtubeRecentCommentsForItems(
  videoItems:Item[],
  key:string,
  maxResults=40,
  sinceMs=0,
  deadlineMs=15000
):Promise<{items:Item[];videos_checked:number;comments_seen:number}> {
  const deadline = Date.now()+Math.max(6000,deadlineMs);
  const out:Item[]=[];
  let videosChecked=0;
  let commentsSeen=0;
  const concurrency = 8;

  for (let i=0;i<videoItems.length && Date.now()<deadline;i+=concurrency) {
    const batch=videoItems.slice(i,i+concurrency);
    const results = await Promise.all(batch.map(async item=>{
      if (Date.now()>=deadline) return {items:[] as Item[],seen:0,checked:0};
      const raw:any=item.raw||{};
      const videoId=String(raw.video_id||youtubeVideoId(item.url||'')||'');
      if(!videoId) return {items:[] as Item[],seen:0,checked:0};
      try{
        const endpoint=new URL('https://www.googleapis.com/youtube/v3/commentThreads');
        endpoint.searchParams.set('part','snippet,replies');
        endpoint.searchParams.set('videoId',videoId);
        endpoint.searchParams.set('maxResults',String(Math.max(1,Math.min(100,maxResults))));
        endpoint.searchParams.set('order','time');
        endpoint.searchParams.set('textFormat','plainText');
        endpoint.searchParams.set('key',key);
        const data=await fetchJsonWithRetry(endpoint.toString(),{},1,6500);
        const extracted=await commentItemsFromThreadData(data,item,videoId,key,deadline,sinceMs,true);
        return {items:extracted.items,seen:extracted.seen,checked:1};
      }catch(e){
        console.error('youtube-recent-comments',videoId,errorInfo(e));
        return {items:[] as Item[],seen:0,checked:1};
      }
    }));
    for(const r of results){out.push(...r.items);commentsSeen+=r.seen;videosChecked+=r.checked;}
  }
  return {items:dedupeItems(out),videos_checked:videosChecked,comments_seen:commentsSeen};
}

async function commentItemsFromThreadData(
  data:any,
  videoItem:Item,
  videoId:string,
  key:string,
  deadline:number,
  sinceMs=0,
  fetchAllReplies=false
):Promise<{items:Item[];seen:number}> {
  const out:Item[]=[];
  let seen=0;
  for(const thread of data?.items || []){
    if(Date.now()>=deadline) break;
    const top=thread?.snippet?.topLevelComment;
    const sn=top?.snippet||{};
    const commentId=String(top?.id||thread?.id||'');
    const text=String(sn.textDisplay||sn.textOriginal||'').trim();
    const published=sn.publishedAt||null;
    seen++;
    if(commentId&&text&&(!sinceMs || !published || new Date(published).getTime()>=sinceMs)){
      out.push(makeYoutubeCommentItem(videoItem,videoId,commentId,sn,null,Number(thread?.snippet?.totalReplyCount||0)));
    }

    const included=Array.isArray(thread?.replies?.comments)?thread.replies.comments:[];
    for(const reply of included){
      const rs=reply?.snippet||{};
      const replyId=String(reply?.id||'');
      const replyPublished=rs.publishedAt||null;
      seen++;
      if(replyId&&String(rs.textDisplay||rs.textOriginal||'').trim()&&(!sinceMs || !replyPublished || new Date(replyPublished).getTime()>=sinceMs)){
        out.push(makeYoutubeCommentItem(videoItem,videoId,replyId,rs,rs.parentId||commentId,0));
      }
    }

    const totalReplies=Number(thread?.snippet?.totalReplyCount||0);
    if(fetchAllReplies && commentId && totalReplies>included.length && Date.now()<deadline-1200){
      let pageToken='';
      do{
        if(Date.now()>=deadline-700) break;
        const ep=new URL('https://www.googleapis.com/youtube/v3/comments');
        ep.searchParams.set('part','snippet');
        ep.searchParams.set('parentId',commentId);
        ep.searchParams.set('maxResults','100');
        ep.searchParams.set('textFormat','plainText');
        ep.searchParams.set('key',key);
        if(pageToken)ep.searchParams.set('pageToken',pageToken);
        try{
          const replies=await fetchJsonWithRetry(ep.toString(),{},1,5500);
          for(const reply of replies?.items||[]){
            const rs=reply?.snippet||{};
            const replyId=String(reply?.id||'');
            const replyPublished=rs.publishedAt||null;
            seen++;
            if(replyId&&String(rs.textDisplay||rs.textOriginal||'').trim()&&(!sinceMs || !replyPublished || new Date(replyPublished).getTime()>=sinceMs)){
              out.push(makeYoutubeCommentItem(videoItem,videoId,replyId,rs,rs.parentId||commentId,0));
            }
          }
          pageToken=String(replies?.nextPageToken||'');
        }catch(e){console.error('youtube-replies',commentId,errorInfo(e));break;}
      }while(pageToken);
    }
  }
  return {items:dedupeItems(out),seen};
}

function makeYoutubeCommentItem(videoItem:Item,videoId:string,commentId:string,sn:any,parentId:string|null,replyCount=0):Item{
  const text=String(sn?.textDisplay||sn?.textOriginal||'').trim();
  const isReply=Boolean(parentId);
  return {
    title:`YouTube ${isReply?'cavabı':'şərhi'} — ${sn?.authorDisplayName||'istifadəçi'}`,
    text:`Video: ${videoItem.title||''}\n${isReply?'Cavab':'Şərh'}: ${text}`,
    url:`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(commentId)}`,
    published_at:sn?.publishedAt||null,
    image:videoItem.image||null,
    author:sn?.authorDisplayName||null,
    raw:{
      kind:isReply?'youtube_comment_reply':'youtube_comment',
      video_id:videoId,
      comment_id:commentId,
      parent_id:parentId||null,
      video_title:videoItem.title||'',
      like_count:sn?.likeCount??null,
      reply_count:replyCount||0,
      author_channel_url:sn?.authorChannelUrl||null,
      author_channel_id:sn?.authorChannelId?.value||null,
      parent_mention_id:(videoItem.raw as any)?.parent_mention_id||null,
      parent_is_relevant:(videoItem.raw as any)?.parent_is_relevant===true,
      parent_relevance_score:Number((videoItem.raw as any)?.parent_relevance_score||0)
    }
  };
}

async function storedYoutubeCommentBackfillStep(
  admin:any,
  org:any,
  key:string,
  videoLimit=2,
  deadlineMs=9000
):Promise<{items:Item[];videos_checked:number;inserted_hint:number}> {
  const deadline=Date.now()+Math.max(5000,deadlineMs);
  const result:any=await admin.from('mentions')
    .select('id,title,source_url,published_at,raw_payload,mention_media(url,media_type)')
    .eq('organization_id',org.id)
    .ilike('source_platform','youtube')
    .eq('raw_payload->>kind','youtube_video')
    .gt('relevance_score',0)
    .order('published_at',{ascending:false,nullsFirst:false})
    .limit(240);
  if(result?.error)throw result.error;
  const rows=(Array.isArray(result?.data)?result.data:[]).filter((r:any)=>r?.raw_payload?.comments_backfill_done!==true).slice(0,Math.max(1,videoLimit));
  const out:Item[]=[];
  let checked=0;
  for(const row of rows){
    if(Date.now()>=deadline-900)break;
    const raw={...(row?.raw_payload||{})};
    const videoId=String(raw.video_id||youtubeVideoId(row?.source_url||'')||'');
    if(!videoId)continue;
    const item:Item={title:row?.title||'',url:row?.source_url||`https://www.youtube.com/watch?v=${videoId}`,published_at:row?.published_at||null,image:(row?.mention_media||[])[0]?.url||null,raw:{kind:'youtube_video',video_id:videoId}};
    const endpoint=new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    endpoint.searchParams.set('part','snippet,replies');
    endpoint.searchParams.set('videoId',videoId);
    endpoint.searchParams.set('maxResults','100');
    endpoint.searchParams.set('order','time');
    endpoint.searchParams.set('textFormat','plainText');
    endpoint.searchParams.set('key',key);
    if(raw.comments_next_page_token)endpoint.searchParams.set('pageToken',String(raw.comments_next_page_token));
    try{
      const data=await fetchJsonWithRetry(endpoint.toString(),{},1,6000);
      const extracted=await commentItemsFromThreadData(data,item,videoId,key,deadline,0,true);
      out.push(...extracted.items);
      raw.comments_next_page_token=String(data?.nextPageToken||'')||null;
      raw.comments_backfill_done=!data?.nextPageToken;
      raw.comments_backfill_updated_at=new Date().toISOString();
      const update:any=await admin.from('mentions').update({raw_payload:raw}).eq('id',row.id);
      if(update?.error)throw update.error;
      checked++;
    }catch(e){console.error('youtube-comment-backfill',videoId,errorInfo(e));}
  }
  return {items:dedupeItems(out),videos_checked:checked,inserted_hint:0};
}

async function refilterExistingMentions(admin:any,org:any,keywords:string[],villages:string[],limit=250){
  const result:any=await admin.from('mentions')
    .select('id,title,original_text,source_url,published_at,author_name,raw_payload,relevance_score')
    .eq('organization_id',org.id)
    .gt('relevance_score',0)
    .order('published_at',{ascending:false,nullsFirst:false})
    .limit(Math.max(1,limit));
  if(result?.error)throw result.error;
  let checked=0,filteredOut=0;
  for(const row of result?.data||[]){
    const item:Item={title:row?.title||'',text:row?.original_text||'',url:row?.source_url||'',published_at:row?.published_at||null,author:row?.author_name||null,raw:row?.raw_payload||{}};
    const match=evaluateMatch(org,item,keywords,villages);
    checked++;
    if(!match.accepted){
      const update:any=await admin.from('mentions').update({relevance_score:0}).eq('id',row.id);
      if(!update?.error)filteredOut++;
    }
  }
  return {checked,filtered_out:filteredOut};
}

async function storedYoutubeCommentItems(
  admin:any,
  org:any,
  key:string,
  videoLimit=20,
  pagesPerVideo=1,
  deadlineMs=14000
):Promise<Item[]> {
  // Hər 10 dəqiqəlik run-da eyni 20 videonu təkrar yoxlamaq əvəzinə
  // tanınmış YouTube videoları arasında pəncərəni dövr etdiririk. Bu həm
  // yeni şərhləri sürətli tutur, həm də Edge Function vaxt limitinə düşmür.
  const { count:videoCount, error:countError } = await admin
    .from('mentions')
    .select('id',{count:'exact',head:true})
    .eq('organization_id', org.id)
    .ilike('source_platform', 'youtube')
    .eq('raw_payload->>kind', 'youtube_video');
  if (countError) throw countError;

  const total = Math.max(0, Number(videoCount || 0));
  const windowSize = Math.max(1, videoLimit);
  const windows = Math.max(1, Math.ceil(total / windowSize));
  const tenMinuteSlot = Math.floor(Date.now() / 600000);
  const windowIndex = tenMinuteSlot % windows;
  const from = windowIndex * windowSize;
  const to = Math.min(Math.max(0,total - 1), from + windowSize - 1);

  if (!total) return [];

  const { data:videoRows, error } = await admin
    .from('mentions')
    .select('id,title,source_url,published_at,raw_payload,mention_media(url,media_type)')
    .eq('organization_id', org.id)
    .ilike('source_platform', 'youtube')
    .eq('raw_payload->>kind', 'youtube_video')
    .order('published_at',{ascending:false,nullsFirst:false})
    .range(from,to);
  if (error) throw error;

  const videoItems:Item[] = (videoRows || []).map((row:any)=>{
    const raw = row.raw_payload || {};
    const videoId = String(raw.video_id || youtubeVideoId(row.source_url || '') || '');
    return {
      title:row.title || '',
      text:'',
      url:row.source_url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''),
      published_at:row.published_at || null,
      image:(row.mention_media || [])[0]?.url || null,
      raw:{ kind:'youtube_video', video_id:videoId }
    } as Item;
  }).filter((x:Item)=>Boolean((x.raw as any)?.video_id));

  return await youtubeCommentsForItems(videoItems,key,pagesPerVideo,deadlineMs);
}

function youtubeVideoId(value:string):string {
  try {
    const u = new URL(value);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace(/^\//,'').split('/')[0] || '';
    return u.searchParams.get('v') || '';
  } catch { return ''; }
}

async function youtubeCommentsForItems(
  videoItems:Item[],
  key:string,
  pagesPerVideo=1,
  deadlineMs=70000
):Promise<Item[]> {
  const comments:Item[] = [];
  const deadline = Date.now() + Math.max(10000,deadlineMs);
  for (const item of videoItems) {
    if (Date.now() > deadline) break;
    const raw:any = item.raw || {};
    const videoId = String(raw.video_id || youtubeVideoId(item.url || '') || '');
    if (!videoId) continue;
    try {
      let pageToken = '';
      for (let page=0; page<Math.max(1,pagesPerVideo) && Date.now()<=deadline; page++) {
        const endpoint = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
        endpoint.searchParams.set('part','snippet,replies');
        endpoint.searchParams.set('videoId',videoId);
        endpoint.searchParams.set('maxResults','100');
        endpoint.searchParams.set('order','time');
        endpoint.searchParams.set('textFormat','plainText');
        if (pageToken) endpoint.searchParams.set('pageToken',pageToken);
        endpoint.searchParams.set('key',key);
        const data = await fetchJsonWithRetry(endpoint.toString(), {}, 1);
        if (data?.error) break;

        for (const thread of data?.items || []) {
          const top = thread?.snippet?.topLevelComment;
          const sn = top?.snippet || {};
          const commentId = String(top?.id || thread?.id || '');
          const text = String(sn.textDisplay || sn.textOriginal || '').trim();
          if (commentId && text) comments.push({
            title:`YouTube şərhi — ${sn.authorDisplayName || 'istifadəçi'}`,
            text:`Video: ${item.title || ''}\nŞərh: ${text}`,
            url:`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(commentId)}`,
            published_at:sn.publishedAt || null,
            image:item.image || null,
            author:sn.authorDisplayName || null,
            raw:{
              kind:'youtube_comment', video_id:videoId, comment_id:commentId,
              video_title:item.title || '', like_count:sn.likeCount ?? null,
              reply_count:thread?.snippet?.totalReplyCount ?? 0,
              author_channel_url:sn.authorChannelUrl || null,
              author_channel_id:sn.authorChannelId?.value || null
            }
          });

          for (const reply of thread?.replies?.comments || []) {
            const rs = reply?.snippet || {};
            const replyId = String(reply?.id || '');
            const replyText = String(rs.textDisplay || rs.textOriginal || '').trim();
            if (!replyId || !replyText) continue;
            comments.push({
              title:`YouTube cavabı — ${rs.authorDisplayName || 'istifadəçi'}`,
              text:`Video: ${item.title || ''}\nCavab: ${replyText}`,
              url:`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(replyId)}`,
              published_at:rs.publishedAt || null,
              image:item.image || null,
              author:rs.authorDisplayName || null,
              raw:{
                kind:'youtube_comment_reply', video_id:videoId, comment_id:replyId,
                parent_id:rs.parentId || commentId || null, video_title:item.title || '',
                like_count:rs.likeCount ?? null,
                author_channel_url:rs.authorChannelUrl || null,
                author_channel_id:rs.authorChannelId?.value || null
              }
            });
          }
        }
        pageToken = String(data?.nextPageToken || '');
        if (!pageToken) break;
      }
    } catch (e) {
      console.error('youtube-live-comments',videoId,e);
    }
  }
  return dedupeItems(comments);
}

async function fetchJsonWithRetry(
  url:string,
  init:RequestInit = {},
  maxAttempts = 2,
  timeoutMs = 8000
):Promise<any> {
  let lastError:Error|null = null;
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),timeoutMs);
      const response = await fetch(url,{...init,signal:controller.signal,redirect:'follow'});
      clearTimeout(timeout);
      const data = await response.json().catch(()=>null);
      if (response.ok) return data;
      const message = data?.error?.message || `HTTP ${response.status}`;
      lastError = new Error(message);
      if (![429,500,502,503,504].includes(response.status)) throw lastError;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (attempt < maxAttempts) await new Promise(resolve=>setTimeout(resolve,650*attempt));
  }
  throw lastError || new Error('JSON sorğusu uğursuz oldu');
}

async function webSourceItems(url:string, fallback:string):Promise<{items:Item[];feeds:string[]}> {
  const sourceUrl = String(url || '').trim();
  if (!sourceUrl) return {items:[],feeds:[]};

  const html = await fetchTextWithRetry(sourceUrl,{
    headers:{
      'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/3.2)',
      'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language':'az,en;q=0.8'
    }
  },2);

  const items:Item[] = [pageItemFromHtml(sourceUrl,fallback,html)];
  const feeds = discoverFeedUrls(html,sourceUrl).slice(0,2);

  for (const feedUrl of feeds) {
    try {
      const xml = await fetchTextWithRetry(feedUrl,{
        headers:{
          'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/3.2)',
          'accept':'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*'
        }
      },2);
      items.push(...parseRss(xml).slice(0,30));
    } catch (e) {
      console.error('web-feed',feedUrl,e);
    }
  }

  // Eyni URL-i bir run daxilində yalnız bir dəfə emal et.
  const seen = new Set<string>();
  return {
    items:items.filter((item:Item)=>{
      const key = String(item.url || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    feeds
  };
}

function pageItemFromHtml(url:string, fallback:string, html:string):Item {
  const title = clean(meta(html,'og:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback);
  const description = clean(meta(html,'og:description') || meta(html,'description') || '');
  const text = clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi,' ')
      .replace(/<[^>]+>/g,' ')
  ).slice(0,14000);
  return {
    title,
    text:`${description}\n${text}`.trim(),
    url,
    image:resolveUrl(meta(html,'og:image') || '',url),
    published_at:meta(html,'article:published_time') || meta(html,'date') || null,
    raw:{kind:'web_page'}
  };
}

function discoverFeedUrls(html:string,baseUrl:string):string[] {
  const out:string[] = [];
  const rx = /<link\b[^>]*>/gi;
  for (const match of html.match(rx) || []) {
    const rel = attr(match,'rel').toLowerCase();
    const type = attr(match,'type').toLowerCase();
    const href = attr(match,'href');
    if (!href) continue;
    if (!rel.includes('alternate')) continue;
    if (!(type.includes('rss') || type.includes('atom') || type.includes('xml'))) continue;
    const resolved = resolveUrl(href,baseUrl);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function attr(tagText:string,name:string):string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return tagText.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`,'i'))?.[1] || '';
}

function resolveUrl(value:string,base:string):string|null {
  if (!value) return null;
  try { return new URL(value,base).toString(); } catch { return null; }
}


async function fetchTextWithRetry(
  url: string,
  init: RequestInit = {},
  maxAttempts = 3,
  timeoutMs = 8000
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs
      );

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: 'follow'
      });

      clearTimeout(timeout);

      if (response.ok) {
        return await response.text();
      }

      const retryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      lastError = new Error(
        `HTTP ${response.status} — ${url}`
      );

      if (!retryable) {
        throw lastError;
      }
    } catch (e) {
      lastError =
        e instanceof Error
          ? e
          : new Error(String(e));
    }

    if (attempt < maxAttempts) {
      const delay =
        600 * attempt +
        Math.floor(Math.random() * 400);

      await new Promise((resolve) =>
        setTimeout(resolve, delay)
      );
    }
  }

  throw (
    lastError ||
    new Error(`Fetch failed — ${url}`)
  );
}


async function pageItem(url:string, fallback:string):Promise<Item> {
  const html = await fetchTextWithRetry(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/3.2)'}},2);
  return pageItemFromHtml(url,fallback,html);
}

async function save(admin:any, org:any, source:any, item:Item, keywords:string[], villages:string[] = []) {
  if (!item.url) return 0;
  const match = evaluateMatch(org, item, keywords, villages);
  const normalized = match.normalized;
  const direct = match.direct;
  const matches = match.matches;
  if (!match.accepted) return 0;

  const negativeWords = ['sikayet','problem','su yoxdur','su gelmir','verilmir','quruyur','narazi','etiraz','catismazliq','susuz','kanal temizlenmir'];
  const positiveWords = ['tesekkur','berpa olundu','temir edildi','su verildi','isler basa catdi'];
  const neg = negativeWords.some(x=>normalized.includes(x));
  const pos = !neg && positiveWords.some(x=>normalized.includes(x));
  const directHit = direct.some(x=>normalized.includes(x));
  const relevance = Math.min(100, 40 + Math.min(4,matches.length)*10 + (directHit?25:0));
  const priority = Math.min(100, relevance + (neg?15:0));
  const sentiment = neg ? 'negative' : pos ? 'positive' : 'neutral';

  const canonicalSourcePlatform = canonicalPlatform(source.platform || inferPlatform(item.url || '') || 'Web');
  const isWebNews = canonicalSourcePlatform === 'Web';
  const storyTitleKey = normalizeForMatch(item.title || '');
  const storyDay = item.published_at ? String(item.published_at).slice(0,10) : '';
  // Web xəbərlərində eyni məqalə Google News, Bing, RSS və birbaşa sayt URL-i ilə
  // fərqli linklərdən gələ bilər. URL əsaslı hash bu səbəbdən dublikat yaradırdı.
  // Xəbər üçün stabil başlıq+tarix fingerprint-i, digər platformalarda əvvəlki URL hash-i işləyir.
  const hash = await sha256(isWebNews && storyTitleKey
    ? `${org.id}|web-story|${storyTitleKey}|${storyDay}`
    : `${org.id}|${item.url}|${item.title||''}`);

  // Eyni material hər run-da yenidən aşkarlana bilər. Əvvəlcə yeni content_hash ilə yoxla.
  let { data:existing, error:existingError } = await admin.from('mentions')
    .select('id')
    .eq('organization_id',org.id)
    .eq('content_hash',hash)
    .maybeSingle();
  if (existingError) throw existingError;

  // Köhnə Web qeydləri URL+başlıq hash-i ilə saxlanıb. Yeni fingerprint sisteminə keçiddə
  // həmin köhnə materialı bir dəfə də insert etməmək üçün başlıq+tarix üzrə fallback axtarış edilir.
  if (!existing?.id && isWebNews && item.title) {
    let legacyQuery:any = admin.from('mentions')
      .select('id')
      .eq('organization_id',org.id)
      .in('source_platform',['Web','Google News'])
      .eq('title',item.title)
      .order('detected_at',{ascending:false})
      .limit(1);
    if (storyDay) {
      legacyQuery = legacyQuery
        .gte('published_at',`${storyDay}T00:00:00.000Z`)
        .lt('published_at',new Date(new Date(`${storyDay}T00:00:00.000Z`).getTime()+86400000).toISOString());
    }
    const legacyResult:any = await legacyQuery.maybeSingle();
    if (!legacyResult?.error && legacyResult?.data?.id) existing = legacyResult.data;
  }
  if (existing?.id) {
    // Mövcud material/rəy yenidən görünəndə yalnız statusu deyil, dəyişə bilən
    // platforma metadatasını da təzələyirik. Xüsusilə YouTube şərhlərində
    // like_count sonradan dəyişə bildiyi üçün köhnə 0 dəyəri saxlanmamalıdır.
    const refresh:any = {
      source_status:'active',
      last_seen_at:new Date().toISOString(),
      last_verified_at:new Date().toISOString(),
      unavailable_since:null,
      unavailable_reason:null,
      consecutive_misses:0,
      raw_payload:item.raw || item
    };
    if (item.author) refresh.author_name=item.author;
    if (item.published_at) refresh.published_at=item.published_at;
    if (item.text) refresh.original_text=item.text;
    if (item.title) refresh.title=item.title;
    await admin.from('mentions').update(refresh).eq('id',existing.id);
    return 0;
  }

  let summary = clean(item.text || '').slice(0,520);
  let topic = neg ? 'Potensial problem / şikayət' : 'Media qeydi';
  const ai = await optionalAiAnalysis(org,item,relevance,sentiment);
  if (ai?.summary) summary = String(ai.summary).slice(0,700);
  if (ai?.topic) topic = String(ai.topic).slice(0,160);

  const row:any = {
    organization_id:org.id,
    district_id:org.district_id || null,
    source_platform:canonicalSourcePlatform,
    source_url:item.url,
    author_name:item.author || null,
    title:item.title || 'Monitorinq qeydi',
    original_text:item.text || '',
    summary,
    topic,
    mention_type:neg ? 'complaint' : 'media',
    sentiment,
    priority_score:priority,
    relevance_score:ai?.relevance_score ? clamp(ai.relevance_score) : relevance,
    published_at:item.published_at || null,
    content_hash:hash,
    raw_payload:item.raw || item,
    source_status:'active',
    last_seen_at:new Date().toISOString(),
    last_verified_at:new Date().toISOString(),
    unavailable_since:null,
    unavailable_reason:null,
    consecutive_misses:0
  };

  const { data, error } = await admin.from('mentions')
    .upsert(row,{onConflict:'organization_id,content_hash',ignoreDuplicates:true})
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) {
    await admin.from('mentions').update({
      source_status:'active',
      last_seen_at:new Date().toISOString(),
      last_verified_at:new Date().toISOString(),
      unavailable_since:null,
      unavailable_reason:null,
      consecutive_misses:0
    }).eq('organization_id',org.id).eq('content_hash',hash);
    return 0;
  }

  if (item.image) {
    await admin.from('mention_media').insert({mention_id:data.id,media_type:'preview_external',url:item.image,captured_at:new Date().toISOString()});
  }
  const isCommentItem = String((item.raw as any)?.kind || '').includes('comment');
  if (priority >= 81 || isCommentItem) {
    await admin.from('notifications').insert({
      organization_id:org.id,
      mention_id:data.id,
      title:isCommentItem ? (priority>=81?'Yüksək prioritetli yeni şərh':'Yeni YouTube şərhi') : 'Yüksək prioritetli yeni qeyd',
      body:item.title || 'Yeni material',
      kind:priority>=81?'critical':'comment'
    });
  }
  return 1;
}

type RunOptions = {
  debug:boolean;
  force_youtube:boolean;
  verify_existing:boolean;
  youtube_backfill:boolean;
  quick_youtube_comments:boolean;
  full_comment_sweep:boolean;
  refilter_existing:boolean;
  focus_video_ids:string[];
  mode:string;
  edge_news_probe:boolean;
  organization_id:string|null;
  source_platform:string;
  source_label:string;
  news_items:Item[];
  source_url:string;
  image_base64:string;
  mime_type:string;
  media_type:string;
  news_title:string;
  news_text:string;
  news_published_at:string|null;
  news_author:string;
  image_url:string;
  canonical_url:string;
};

const DEFAULT_RUN_OPTIONS:RunOptions = {
  debug:false,
  force_youtube:false,
  verify_existing:true,
  youtube_backfill:false,
  quick_youtube_comments:false,
  full_comment_sweep:false,
  refilter_existing:false,
  focus_video_ids:[],
  mode:'scheduled',
  edge_news_probe:false,
  organization_id:null,
  source_platform:'Web',
  source_label:'',
  news_items:[],
  source_url:'',
  image_base64:'',
  mime_type:'image/jpeg',
  media_type:'screenshot',
  news_title:'',
  news_text:'',
  news_published_at:null,
  news_author:'',
  image_url:'',
  canonical_url:''
};

async function readRunOptions(req:Request):Promise<RunOptions> {
  if (req.method !== 'POST') return {...DEFAULT_RUN_OPTIONS};
  try {
    const text = await req.clone().text();
    if (!text.trim()) return {...DEFAULT_RUN_OPTIONS};
    const body = JSON.parse(text);
    const incoming = Array.isArray(body?.items) ? body.items : [];
    const newsItems:Item[] = incoming.slice(0,250).map((x:any)=>({
      title:String(x?.title || '').slice(0,500),
      text:String(x?.text || x?.description || '').slice(0,40000),
      url:String(x?.url || '').slice(0,2000),
      published_at:x?.published_at ? String(x.published_at) : null,
      image:x?.image ? String(x.image) : null,
      author:x?.author ? String(x.author) : null,
      raw:x?.raw && typeof x.raw === 'object' ? x.raw : {kind:'news_gateway'}
    })).filter((x:Item)=>Boolean(x.url));
    return {
      debug:body?.debug === true,
      force_youtube:body?.force_youtube === true,
      verify_existing:body?.verify_existing !== false,
      youtube_backfill:body?.youtube_backfill === true || body?.force_youtube === true,
      quick_youtube_comments:body?.quick_youtube_comments === true,
      full_comment_sweep:body?.full_comment_sweep === true,
      refilter_existing:body?.refilter_existing === true,
      focus_video_ids:[...new Set((Array.isArray(body?.focus_video_ids)?body.focus_video_ids:[]).map((x:any)=>String(x||'').trim()).filter((x:string)=>/^[A-Za-z0-9_-]{11}$/.test(x)))].slice(0,8),
      mode:String(body?.mode || 'scheduled'),
      edge_news_probe:body?.edge_news_probe === true,
      organization_id:body?.organization_id ? String(body.organization_id) : null,
      source_platform:String(body?.source_platform || 'Web'),
      source_label:String(body?.source_label || ''),
      news_items:newsItems,
      source_url:String(body?.source_url || '').slice(0,2000),
      image_base64:String(body?.image_base64 || ''),
      mime_type:String(body?.mime_type || 'image/jpeg').slice(0,80),
      media_type:String(body?.media_type || 'screenshot').slice(0,40),
      news_title:String(body?.title || '').slice(0,1000),
      news_text:String(body?.text || '').slice(0,40000),
      news_published_at:body?.published_at ? String(body.published_at) : null,
      news_author:String(body?.author || '').slice(0,500),
      image_url:String(body?.image_url || '').slice(0,2000),
      canonical_url:String(body?.canonical_url || '').slice(0,2000)
    };
  } catch {
    return {...DEFAULT_RUN_OPTIONS};
  }
}

function debugSamples(items:Item[], org:any, keywords:string[], villages:string[] = [], limit=6) {
  return items.slice(0,limit).map(item=>{
    const match = evaluateMatch(org,item,keywords,villages);
    return {
      platform:inferPlatform(item.url || ''),
      title:String(item.title || '').slice(0,180),
      url:item.url || '',
      accepted:match.accepted,
      matched_terms:match.matches,
      reason:match.reason
    };
  });
}

function evaluateMatch(org:any, item:Item, keywords:string[], villages:string[] = []) {
  const normalized = normalizeForMatch(`${item.title || ''} ${item.text || ''}`);
  const direct = [String(org.name||''),String(org.short_name||'')]
    .map(normalizeForMatch).filter(Boolean);
  const normalizedKeywords = Array.isArray(org.__normalized_keywords) ? org.__normalized_keywords : keywords.map(normalizeForMatch).filter(Boolean);
  const excludeTerms = [
    ...(Array.isArray(org.__normalized_excludes)?org.__normalized_excludes:(Array.isArray(org.__exclude_terms)?org.__exclude_terms:[])),
    'maşın bazarı','avtomobil bazarı','ikinci əl maşın','toy','gəlin','bəy','nişan mərasimi',
    'futbol','idman yarışı','konsert','şou','serial','film treyleri','restoran','otel',
    'it','pişik','heyvan bazarı','daşınmaz əmlak','ev satılır','kirayə ev','iş elanları',
    'yanğın','yol qəzası','avtomobil qəzası','kriminal','oğurluq','hava proqnozu'
  ].map(normalizeForMatch).filter(Boolean);

  const district = normalizeForMatch(String(org.districts?.name || ''));
  const villageTerms = villages.map(normalizeForMatch).filter(term=>term.length >= 4);

  const contains=(text:string,term:string)=>Boolean(term && (` ${text} `).includes(` ${term} `));
  const directMatches = direct.filter(term=>term.length >= 4 && contains(normalized,term));
  const districtHit = Boolean(district && contains(normalized,district));
  const villageHits = villageTerms.filter(term=>contains(normalized,term)).slice(0,5);
  const locationHit = districtHit || villageHits.length > 0;

  // Güclü mövzu terminləri. "kanal" kimi ümumi sözlər təkbaşına kifayət etmir,
  // çünki YouTube təsvirlərində "kanalımıza abunə olun" kimi mətnlər çoxdur.
  const strongTopics = [
    'suvarma','suvarma suyu','suvarma sistemi','suvarma kanali','suvarma arxi',
    'meliorasiya','su teserrufati','subartezian','subartezan','artezian','artezan',
    'kollektor drenaj','drenaj','hidrotexniki','nasos stansiyasi','su quyusu',
    'su catismamazligi','susuzluq','susuz qalib','su verilmir','su gelmir','su yoxdur',
    'icmeli su','su tapmir','su teminati','su verilisi','su itkisi','ekin sahesi',
    'fermer su','lilden temizlen','soranlasma'
  ].map(normalizeForMatch);

  const strongHits = strongTopics.filter(term=>contains(normalized,term)).slice(0,8);

  // Admin panelindəki rayonla birlikdə yazılmış konkret fraza yalnız tam fraza
  // mətnin özündə keçirsə əlavə uyğunluq yaradır.
  const scopedKeywordHits = normalizedKeywords.filter(term=>{
    if(!term || !district || !term.includes(district)) return false;
    return contains(normalized,term);
  }).slice(0,8);
  const bankKeywordHits = normalizedKeywords.filter(term=>{
    if(!term || term.length < 6) return false;
    return contains(normalized,term);
  }).slice(0,12);

  const raw:any = item.raw || {};
  // Təşkilatın rəsmi portalının ana səhifəsi / naviqasiya nəticəsi xəbər deyil.
  // Axtarış mühərrikləri bunu yüksək uyğunluqla qaytarsa da monitorinq və bildirişlərə salmırıq.
  let ownPortalNoise=false;
  try {
    const host=new URL(String(item.url||'')).hostname.replace(/^www\./i,'').toLowerCase();
    const path=new URL(String(item.url||'')).pathname.replace(/\/+$/,'') || '/';
    const districtAscii=normalizeForMatch(String(org.districts?.name||'')).replace(/\s+/g,'');
    const shortAscii=normalizeForMatch(String(org.short_name||'')).replace(/\s+/g,'');
    const ownHost=(districtAscii && host.includes(districtAscii) && /smsii/i.test(host)) || (shortAscii && host.replace(/[^a-z0-9]/g,'').includes(shortAscii.replace(/[^a-z0-9]/g,'')));
    const navText=normalizeForMatch(`${item.title||''} ${item.text||''}`);
    ownPortalNoise=Boolean(ownHost && (path==='/' || path==='/index.html' || /resmi portal|butun xeberler|haqqimizda|struktur|rehberlik|elektron muraciet/.test(navText)));
  } catch {}
  const kind=String(raw.kind||'');
  const isComment=kind.includes('comment');
  const trustedParentComment = isComment && raw.parent_is_relevant === true;

  // Aidiyyəti video təşkilat filtrlərindən artıq keçibsə, onun bütün rəyləri saxlanılır.
  // Rəyin özündə "Bərdə" və ya "suvarma" sözünün təkrarlanmaması vacib məlumatı itirməsin.
  const positiveTopic = strongHits.length>0 || scopedKeywordHits.length>0 || bankKeywordHits.length>0;

  const exclusionHits = excludeTerms.filter(term=>contains(normalized,term)).slice(0,8);
  const negativeOnly = exclusionHits.length>0 && !positiveTopic && directMatches.length===0;

  const foreignDistricts = [
    'agcabedi','agdam','agdas','agsu','astara','balaken','beyleqan','bilesuvar','celilabad','daskesen',
    'fuzuli','gedebey','goranboy','goycay','goygol','haciqabul','imisli','ismayilli','kurdemir','lerik',
    'masalli','neftcala','oguz','qebele','qax','qazax','qusar','saatli','sabirabad','salyan','samaxi',
    'samkir','siyazan','terter','ucar','yardimli','yevlax','zerdab'
  ];
  const foreignNamesHit = foreignDistricts.filter(name=>contains(normalized,name));
  const ambiguousVillageHit = foreignNamesHit.some(name=>villageTerms.includes(name));
  const foreignHit = foreignNamesHit.length > 0 && !districtHit && directMatches.length === 0 && (!villageHits.length || ambiguousVillageHit);

  const districtWide = org.show_district_wide !== false;
  const accepted = !ownPortalNoise && (trustedParentComment || (!negativeOnly && !foreignHit && (
    directMatches.length>0 ||
    (districtWide && locationHit && positiveTopic) ||
    (isComment && positiveTopic && (districtHit || villageHits.length>0))
  )));

  const matches=[...new Set([
    ...directMatches,
    ...strongHits.map(t=>(districtHit?`${district}+${t}`:t)),
    ...scopedKeywordHits,
    ...bankKeywordHits,
    ...(!districtHit && villageHits.length && strongHits.length ? villageHits.flatMap(v=>strongHits.slice(0,2).map(t=>`${v}+${t}`)) : [])
  ])];

  return {
    accepted,
    normalized,
    direct,
    matches,
    excluded_terms:exclusionHits,
    reason:accepted
      ? (trustedParentComment?'aidiyyəti-videonun-rəyi'
        :directMatches.length?'təşkilat-adı-uyğunluğu'
        :(districtHit&&positiveTopic)?'rayon-mövzu-uyğunluğu'
        :(villageHits.length&&positiveTopic)?'kənd-mövzu-uyğunluğu'
        :'mövzu-uyğunluğu')
      : (negativeOnly?'axtarılmamalı-mövzu'
        :foreignHit?'başqa-rayon-məlumatıdır'
        :locationHit?'ərazi-var-mövzu-yoxdur'
        :'ərazi-və-mövzu-uyğunluğu-yoxdur')
  };
}

function normalizeForMatch(value:string):string {
  return String(value || '')
    .toLocaleLowerCase('az-AZ')
    .normalize('NFKD')
    .replace(/[əƏ]/g,'e')
    .replace(/[ıİ]/g,'i')
    .replace(/[şŞ]/g,'s')
    .replace(/[çÇ]/g,'c')
    .replace(/[öÖ]/g,'o')
    .replace(/[üÜ]/g,'u')
    .replace(/[ğĞ]/g,'g')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

async function verifyExistingMentions(admin:any, org:any, youtubeKey:string) {
  const { data:rows, error } = await admin.from('mentions')
    .select('id,source_platform,source_url,raw_payload,source_status,last_verified_at,consecutive_misses')
    .eq('organization_id',org.id)
    .in('source_status',['active','unavailable'])
    .not('source_url','is',null)
    .order('last_verified_at',{ascending:true,nullsFirst:true})
    .limit(80);
  if (error) throw error;

  const candidates = rows || [];
  let checked = 0, active = 0, removed = 0, unavailable = 0, unchanged = 0;
  const youtubeComments = candidates.filter((x:any)=>String(x.source_platform||'').toLowerCase()==='youtube' && String(x?.raw_payload?.kind||'').includes('comment')).slice(0,40);
  const youtubeVideos = candidates.filter((x:any)=>String(x.source_platform||'').toLowerCase()==='youtube' && !String(x?.raw_payload?.kind||'').includes('comment')).slice(0,20);
  const otherRows = candidates.filter((x:any)=>String(x.source_platform||'').toLowerCase()!=='youtube').slice(0,20);
  const now = new Date().toISOString();

  if (youtubeComments.length && youtubeKey) {
    const ids = [...new Set(youtubeComments.map((row:any)=>String(row?.raw_payload?.comment_id||'')).filter(Boolean))].slice(0,50);
    const publicIds = new Set<string>();
    if (ids.length) {
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/comments');
      endpoint.searchParams.set('part','id');
      endpoint.searchParams.set('id',ids.join(','));
      endpoint.searchParams.set('key',youtubeKey);
      const data = await fetchJsonWithRetry(endpoint.toString(),{},1);
      for (const item of data?.items || []) publicIds.add(String(item.id));
    }
    for (const row of youtubeComments) {
      const commentId=String(row?.raw_payload?.comment_id||'');
      if(!commentId){unchanged++;continue;}
      checked++;
      if(publicIds.has(commentId)){
        active++;
        await admin.from('mentions').update({source_status:'active',last_verified_at:now,last_seen_at:now,unavailable_since:null,unavailable_reason:null,consecutive_misses:0}).eq('id',row.id);
      }else{
        removed++;
        await markUnavailable(admin,row,'youtube-comment-not-found',now,true);
        await notifySourceRemoval(admin,org,row,true);
      }
    }
  }

  if (youtubeVideos.length && youtubeKey) {
    const ids = youtubeVideos.map((row:any)=>extractYoutubeVideoId(row)).filter(Boolean).slice(0,50);
    const uniqueIds = [...new Set(ids)];
    const publicIds = new Set<string>();
    if (uniqueIds.length) {
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
      endpoint.searchParams.set('part','id,status');
      endpoint.searchParams.set('id',uniqueIds.join(','));
      endpoint.searchParams.set('key',youtubeKey);
      const data = await fetchJsonWithRetry(endpoint.toString(),{},1);
      for (const item of data?.items || []) publicIds.add(String(item.id));
    }
    for (const row of youtubeVideos) {
      const videoId = extractYoutubeVideoId(row);
      if (!videoId) { unchanged++; continue; }
      checked++;
      if (publicIds.has(videoId)) {
        active++;
        await admin.from('mentions').update({source_status:'active',last_verified_at:now,last_seen_at:now,unavailable_since:null,unavailable_reason:null,consecutive_misses:0}).eq('id',row.id);
      } else {
        const nextMisses=Number(row.consecutive_misses||0)+1;
        if(nextMisses>=2){removed++;await notifySourceRemoval(admin,org,row,false)}else unavailable++;
        await markUnavailable(admin,row,'youtube-video-not-public',now,nextMisses>=2);
      }
    }
  }

  for (const row of otherRows) {
    const sourceUrl = String(row.source_url || '').trim();
    if (!sourceUrl) continue;
    checked++;
    const state = await probeSourceUrl(sourceUrl);
    if (state.kind === 'active') {
      active++;
      await admin.from('mentions').update({source_status:'active',last_verified_at:now,last_seen_at:now,unavailable_since:null,unavailable_reason:null,consecutive_misses:0}).eq('id',row.id);
    } else if (state.kind === 'removed') {
      const nextMisses = Number(row.consecutive_misses || 0) + 1;
      if (nextMisses >= 2) {removed++;await notifySourceRemoval(admin,org,row,false)} else unavailable++;
      await markUnavailable(admin,row,`http-${state.status}`,now,nextMisses >= 2);
    } else if (state.kind === 'restricted') {
      unavailable++;
      await markUnavailable(admin,row,`http-${state.status}`,now,false);
    } else {
      unchanged++;
      await admin.from('mentions').update({last_verified_at:now}).eq('id',row.id);
    }
  }

  return {checked,active,removed,unavailable,unchanged,comments_checked:youtubeComments.length,videos_checked:youtubeVideos.length};
}

async function notifySourceRemoval(admin:any,org:any,row:any,isComment:boolean){
  if(String(row?.source_status||'active')==='removed') return;
  const title=isComment?'YouTube şərhi silinib':'Monitorinq materialı silinib';
  const body=isComment?'Aşkarlanmış şərh artıq orijinal platformada tapılmır.':'Aşkarlanmış material artıq orijinal mənbədə tapılmır.';
  const existing=await admin.from('notifications').select('id',{count:'exact',head:true}).eq('mention_id',row.id).eq('kind','removed');
  if(Number(existing?.count||0)>0)return;
  await admin.from('notifications').insert({organization_id:org.id,mention_id:row.id,title,body,kind:'removed'});
}

function extractYoutubeVideoId(row:any):string {
  const raw = row?.raw_payload || {};
  const fromRaw = String(raw?.video_id || '');
  if (fromRaw) return fromRaw;
  try {
    const u = new URL(String(row?.source_url || ''));
    if (u.hostname.includes('youtu.be')) return u.pathname.replace(/^\//,'').split('/')[0] || '';
    return u.searchParams.get('v') || '';
  } catch { return ''; }
}

async function markUnavailable(admin:any,row:any,reason:string,now:string,confirmedRemoved:boolean) {
  const misses = Number(row.consecutive_misses || 0) + 1;
  await admin.from('mentions').update({
    source_status:confirmedRemoved ? 'removed' : 'unavailable',
    last_verified_at:now,
    unavailable_since:row.source_status === 'active' ? now : undefined,
    unavailable_reason:reason,
    consecutive_misses:misses
  }).eq('id',row.id);
}

async function probeSourceUrl(url:string):Promise<{kind:'active'|'removed'|'restricted'|'unknown';status:number}> {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),8000);
  try {
    const response = await fetch(url,{
      method:'GET',
      redirect:'follow',
      signal:controller.signal,
      headers:{
        'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/3.3)',
        'accept':'text/html,application/xhtml+xml,*/*;q=0.8',
        'range':'bytes=0-2048'
      }
    });
    clearTimeout(timeout);
    if (response.status === 404 || response.status === 410) return {kind:'removed',status:response.status};
    if (response.status === 401 || response.status === 403) return {kind:'restricted',status:response.status};
    if (response.ok || (response.status >= 300 && response.status < 400)) return {kind:'active',status:response.status};
    return {kind:'unknown',status:response.status};
  } catch {
    clearTimeout(timeout);
    return {kind:'unknown',status:0};
  }
}

async function optionalAiAnalysis(org:any,item:Item,relevance:number,sentiment:string) {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey || relevance < 60) return null;
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
  const prompt = `Sən Azərbaycan dilində media monitorinq analitikisən. Təşkilat: ${org.name} (${org.short_name}). Aşağıdakı materialı yalnız bu təşkilata aidiyyət baxımından qısa analiz et. JSON qaytar: {"summary":"...","topic":"...","relevance_score":0-100}. Fakt uydurma. Başlıq: ${item.title||''}\nMətn: ${(item.text||'').slice(0,4000)}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),6500);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,{
      method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}})
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) { console.error('ai-analysis',e); return null; }
}

function parseRss(xml:string):Item[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(x=>x[0]);
  return blocks.map(b=>({
    title:decode(tag(b,'title')),
    text:decode(tag(b,'description') || tag(b,'summary') || tag(b,'content')),
    url:decode(tag(b,'link') || b.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || ''),
    published_at:tag(b,'pubDate') || tag(b,'published') || tag(b,'updated') || null,
    author:decode(tag(b,'source') || tag(b,'author') || ''),
    image:b.match(/<media:content[^>]+url=["']([^"']+)/i)?.[1] || b.match(/<media:thumbnail[^>]+url=["']([^"']+)/i)?.[1] || null
  }));
}
function meta(html:string,name:string){const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,'i'))?.[1] || ''}
function tag(s:string,n:string){return s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`,'i'))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').trim()||''}
function clean(s:string){return decode(String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())}
function decode(s:string){return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')}
function clamp(v:any){const n=Number(v||0);return Math.max(0,Math.min(100,Math.round(n)))}
async function sha256(input:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function decodeBase64(value:string):Uint8Array {
  try {
    const raw=atob(String(value||'').replace(/^data:[^;]+;base64,/i,''));
    const out=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
    return out;
  } catch { return new Uint8Array(); }
}

async function ensurePublicBucket(admin:any,bucket:string) {
  try {
    const existing:any = await admin.storage.getBucket(bucket);
    if (!existing?.error && existing?.data) {
      if (existing.data.public !== true) await admin.storage.updateBucket(bucket,{public:true});
      return;
    }
  } catch {}
  const created:any = await admin.storage.createBucket(bucket,{public:true,fileSizeLimit:3145728,allowedMimeTypes:['image/jpeg','image/png','image/webp']});
  if (created?.error && !String(created.error?.message||'').toLowerCase().includes('already exists')) throw created.error;
}

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})}
