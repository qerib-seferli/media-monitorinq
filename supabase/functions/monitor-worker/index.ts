import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

type Item = { title?:string; text?:string; url?:string; published_at?:string|null; image?:string|null; author?:string|null; raw?:unknown };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, service);
    const options = await readRunOptions(req);
    const expected = Deno.env.get('MONITOR_SECRET');
    const secretOk = Boolean(expected && req.headers.get('x-monitor-secret') === expected);
    if (!secretOk) {
      const authHeader = req.headers.get('Authorization') || '';
      const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
      const caller = createClient(url, anon, { global:{ headers:{ Authorization:authHeader } } });
      const { data:{ user } } = await caller.auth.getUser();
      if (!user) throw new Error('İcazəsiz monitor sorğusu');
      const { data:profile } = await admin.from('profiles').select('system_role,is_active').eq('auth_user_id',user.id).maybeSingle();
      if (!profile?.is_active || profile.system_role !== 'super_admin') throw new Error('Yalnız Super Admin monitorinqi manual işə sala bilər');
    }
    const { data:orgs, error } = await admin.from('organizations')
      .select('id,name,short_name,district_id,districts(name),keywords(*),sources(*)')
      .in('service_status',['active','grace']);
    if (error) throw error;

    let checked = 0, inserted = 0, failures = 0;
    const details:any[] = [];

    for (const org of orgs || []) {
      const keywords = (org.keywords || []).filter((k:any)=>k.is_active !== false).map((k:any)=>String(k.value || '').trim()).filter(Boolean);
      const lowerKeywords = keywords.map((k:string)=>k.toLocaleLowerCase('az-AZ'));
      const sources = (org.sources || []).filter((s:any)=>s.is_active !== false);
      let villageNames:string[] = [];
      if (org.district_id) {
        const { data:villageRows, error:villageError } = await admin
          .from('villages')
          .select('name')
          .eq('district_id', org.district_id)
          .order('name');
        if (villageError) console.error('villages', org.short_name, villageError);
        else villageNames = (villageRows || []).map((x:any)=>String(x.name || '').trim()).filter(Boolean);
      }

      // YouTube arxiv yığımı zamanı Edge Function vaxt limitinə düşməmək üçün
      // web/news lane-ləri həmin xüsusi run-da saxlanılır. Normal run-da hamısı işləyir.
      if (!options.youtube_backfill) {
      // Zero-cost discovery lane: Google News RSS. No API key is required.
      try {
        checked++;
        const rssItems = await googleNewsItems(org, keywords, villageNames);
        let newsCount = 0;
        for (const item of rssItems.slice(0,30)) newsCount += await save(admin,org,{platform:'Google News',url:'https://news.google.com/'},item,lowerKeywords,villageNames);
        inserted += newsCount;
        details.push({ organization:org.short_name, source:'Google News RSS', found:rssItems.length, inserted:newsCount, ...(options.debug ? { sample_results:debugSamples(rssItems, org, lowerKeywords, villageNames, 5) } : {}) });
      } catch (e) {
        failures++;
        console.error('google-news',org.short_name,e);
      }


      // API-siz real web/xəbər discovery: GDELT DOC 2.0.
      // Bing RSS-in qeyri-dəqiq nəticələri production axınından çıxarılıb.
      try {
        checked++;
        const webItems = await gdeltNewsItems(org, keywords, villageNames);
        let webCount = 0;
        for (const item of webItems.slice(0,60)) {
          webCount += await save(admin,org,{platform:'Web',url:'https://api.gdeltproject.org/'},item,lowerKeywords,villageNames);
        }
        inserted += webCount;
        details.push({
          organization:org.short_name,
          source:'GDELT Web / Xəbər',
          found:webItems.length,
          inserted:webCount,
          ...(options.debug ? { sample_results:debugSamples(webItems, org, lowerKeywords, villageNames, 10) } : {})
        });
      } catch (e) {
        failures++;
        console.error('gdelt-web-news',org.short_name,e);
      }
      } else if (options.debug) {
        details.push({ organization:org.short_name, source:'Web / Xəbər lane-ləri', skipped:'youtube-backfill-focus' });
      }

      for (const source of sources) {
        checked++;
        try {
          const platform = String(source.platform || 'Web').toLowerCase();

          if (platform === 'youtube') {
            const last = source.last_checked_at ? new Date(source.last_checked_at).getTime() : 0;
            // YouTube Search API quota sərf edir. Planlı iş 15 dəqiqədən bir işləsə də,
            // YouTube lane maksimum 6 saatdan bir çağırılır.
            if (!options.force_youtube && last && Date.now() - last < 6 * 3600 * 1000) {
              details.push({ organization:org.short_name, source:'YouTube', skipped:'quota-window' });
              continue;
            }

            const key = Deno.env.get('YOUTUBE_API_KEY');
            if (!key) {
              details.push({ organization:org.short_name, source:'YouTube', skipped:'missing-youtube-api-key' });
              continue;
            }

            // Əgər bu təşkilat üçün hələ YouTube qeydi yoxdursa, ilk real işə düşmədə
            // ilk işə düşmədə son 12 ayı geri oxuyuruq. Sonrakı işlər isə yalnız yeni intervalı yoxlayır.
            const { count: existingYoutubeCount } = await admin
              .from('mentions')
              .select('id', { count:'exact', head:true })
              .eq('organization_id', org.id)
              .eq('source_platform', 'YouTube');

            const discovery = await youtubeItems(
              org,
              keywords,
              villageNames,
              key,
              options.youtube_backfill ? null : (existingYoutubeCount ? source.last_checked_at : null),
              1
            );

            let count = 0;
            for (const item of discovery.items) {
              count += await save(admin,org,source,item,lowerKeywords,villageNames);
            }

            // Aşkarlanmış videoların son açıq şərhlərini də yoxlayırıq.
            // save() yalnız təşkilat/açar söz uyğunluğu olan şərhləri bazaya buraxır.
            for (const item of discovery.comments) {
              count += await save(admin,org,source,item,lowerKeywords,villageNames);
            }

            inserted += count;
            details.push({
              organization:org.short_name,
              source:'YouTube Data API v3',
              queries:discovery.queries,
              videos_found:discovery.items.length,
              comments_checked:discovery.comments.length,
              inserted:count,
              ...(options.debug ? {
                sample_results:debugSamples([...discovery.items, ...discovery.comments], org, lowerKeywords, villageNames, 12)
              } : {})
            });
} else if (
  platform === 'rss' ||
  source.url?.match(/(\.xml|\.rss)(\?|$)/i) ||
  String(source.url || '').includes('/rss')
) {
  const sourceUrl = String(source.url || '').trim();

  // Google News RSS artıq yuxarıdakı discovery lane-də yoxlanılır.
  // Eyni mənbəni ikinci dəfə çağırmır.
  if (sourceUrl.includes('news.google.com/rss/')) {
    details.push({
      organization: org.short_name,
      source: sourceUrl,
      skipped: 'duplicate-google-news-source'
    });

    await admin
      .from('sources')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', source.id);

    continue;
  }

  const xml = await fetchTextWithRetry(sourceUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 MediaMonitorinq/3.0',
      'accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
  });

  const items = parseRss(xml);

  let count = 0;
  for (const item of items.slice(0, 30)) {
    count += await save(admin, org, source, item, lowerKeywords, villageNames);
  }

  inserted += count;

  details.push({
    organization: org.short_name,
    source: sourceUrl,
    found: items.length,
    inserted: count
  });
} else {
            // Açıq web mənbəsi: səhifənin özünü və varsa elan etdiyi RSS/Atom feed-ləri
            // API açarı olmadan yoxlanılır.
            const web = await webSourceItems(source.url, source.name || source.url);
            let count = 0;
            for (const item of web.items) {
              count += await save(admin,org,source,item,lowerKeywords,villageNames);
            }
            inserted += count;
            details.push({
              organization:org.short_name,
              source:source.url,
              web_items:web.items.length,
              discovered_feeds:web.feeds,
              inserted:count
            });
          }

          await admin.from('sources').update({last_checked_at:new Date().toISOString()}).eq('id',source.id);
        } catch (e) {
          failures++;
          console.error('source',source.url,e);
        }
      }

      if (options.verify_existing !== false) {
        try {
          const verification = await verifyExistingMentions(admin, org, Deno.env.get('YOUTUBE_API_KEY') || '');
          if (verification.checked || options.debug) {
            details.push({ organization:org.short_name, source:'Mənbə mövcudluğu yoxlaması', ...verification });
          }
        } catch (e) {
          failures++;
          console.error('source-verification', org.short_name, e);
        }
      }
    }

    return json({ok:true,checked_sources:checked,new_mentions:inserted,failures,details});
  } catch (e) {
    return json({ok:false,error:e instanceof Error ? e.message : String(e ?? 'Naməlum xəta')},400);
  }
});

