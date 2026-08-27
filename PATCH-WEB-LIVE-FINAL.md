# Web/Xəbər canlı izləmə və dedupe patch

Dəyişən hissələr: 
- GitHub gateway Web/Xəbər discovery-ni .az domenləri və təşkilatın birbaşa saytları ilə genişləndirir.
- Bərdə SMSİİ üçün `berdesmsii.az` avtomatik birbaşa Web mənbəsi kimi yoxlanır; SQL onu `sources` cədvəlinə də əlavə edir.
- Sitemap / RSS / Atom / ana səhifə daxili link discovery dəstəyi əlavə olunub.
- Konfiqurasiya edilmiş saytlar üçün ayrıca sürətli watch job-u əlavə olunub.
- Monitorinq frontend köhnə Web dublikatlarını başlıq+tarix üzrə bir dəfə göstərir.
- Hesabat köhnə Web dublikatlarını təkrar saymır.
- Service Worker cache versiyası yenilənib.

## Tətbiq
1. ZIP-dəki faylları eyni yollarla GitHub repo-da replace/add edin.
2. GitHub Actions deploy/schedule faylı avtomatik yenilənəcək.
3. Supabase SQL Editor-də `sql/web-news-live-finalize.sql` faylını bir dəfə RUN edin.
4. GitHub Actions > Media Monitorinq Worker > Run workflow edin.
5. `Web and news gateway` və `Configured websites fast watch` loglarını yoxlayın.
6. Frontenddə Ctrl+F5 edin.

Qeyd: arbitrar Web səhifələri üçün həqiqi push-realtime standartı yoxdur. Konfiqurasiya edilmiş saytlar birbaşa yoxlanır; Google/Bing discovery isə həmin axtarış sistemlərinin indeksləmə sürətindən asılıdır.
