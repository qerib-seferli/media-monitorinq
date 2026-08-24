# Web/Xəbər dedupe + geniş discovery patch

Bu patch Google News-i ayrıca istifadəçi platforması kimi deyil, Web/Xəbər discovery provider-i kimi istifadə edir. Frontend filtrindən `Google News` çıxarılıb; Google News RSS-dən tapılan uyğun materiallar `Web` altında görünür.

## Tövsiyə olunan tətbiq sırası
1. ZIP-dəki dəyişən faylları GitHub-da eyni yollarla replace edin.
2. `Deploy Supabase Functions` workflow-u işlədin.
3. Supabase SQL Editor-də `sql/web-news-dedupe-cleanup.sql` faylını bir dəfə RUN edin.
4. `Media Monitor Worker` workflow-u manual işə salın.
5. Web nəticələrini yoxlayın. Növbəti 5 dəqiqəlik run-larda fərqli sorğu qrupları rotasiya olunaraq arxiv böyüyəcək.

## Tam sıfırdan Web backfill (opsional)
Əgər Web nəticələrini tam silib yenidən toplamaq istəyirsinizsə, yalnız onda `sql/OPTIONAL-reset-web-news-only.sql` işlədin. Bu SQL YouTube qeydlərinə toxunmur.