async function googleNewsItems(org:any, keywords:string[], villages:string[]=[]):Promise<Item[]> {
  const queries = buildDiscoveryQueries(org, keywords, villages, 5);
  const all:Item[] = [];

  for (const query of queries) {
    const googleUrl =
      `https://news.google.com/rss/search` +
      `?q=${encodeURIComponent(query)}` +
      `&hl=az&gl=AZ&ceid=AZ:az`;

    try {
      const xml = await fetchTextWithRetry(googleUrl, {
        headers: {
          'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/4.0)',
          'accept':'application/rss+xml, application/xml, text/xml, */*',
          'accept-language':'az,en;q=0.8'
        }
      }, 2);
      all.push(...parseRss(xml).map(item=>({
        ...item,
        raw:{...((item.raw as any) || {}), kind:'google_news', discovery_query:query}
      })));
    } catch (e) {
      console.error('google-news-query', query, e);
    }
  }

  return dedupeItems(all);
}

async function gdeltNewsItems(org:any, keywords:string[], villages:string[]=[]):Promise<Item[]> {
  const queries = buildDiscoveryQueries(org, keywords, villages, 5);
  const all:Item[] = [];

  for (const query of queries) {
    try {
      const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('mode', 'ArtList');
      endpoint.searchParams.set('maxrecords', '25');
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('sort', 'DateDesc');
      endpoint.searchParams.set('timespan', '3months');

      const data = await fetchJsonWithRetry(endpoint.toString(), {
        headers:{
          'user-agent':'MediaMonitorinq/4.0 (+public-news-monitoring)',
          'accept':'application/json'
        }
      }, 2);

      for (const article of data?.articles || []) {
        const url = String(article?.url || '').trim();
        const title = String(article?.title || '').trim();
        if (!url || !title) continue;
        all.push({
          title,
          text:`${article?.domain || ''} ${article?.language || ''} ${article?.sourcecountry || ''}`.trim(),
          url,
          published_at:gdeltDate(article?.seendate),
          image:String(article?.socialimage || '').trim() || null,
          author:String(article?.domain || '').trim() || null,
          raw:{kind:'gdelt_article', discovery_query:query, ...article}
        });
      }
    } catch (e) {
      console.error('gdelt-query', query, e);
    }
  }

  return dedupeItems(all);
}

