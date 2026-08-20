# Media Monitorinq — Phase 2 Edge Functions

Bu paketdə `admin-users` və `monitor-worker` real iş axını üçün hazırlanıb.

## Lazım olan GitHub Repository Secrets

- `SUPABASE_ACCESS_TOKEN` — Supabase account access token (yalnız function deploy workflow üçün)
- `MONITOR_SECRET` — özünüz yaratdığınız uzun təsadüfi secret
- `YOUTUBE_API_KEY` — optional; yoxdursa YouTube skan edilməyəcək
- `GEMINI_API_KEY` — optional; yoxdursa rule-based analiz işləyəcək

`MONITOR_SECRET` həm Supabase Function secret, həm də GitHub Repository Secret kimi eyni dəyərdə olmalıdır.

## Deploy

GitHub → Actions → **Deploy Supabase Functions** → Run workflow.

Deploy tamamlandıqdan sonra Super Admin dashboard-da **Monitorinqi indi işə sal** düyməsi ilə dərhal real yoxlama etmək mümkündür.

## Avtomatik monitorinq

`.github/workflows/media-monitor.yml` hər 15 dəqiqədən bir `monitor-worker`-i çağırır.
Google News RSS üçün API açarı lazım deyil. YouTube API quota qorunması üçün bir YouTube mənbəyi maksimum 6 saatdan bir yoxlanır.
