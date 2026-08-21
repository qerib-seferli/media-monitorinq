import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

type Item = { title?:string; text?:string; url?:string; published_at?:string|null; image?:string|null; author?:string|null; raw?:unknown };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, service);
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

      // Zero-cost discovery lane: Google News RSS. No API key is required.
      try {
        checked++;
        const rssItems = await googleNewsItems(org, keywords);
        let newsCount = 0;
        for (const item of rssItems.slice(0,30)) newsCount += await save(admin,org,{platform:'Google News',url:'https://news.google.com/'},item,lowerKeywords);
        inserted += newsCount;
        details.push({ organization:org.short_name, source:'Google News RSS', found:rssItems.length, inserted:newsCount });
      } catch (e) {
        failures++;
        console.error('google-news',org.short_name,e);
      }


      // Zero-cost broad public web discovery. Bing RSS is used as a best-effort
      // index lane; it can also surface publicly indexed social posts.
      try {
        checked++;
        const webItems = await bingWebItems(org, keywords, false);
        let webCount = 0;
        for (const item of webItems.slice(0,30)) {
          const platform = inferPlatform(item.url || '');
          webCount += await save(admin,org,{platform,url:'https://www.bing.com/search'},item,lowerKeywords);
        }
        inserted += webCount;
        details.push({ organization:org.short_name, source:'Public Web Index', found:webItems.length, inserted:webCount });
      } catch (e) {
        failures++;
        console.error('public-web-index',org.short_name,e);
      }

      try {
        checked++;
        const socialItems = await bingWebItems(org, keywords, true);
        let socialCount = 0;
        for (const item of socialItems.slice(0,30)) {
          const platform = inferPlatform(item.url || '');
          socialCount += await save(admin,org,{platform,url:item.url || ''},item,lowerKeywords);
        }
        inserted += socialCount;
        details.push({ organization:org.short_name, source:'Public Social Index', found:socialItems.length, inserted:socialCount });
      } catch (e) {
        failures++;
        console.error('public-social-index',org.short_name,e);
      }

      for (const source of sources) {
        checked++;
        try {
          const platform = String(source.platform || 'Web').toLowerCase();

          if (platform === 'youtube') {
            const last = source.last_checked_at ? new Date(source.last_checked_at).getTime() : 0;
            // YouTube Search API quota sərf edir. Planlı iş 15 dəqiqədən bir işləsə də,
            // YouTube lane maksimum 6 saatdan bir çağırılır.
            if (last && Date.now() - last < 6 * 3600 * 1000) {
              details.push({ organization:org.short_name, source:'YouTube', skipped:'quota-window' });
              continue;
            }

            const key = Deno.env.get('YOUTUBE_API_KEY');
            if (!key) {
              details.push({ organization:org.short_name, source:'YouTube', skipped:'missing-youtube-api-key' });
              continue;
            }

            // Əgər bu təşkilat üçün hələ YouTube qeydi yoxdursa, ilk real işə düşmədə
            // son 30 günü geri oxuyuruq. Sonrakı işlər isə yalnız yeni intervalı yoxlayır.
            const { count: existingYoutubeCount } = await admin
              .from('mentions')
              .select('id', { count:'exact', head:true })
              .eq('organization_id', org.id)
              .eq('source_platform', 'YouTube');

            const discovery = await youtubeItems(
              org,
              keywords,
              key,
              existingYoutubeCount ? source.last_checked_at : null
            );

            let count = 0;
            for (const item of discovery.items) {
              count += await save(admin,org,source,item,lowerKeywords);
            }

            // Aşkarlanmış videoların son açıq şərhlərini də yoxlayırıq.
            // save() yalnız təşkilat/açar söz uyğunluğu olan şərhləri bazaya buraxır.
            for (const item of discovery.comments) {
              count += await save(admin,org,source,item,lowerKeywords);
            }

            inserted += count;
            details.push({
              organization:org.short_name,
              source:'YouTube Data API v3',
              queries:discovery.queries,
              videos_found:discovery.items.length,
              comments_checked:discovery.comments.length,
              inserted:count
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
    count += await save(admin, org, source, item, lowerKeywords);
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
              count += await save(admin,org,source,item,lowerKeywords);
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
    }

    return json({ok:true,checked_sources:checked,new_mentions:inserted,failures,details});
  } catch (e) {
    return json({ok:false,error:e.message || String(e)},400);
  }
});

async function googleNewsItems(
  org: any,
  keywords: string[]
): Promise<Item[]> {
  const strong = [
    org.short_name,
    org.name,
    ...keywords
  ]
    .filter(Boolean)
    .map((v: string) => String(v).trim())
    .filter(
      (v: string, i: number, a: string[]) =>
        a.indexOf(v) === i
    )
    .slice(0, 5);

  const query = strong
    .map((v: string) => `"${v.replaceAll('"', '')}"`)
    .join(' OR ');

  const googleUrl =
    `https://news.google.com/rss/search` +
    `?q=${encodeURIComponent(query)}` +
    `&hl=az&gl=AZ&ceid=AZ:az`;

  try {
    const xml = await fetchTextWithRetry(
      googleUrl,
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; MediaMonitorinq/3.0; +https://github.com/)',
          'accept':
            'application/rss+xml, application/xml, text/xml, */*',
          'accept-language': 'az,en;q=0.8'
        }
      },
      3
    );

    const items = parseRss(xml);

    if (items.length) {
      return items;
    }
  } catch (e) {
    console.error(
      'google-news-primary-failed',
      org.short_name,
      e
    );
  }

  // Pulsuz fallback
  const fallbackQuery =
    [org.short_name, 'suvarma']
      .filter(Boolean)
      .join(' ');

  const bingUrl =
    `https://www.bing.com/news/search` +
    `?q=${encodeURIComponent(fallbackQuery)}` +
    `&format=rss`;

  try {
    const xml = await fetchTextWithRetry(
      bingUrl,
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; MediaMonitorinq/3.0)',
          'accept':
            'application/rss+xml, application/xml, text/xml, */*'
        }
      },
      2
    );

    return parseRss(xml);
  } catch (e) {
    console.error(
      'bing-news-fallback-failed',
      org.short_name,
      e
    );

    return [];
  }
}


