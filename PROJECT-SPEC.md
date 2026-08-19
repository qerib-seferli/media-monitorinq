# Media Monitorinq — Master Project Specification

Bu sənəd layihənin qəbul edilmiş əsas tələblərini qoruyur. Funksiya əlavə/dəyişiklik ediləndə bu siyahı ilə uyğunluq yoxlanmalıdır.

## Məhsul
- Rəsmi ad: **Rəqəmsal Media Monitorinq Sistemi**
- Qısa ad: **Media Monitorinq**
- İlk tenant: Bərdə SMSİİ
- Multi-tenant SaaS: Bərdə, Tərtər, Ağdam və gələcək təşkilatlar eyni platformada, məlumatları ayrılmış şəkildə.
- Telegram yoxdur. Əsas məhsul PWA + tətbiqdaxili/push bildirişdir.
- Məqsəd: maksimum 0 AZN aylıq xərc; yalnız zəruri halda minimum ödənişli xidmət.
- Heç bir xidmət avtomatik pullu plana keçməməlidir.

## Platforma/PWA
- Android, iPhone/iPad, Windows, macOS, desktop/tablet responsive.
- Installable PWA, standalone görünüş, manifest, service worker, offline app shell.
- Full compact/pro UI/UX, native-app hissi.
- Mobil aşağı menyu: Əsas, Monitorinq, Bildirişlər, Hesabat, Profil.
- Desktop: sidebar + topbar.
- Header: sol dövlət gerbi üçün təsdiqlənmiş asset slotu, orta təşkilat adı + Media Monitorinq, sağ istifadəçi adı/vəzifəsi/profil şəkli.
- Vizual dil: tünd lacivərd/graphite/ağ/qızılı premium aksent, glass/depth/micro-animation/3D düymələr.

## Super Admin
- Super Admin email: qerib-seferli@mail.ru
- Bütün təşkilatları/məlumatları görə bilir.
- Admin paneldən kod/SQL dəyişmədən yeni tenant yaradır.
- Təşkilatlar, istifadəçilər, vəzifələr, rollar/permissions, rayon/kənd/ərazi, keywords, sources, monitoring, subscriptions/payments, notifications, audit, resource/cost guard idarəsi.

## Tenant və xidmət statusu
- Organization status: active, grace, suspended, archived.
- Xidmət **istifadəçiyə görə yox təşkilat üzrə** dayandırılır.
- Tərtər SMSİİ suspended olarsa rəis/müavin/baş mühəndis/hamı bloklanır.
- Məlumat silinmir; yenidən active ediləndə davam edir.
- User `is_active` ayrıca konkret şəxsi bloklamaq üçündür; org service status-dan ayrıdır.

## İstifadəçilər
- Admin paneldən ad, soyad, e-mail/login, müvəqqəti şifrə, təşkilat, vəzifə, sistem rolu, status, profil şəkli/telefon idarəsi.
- Eyni təşkilatda rəis, müavin, baş mühəndis və başqa istifadəçilər.
- Vəzifələr dinamikdir, kodda hard-code edilmir.
- Vəzifə ilə sistem rolu ayrıdır.
- Rollar: super_admin, organization_admin, manager, analyst, viewer; gələcəkdə granular permissions.
- Super Admin istifadəçi hesabını aktiv/deaktiv edə və parolu sıfırlaya bilir.
- Service role key heç vaxt frontend-də olmur.

## Təhlükəsizlik
- Supabase Auth.
- RLS tenant isolation: browser filtri deyil, DB server səviyyəsində.
- İstifadəçi yalnız öz organization məlumatlarını oxuyur; Super Admin hamısını.
- Suspended tenant məlumat əldə edə bilməz.
- Adi istifadəçi organization_id, role, is_active və digər kritik profil sahələrini dəyişə bilməz.
- Audit log kritik dəyişiklikləri saxlayır.

## Ərazi
- Districts, villages, organization_locations admin paneldən idarə olunur.
- Yeni tenant öz rayon/kənd/ərazi məlumatları ilə konfiqurasiya edilir.
- Bərdə hard-code edilmir.

