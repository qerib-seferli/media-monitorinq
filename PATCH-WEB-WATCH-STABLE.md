# Web monitor — sürətli watch + təmiz mənbə bankı

Bu paket yalnız dəyişən/yeni faylları ehtiva edir.

## Dəyişikliklər

- `web-fast-watch` hər 5 dəqiqədə yalnız seçilmiş sayt paketini yüngül rejimdə yoxlayır.
- Sürətli rejimdə sitemap arxivləri və domen üzrə Bing axtarışı eyni anda işləmir; bu, 10–15 dəqiqəlik run və `The operation was canceled` problemini aradan qaldırmaq üçündür.
- `web-archive-discovery` saatda bir dəfə ayrıca dərin axtarış edir.
- Bir run-da ingest, enrich və screenshot sayı limitlənib; növbəti run növbəti mənbə paketinə keçir.
- SQL yalnız **Bərdə SMSİİ** üçün Web/RSS/Google News mənbələrini təmizləyir və istifadəçinin verdiyi işlək siyahını yenidən yazır.
- Redirect domenləri son işlək domenlə saxlanılır. Buna görə 140 girişdən kanonik siyahıda 139 unikal mənbə qalır.

## GitHub-a köçürüləcək fayllar

1. `.github/workflows/media-monitor.yml`
2. `scripts/news-gateway.mjs`
3. `PATCH-WEB-WATCH-STABLE.md`

## Supabase SQL Editor-də bir dəfə RUN ediləcək fayl

`supabase/sql/RESET-BERDE-WEB-SOURCES.sql`

SQL YouTube və digər sosial platforma mənbələrinə toxunmur.

## Yoxlama

GitHub Actions-da manual `Run workflow` etdikdə üç job görünə bilər: YouTube, sürətli Web watch və dərin arxiv discovery. Normal cron zamanı sürətli Web hər 5 dəqiqədə, dərin Web isə saatın 17-ci dəqiqəsində işləyir.