async function bingWebItems(org:any, keywords:string[], socialOnly=false):Promise<Item[]> {
  const terms = [org.short_name, org.name, ...keywords]
    .filter(Boolean)
    .map((v:string)=>String(v).trim())
    .filter((v:string,i:number,a:string[])=>a.indexOf(v)===i)
    .slice(0,4);

  const phraseQuery = terms.map((v:string)=>`"${v.replaceAll('"','')}"`).join(' OR ');
  const socialScope = socialOnly
    ? ' (site:instagram.com OR site:tiktok.com OR site:linkedin.com OR site:x.com OR site:twitter.com OR site:youtube.com OR site:facebook.com)'
    : '';

  const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(`(${phraseQuery})${socialScope}`)}`;
  const xml = await fetchTextWithRetry(searchUrl,{
    headers:{
      'user-agent':'Mozilla/5.0 (compatible; MediaMonitorinq/3.1)',
      'accept':'application/rss+xml, application/xml, text/xml, */*',
      'accept-language':'az,en;q=0.8'
    }
  },2);

  return parseRss(xml).map(item=>({
    ...item,
    url:unwrapBingUrl(item.url || ''),
    raw:{...((item.raw as any)||{}), discovery:socialOnly?'social-index':'web-index'}
  }));
}

function unwrapBingUrl(value:string) {
  try {
    const u = new URL(value);
    const nested = u.searchParams.get('url');
    return nested ? decodeURIComponent(nested) : value;
  } catch {
    return value;
  }
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
  key:string,
  lastCheckedAt:string|null
):Promise<{items:Item[]; comments:Item[]; queries:string[]}> {
  const district = String(org.districts?.name || '').trim();
  const shortName = String(org.short_name || '').trim();
  const fullName = String(org.name || '').trim();

  const usefulKeywords = keywords
    .map((x:string)=>String(x || '').trim())
    .filter(Boolean)
    .filter((x:string)=>x.length >= 3 && x.length <= 70)
    .filter((x:string)=>![shortName,fullName].includes(x))
    .slice(0,4);

  // Quota nəzarəti: hər təşkilat üçün maksimum 2 Search API sorğusu.
  // 1) təşkilatın adı, 2) rayon + ən güclü monitorinq terminləri.
  const queries = [
    shortName || fullName,
    [district, ...usefulKeywords.slice(0,2)].filter(Boolean).join(' ')
  ]
    .map((x:string)=>x.trim())
    .filter(Boolean)
    .filter((v:string,i:number,a:string[])=>a.indexOf(v)===i)
    .slice(0,2);

  const lastMs = lastCheckedAt ? new Date(lastCheckedAt).getTime() : 0;
  const backfillMs = 30 * 24 * 3600 * 1000;
  const overlapMs = 2 * 3600 * 1000;
  const publishedAfter = new Date(
    lastMs && Number.isFinite(lastMs)
      ? Math.max(Date.now() - backfillMs, lastMs - overlapMs)
      : Date.now() - backfillMs
  ).toISOString();

  const searchItems:any[] = [];

  for (const q of queries) {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
    endpoint.searchParams.set('part','snippet');
    endpoint.searchParams.set('type','video');
    endpoint.searchParams.set('maxResults','25');
    endpoint.searchParams.set('order','date');
    endpoint.searchParams.set('publishedAfter',publishedAfter);
    endpoint.searchParams.set('q',q);
    endpoint.searchParams.set('relevanceLanguage','az');
    endpoint.searchParams.set('regionCode','AZ');
    endpoint.searchParams.set('key',key);

    const data = await fetchJsonWithRetry(endpoint.toString(), {}, 2);
    if (data?.error) throw new Error(data.error?.message || 'YouTube Search API xətası');
    searchItems.push(...(data?.items || []));
  }

  const byVideoId = new Map<string,any>();
  for (const x of searchItems) {
    const id = String(x?.id?.videoId || '');
    if (id && !byVideoId.has(id)) byVideoId.set(id,x);
  }

  const videoIds = [...byVideoId.keys()].slice(0,50);
  const detailsById = new Map<string,any>();

  if (videoIds.length) {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
    endpoint.searchParams.set('part','snippet,statistics,contentDetails');
    endpoint.searchParams.set('id',videoIds.join(','));
    endpoint.searchParams.set('key',key);
    const data = await fetchJsonWithRetry(endpoint.toString(), {}, 2);
    if (data?.error) throw new Error(data.error?.message || 'YouTube Videos API xətası');
    for (const v of data?.items || []) detailsById.set(String(v.id),v);
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
  // Şərh sorğuları ucuzdur, amma funksiyanın vaxtını və kvotanı qorumaq üçün
  // ən yeni maksimum 8 videonu yoxlayırıq.
  for (const item of items.slice(0,8)) {
    const raw:any = item.raw || {};
    const videoId = String(raw.video_id || '');
    if (!videoId) continue;
    try {
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
      endpoint.searchParams.set('part','snippet');
      endpoint.searchParams.set('videoId',videoId);
      endpoint.searchParams.set('maxResults','20');
      endpoint.searchParams.set('order','time');
      endpoint.searchParams.set('textFormat','plainText');
      endpoint.searchParams.set('key',key);
      const data = await fetchJsonWithRetry(endpoint.toString(), {}, 1);
      if (data?.error) continue; // şərhlər bağlı ola bilər

      for (const thread of data?.items || []) {
        const top = thread?.snippet?.topLevelComment;
        const sn = top?.snippet || {};
        const commentId = String(top?.id || thread?.id || '');
        const text = String(sn.textDisplay || sn.textOriginal || '').trim();
        if (!commentId || !text) continue;
        comments.push({
          title:`YouTube şərhi — ${sn.authorDisplayName || 'istifadəçi'}`,
          text,
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
            thread
          }
        });
      }
    } catch (e) {
      console.error('youtube-comments',videoId,e);
    }
  }

  return { items, comments, queries };
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

async function save(admin:any, org:any, source:any, item:Item, keywords:string[]) {
  if (!item.url) return 0;
  const normalized = `${item.title || ''} ${item.text || ''}`.toLocaleLowerCase('az-AZ');
  const direct = [String(org.name||''),String(org.short_name||'')].map(x=>x.toLocaleLowerCase('az-AZ')).filter(Boolean);
  const matches = [...new Set([...direct,...keywords].filter(k=>k && normalized.includes(k)))];
  if (!matches.length) return 0;

  const negativeWords = ['şikayət','problem','su yoxdur','su gəlmir','verilmir','quruyur','narazı','etiraz','çatışmazlıq','susuz','kanal təmizlənmir'];
  const positiveWords = ['təşəkkür','bərpa olundu','təmir edildi','su verildi','işlər başa çatdı'];
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
    source_platform:source.platform || 'Web',
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
    raw_payload:item.raw || item
  };

  const { data, error } = await admin.from('mentions')
    .upsert(row,{onConflict:'organization_id,content_hash',ignoreDuplicates:true})
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return 0;

  if (item.image) {
    await admin.from('mention_media').insert({mention_id:data.id,media_type:'preview',url:item.image,captured_at:new Date().toISOString()});
  }
  if (priority >= 81) {
    await admin.from('notifications').insert({organization_id:org.id,mention_id:data.id,title:'Yüksək prioritetli yeni qeyd',body:item.title || 'Yeni material',kind:'critical'});
  }
  return 1;
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
