V91 — MONİTORİNQ STABİLLƏŞDİRMƏ + PLATFORMA UI

Yalnız dəyişən fayllar bu ZIP-dədir.

GitHub-a öz yolları ilə yüklə:
- monitorinq.html
- sw.js
- assets/js/monitoring.js
- assets/css/app.css
- supabase/functions/monitor-worker/index.ts
- .github/workflows/media-monitor.yml
- .github/workflows/full-network-radar.yml

Sonra:
1) Deploy Supabase Functions workflow-nu işə sal və yaşıl olmasını gözlə.
2) Supabase SQL Editor-də sql/v91-monitorinq-stabilization.sql faylının hamısını bir dəfə Run et.
3) Media Monitoring Worker-i bir dəfə manual başlat.
4) Monitorinq səhifəsini Ctrl+F5 ilə yenilə. PWA-dadırsa tətbiqi tam bağlayıb yenidən aç.

Bu patch nə edir:
- Web nəticələrinin hər run-da 7→4 / 38→4 kimi söz bankına görə dalğalanmasını azaldır.
- Güclü sübutla qəbul edilmiş real materiallara stabil acceptance kilidi verir.
- Köhnə DB exclude bankında səhv kateqoriyaya düşmüş pozitiv frazanın real rayon+mövzu materialını avtomatik silməsinin qarşısını alır.
- Trump, ölüm/itkin, media-kanalı, mədəniyyət/turizm, nəqliyyat və başqa rayon kimi deterministik false-positive veto-ları saxlayır.
- YouTube platforma yazılışlarını vahidləşdirir.
- Scheduled worker-də Brave xərci 0 edilir; tam radarda maksimum büdcə azaldılır.
- Monitorinq səhifəsinə platforma düymələri və platformaya aid alt filtrlər əlavə edir.
- Mobil/PWA-da platforma düymələri sürüşən kompakt zolaq kimi işləyir, kart daşması qorunur.
- Service Worker cache versiyası dəyişir ki, köhnə frontend cache-də qalmasın.

Vacib:
- SQL heç bir mention silmir.
- SQL relevance_score-u kütləvi qaldırmır.
- Köhnə YouTube/Web arxivi silinmir.