## Monitorinq aşkarlaması
- Birbaşa adlar/yazılış variantları.
- Kontekst kombinasiyaları (rayon + suvarma/kanal/arx/fermer/su problemi və s.).
- Semantik AI: təşkilat adı yazılmasa da məna/ərazi/kontekstdən aidiyyəti tapmaq.
- Keywords/synonyms/topics/negative/location terminləri admin paneldən dəyişir.
- Sources admin paneldən əlavə olunur, aktiv/deaktiv və prioritet verilə bilir.
- Açıq mənbələr: YouTube, uyğun public Facebook/Instagram/TikTok/X imkanları, xəbər saytları, RSS, blog, regional web və gələcək connectorlar.
- Platforma qaydalarına zidd “100% bütün internet” iddiası yoxdur.

## Analiz edilən content
- Başlıq, açıqlama/post mətni, şərhlər (əlçatan olduqda), şəkil və şəkildəki mətn (OCR), video və danışıq transkripti, metadata, ərazi/mənbə.
- Video pipeline: video → audio → speech-to-text → transkript → AI.
- AI-dən əvvəl ucuz rule/keyword/location/dedupe filter; quota qorunur.

## AI nəticəsi
- Aidiyyət organization.
- Relevance score.
- District/village.
- Topic/type.
- Sentiment positive/neutral/negative.
- Priority/risk 0–100.
- Qısa xülasə.
- Cavab tələb edir flag və gələcəkdə AI cavab draftı.
- AI özbaşına sosial şəbəkəyə cavab yazmır; insan təsdiqi tələb olunur.

## Risk/trend/dedup
- 0–30 zəif, 31–60 yoxlanmalı, 61–80 mühüm, 81–100 yüksək/kritik.
- Trend/spike aşkarlanması: eyni ərazi/mövzu üzrə sürətli artım.
- Dublikat/eyni hadisə materialları incident altında qruplaşdırılmalıdır.

## Nəticə/Hadisə səhifəsi
- Təşkilat, başlıq, platforma, tarix, ərazi, relevance/risk, sentiment, AI xülasəsi, original text.
- **Orijinal paylaşımı aç** kliklənən link.
- Source URL/post id/author/published/detected timestamps saxlanır.
- Status workflow: new, reviewing, in_progress, investigating, answered, not_relevant, closed, archived.
- Kim/nə vaxt status dəyişdi audit-də görünür.

## Screenshot/Media sübutu
- Mümkün olduqda aşkarlanma anı screenshot/media saxlanır.
- Bir mention-da birdən çox media ola bilər.
- Fullscreen viewer: zoom in/out, pinch/transform uyğun UX, share, phone save/download, source link.
- Screenshot metadata: captured_at, source_url, dimensions, file_hash mümkün olduqda.
- Fallback: screenshot → preview/media → text+metadata+URL; nəticə heç vaxt screenshot alınmadığı üçün itmir.

## Dashboard/Bildiriş/Hesabat
- Dashboard: bu gün yeni, kritik, şikayət/mənfi, müsbət, xəbər və son nəticələr.
- PWA push notification: yüksək prioritet nəticə; klik → hadisə.
- Tətbiqdaxili Notification Center: oxunmamış/hamısı/kritik/sistem.
- Hesabat: gün/həftə/ay/custom interval; total, sentiment, complaint/critical, area/source/topic.
- Gələcək PDF/Excel export.

## Abunə/biznes
- Organization üzrə paket, aylıq qiymət, start, next payment, status, payment history.
- Ödəniş edilməyəndə whole organization service suspend.
- Super Admin biznes dashboard: aktiv/dayandırılmış tenant, user count, mentions, aylıq portfel/gözlənilən ödəniş, resource/AI/storage/API quota.

## İnfrastruktur
- GitHub / GitHub Pages.
- Supabase PostgreSQL/Auth/RLS/Storage/Edge Functions.
- GitHub Actions və ya Cloudflare free imkanları scheduler/worker üçün.
- AI provider router: free tier birinci, fallback rule-based; model/provider gələcəkdə dəyişə bilməlidir.
- Cost guard/usage metrics.

## Qəbul kriteriyası — yeni təşkilat
Super Admin UI-dan:
1. `+ Təşkilat`
2. ad/qısa ad/rayon/abunə/status
3. kənd/ərazi
4. keyword/source
5. `+ İstifadəçi`
6. vəzifə/rol/login/şifrə
7. aktivləşdir

Bundan sonra tenant işləməlidir. **GitHub kodu, JS və SQL dəyişmək tələb olunmamalıdır.**
