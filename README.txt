Media Monitorinq — prioritet/keyfiyyət filtri düzəlişi

Dəyişən fayllar:
- assets/js/monitoring.js
- assets/js/reports.js
- assets/js/dashboard.js
- assets/js/notifications.js
- assets/js/azerbaijan-map.js
- assets/css/app.css

Nə düzəldi:
1) 1–30 prioritetli zəif nəticələr bazadan silinmir, amma adi istifadəçi monitorinqi, dashboard, bildiriş və xəritədə göstərilmir.
2) Hesabatdakı Ümumi və platforma sayları artıq istifadəçiyə görünən keyfiyyətli nəticələrlə hesablanır.
3) 1–30 nəticələr hesabatda ayrıca "Zəif — istifadəçidən gizli" kimi göstərilir ki admin nə qədər materialın filtrdə saxlandığını görə bilsin.
4) Köhnə düzgün materialların itirilməməsi üçün legacy qeydlərdə relevance_score >=31 olan nəticələr qorunur.
5) "🌐 Açıq sosial şəbəkə" nişanı artıq yalnız open-social-discovery tərəfindən açıq şəkildə işarələnmiş materiallarda görünür; köhnə Facebook/Instagram kartlarına sırf kind dəyərinə görə vurulmur.

SQL lazım deyil. Supabase məlumatları silinmir və dəyişdirilmir.
Bu paket frontend fayllarıdır; GitHub-a yolları ilə yükləmək kifayətdir.