function buildDiscoveryQueries(org:any, keywords:string[], villages:string[] = [], max=8):string[] {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();
  const candidates:string[] = [];

  // Search API-də bir uzun AND cümləsi əvəzinə ayrıca, real mövzu sorğuları.
  if (shortName) candidates.push(shortName);
  if (fullName && normalizeForMatch(fullName) !== normalizeForMatch(shortName)) candidates.push(fullName);

  const preferredTopics = [
    'suvarma', 'suvarma kanalı', 'kanal', 'arx',
    'subartezian', 'kollektor drenaj', 'meliorasiya', 'fermer su'
  ];
  for (const topic of preferredTopics) {
    if (district) candidates.push(`${district} ${topic}`);
  }

  // Admin paneldə daxil edilmiş Bərdə-yə bağlı güclü frazalar da discovery-yə qoşulur.
  for (const value of keywords) {
    const k = String(value || '').trim();
    if (!k) continue;
    const nk = normalizeForMatch(k);
    if (district && nk.includes(normalizeForMatch(district))) candidates.push(k);
    else if (shortName && nk.includes(normalizeForMatch(shortName))) candidates.push(k);
  }

  const seen = new Set<string>();
  const out:string[] = [];
  for (const candidate of candidates) {
    const key = normalizeForMatch(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
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
  if (v === 'google news' || v === 'googlenews') return 'Google News';
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
  const commentDeadline = Date.now() + 70000;
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

async function fetchJsonWithRetry(
  url:string,
  init:RequestInit = {},
  maxAttempts = 2
):Promise<any> {
  let lastError:Error|null = null;
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),12000);
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
  maxAttempts = 3
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        12000
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

  let summary = clean(item.text || '').slice(0,520);
  let topic = neg ? 'Potensial problem / şikayət' : 'Media qeydi';
  const ai = await optionalAiAnalysis(org,item,relevance,sentiment);
  if (ai?.summary) summary = String(ai.summary).slice(0,700);
  if (ai?.topic) topic = String(ai.topic).slice(0,160);

  const hash = await sha256(`${org.id}|${item.url}|${item.title||''}`);
  const row:any = {
    organization_id:org.id,
    district_id:org.district_id || null,
    source_platform:canonicalPlatform(source.platform || inferPlatform(item.url || '') || 'Web'),
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
    await admin.from('mention_media').insert({mention_id:data.id,media_type:'preview',url:item.image,captured_at:new Date().toISOString()});
  }
  if (priority >= 81) {
    await admin.from('notifications').insert({organization_id:org.id,mention_id:data.id,title:'Yüksək prioritetli yeni qeyd',body:item.title || 'Yeni material',kind:'critical'});
  }
  return 1;
}

type RunOptions = { debug:boolean; force_youtube:boolean; verify_existing:boolean; youtube_backfill:boolean };

async function readRunOptions(req:Request):Promise<RunOptions> {
  if (req.method !== 'POST') return {debug:false,force_youtube:false,verify_existing:true,youtube_backfill:false};
  try {
    const text = await req.clone().text();
    if (!text.trim()) return {debug:false,force_youtube:false,verify_existing:true,youtube_backfill:false};
    const body = JSON.parse(text);
    return {
      debug:body?.debug === true,
      force_youtube:body?.force_youtube === true,
      verify_existing:body?.verify_existing !== false,
      youtube_backfill:body?.youtube_backfill === true || body?.force_youtube === true
    };
  } catch {
    return {debug:false,force_youtube:false,verify_existing:true,youtube_backfill:false};
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
    .map(normalizeForMatch)
    .filter(Boolean);
  const normalizedKeywords = keywords.map(normalizeForMatch).filter(Boolean);
  const directMatches = direct.filter(term=>term.length >= 4 && normalized.includes(term));

  const district = normalizeForMatch(String(org.districts?.name || ''));
  const villageTerms = villages.map(normalizeForMatch).filter(term=>term.length >= 4);
  const villageHits = villageTerms.filter(term=>normalized.includes(term)).slice(0,5);
  const districtHit = Boolean(district && normalized.includes(district));
  const locationHit = districtHit || villageHits.length > 0;

  // Mövzu sözləri kənd/rayon adı ilə birlikdə qəbul edilir. Beləliklə
  // "Bərdə yol qəzası" kimi sistemə aid olmayan materiallar bazaya düşmür.
  const builtinTopics = [
    'suvarma','suvarma kanali','suvarma arxi','suvarma sebekesi','suvarma suyu',
    'kanal','arx','kollektor','drenaj','meliorasiya','subartezian','subartezan','artezian','artezan',
    'su quyusu','nasos stansiyasi','hidrotexniki','su catismamazligi','susuz',
    'su verilmir','su gelmir','su teminati','su verilisi','su itkisi','ekin sahesi',
    'fermer su','lilden temizlen','su sistemi','su teserrufati'
  ].map(normalizeForMatch);
  const keywordTopics = normalizedKeywords.filter(term=>{
    if (!term) return false;
    if (district && term.includes(district)) return true;
    return builtinTopics.some(topic=>term.includes(topic) || topic.includes(term));
  });
  const topicTerms = [...new Set([...builtinTopics, ...keywordTopics])];
  const topicHits = topicTerms.filter(term=>term.length >= 3 && normalized.includes(term)).slice(0,8);

  const raw:any = item.raw || {};
  const discoveryQuery = normalizeForMatch(String(raw.discovery_query || ''));
  const queryDistrictHit = Boolean(district && discoveryQuery.includes(district));
  const queryTopicHit = topicTerms.some(term=>term && discoveryQuery.includes(term));
  const trustedDiscovery = ['google_news','gdelt_article'].includes(String(raw.kind || '')) &&
    (direct.some(term=>term && discoveryQuery.includes(term)) || (queryDistrictHit && queryTopicHit));

  const foreignDistricts = [
    'agcabedi','agdam','agdas','agsu','astara','balaken','beyleqan','bilesuvar','celilabad','daskesen',
    'fuzuli','gedebey','goranboy','goycay','goygol','haciqabul','imisli','ismayilli','kurdemir','lerik',
    'masalli','neftcala','oguz','qebele','qax','qazax','qusar','saatli','sabirabad','salyan','samaxi',
    'samkir','siyazan','terter','ucar','yardimli','yevlax','zerdab'
  ];
  const foreignHit = foreignDistricts.some(name=>` ${normalized} `.includes(` ${name} `)) && !districtHit && villageHits.length === 0;
  const districtWide = org.show_district_wide !== false;
  const accepted = !foreignHit && (directMatches.length > 0 || (districtWide && locationHit && topicHits.length > 0) || trustedDiscovery);
  const matches = [...new Set([
    ...directMatches,
    ...(districtHit && topicHits.length ? topicHits.map(t=>`${district}+${t}`) : []),
    ...(!districtHit && villageHits.length && topicHits.length ? villageHits.flatMap(v=>topicHits.slice(0,2).map(t=>`${v}+${t}`)) : []),
    ...(trustedDiscovery && discoveryQuery ? [`axtaris:${discoveryQuery}`] : [])
  ])];

  return {
    accepted,
    normalized,
    direct,
    matches,
    reason:accepted
      ? (directMatches.length ? 'təşkilat-adı-uyğunluğu'
        : (districtHit && topicHits.length) ? 'rayon-mövzu-uyğunluğu'
        : (villageHits.length && topicHits.length) ? 'kənd-mövzu-uyğunluğu'
        : 'mənbə-axtarış-uyğunluğu')
      : (foreignHit ? 'başqa-rayon-məlumatıdır' : (locationHit ? 'ərazi-var-mövzu-yoxdur' : 'ərazi-və-mövzu-uyğunluğu-yoxdur'))
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
    .limit(20);
  if (error) throw error;

  const candidates = rows || [];
  let checked = 0, active = 0, removed = 0, unavailable = 0, unchanged = 0;
  const youtubeRows = candidates.filter((x:any)=>String(x.source_platform||'').toLowerCase()==='youtube');
  const otherRows = candidates.filter((x:any)=>String(x.source_platform||'').toLowerCase()!=='youtube');
  const now = new Date().toISOString();

  if (youtubeRows.length && youtubeKey) {
    const ids = youtubeRows.map((row:any)=>extractYoutubeVideoId(row)).filter(Boolean).slice(0,50);
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
    for (const row of youtubeRows) {
      const videoId = extractYoutubeVideoId(row);
      if (!videoId) { unchanged++; continue; }
      checked++;
      if (publicIds.has(videoId)) {
        active++;
        await admin.from('mentions').update({source_status:'active',last_verified_at:now,last_seen_at:now,unavailable_since:null,unavailable_reason:null,consecutive_misses:0}).eq('id',row.id);
      } else {
        unavailable++;
        await markUnavailable(admin,row,'youtube-not-public',now,false);
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
      if (nextMisses >= 2) removed++;
      else unavailable++;
      await markUnavailable(admin,row,`http-${state.status}`,now,nextMisses >= 2);
    } else if (state.kind === 'restricted') {
      unavailable++;
      await markUnavailable(admin,row,`http-${state.status}`,now,false);
    } else {
      unchanged++;
      await admin.from('mentions').update({last_verified_at:now}).eq('id',row.id);
    }
  }

  return {checked,active,removed,unavailable,unchanged};
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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}})
    });
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
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})}
