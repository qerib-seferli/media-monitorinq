# Rəqəmsal Media Monitorinq Sistemi

**Qısa ad:** Media Monitorinq  
**Model:** Multi-tenant PWA / SaaS  
**İlk təşkilat:** Bərdə SMSİİ  
**Super Admin e-mail:** `qerib-seferli@mail.ru`

Bu repository GitHub Pages + Supabase üzərində işləyən ilkin professional platforma skeletidir. Layihə Bərdə üçün hard-code edilməyib: yeni təşkilat, istifadəçi, vəzifə, rayon/kənd, açar söz, mənbə və xidmət statusu Super Admin panelindən idarə olunur.

## Hazır modullar

- Supabase Auth login
- Super Admin / Organization Admin / Manager / Analyst / Viewer rolları
- Təşkilat səviyyəsində aktiv / grace / suspended / archived xidmət statusu
- İstifadəçi səviyyəsində ayrıca aktiv / deaktiv statusu
- Təşkilat izolasiya edən Supabase RLS
- Təşkilat, istifadəçi, vəzifə, rayon/kənd, açar söz və mənbə idarəsi
- İstifadəçi yaratma və parol sıfırlama Edge Function-u
- Monitorinq nəticələri, AI xülasəsi üçün sahələr, risk/relevance score, sentiment
- Orijinal mənbə linki
- Screenshot/media qalereyası, fullscreen zoom/share/save UI
- Dashboard, Monitorinq, Hesabat, Profil
- PWA manifest, service worker, offline app shell
- Push notification üçün DB + service-worker infrastrukturu
- GitHub Actions-dan 15 dəqiqəlik monitor worker trigger-i
- RSS, sadə Web və optional YouTube monitor worker nüvəsi
- Audit, abonəlik, ödəniş, usage/cost guard cədvəlləri
- Default cost guard: avtomatik pullu plana keçid yoxdur

## 1. GitHub

Repository yaradın və ZIP-in içindəki bütün faylları repository kökünə yükləyin. GitHub Pages-i repository root-dan aktiv edin.

## 2. Supabase database

Supabase Dashboard → SQL Editor bölməsində ardıcıllıqla işlədin:

1. `supabase/migrations/001_media_monitorinq.sql`
2. `supabase/migrations/002_seed_barda.sql` (Bərdə SMSİİ ilkin tenantı üçün tövsiyə olunur)

Frontend artıq bu project URL və anon/public key ilə konfiqurasiya olunub:

- Project URL: `https://xsmahlsqdszxqordgcvt.supabase.co`
- Public anon key: `assets/js/config.js`

**Service Role Key frontend-də yoxdur və heç vaxt əlavə edilməməlidir.**

## 3. İlk Super Admin hesabı

SQL migrasiyasından sonra Supabase Dashboard → Authentication → Users bölməsindən:

- e-mail: `qerib-seferli@mail.ru`
- güclü şifrə: özünüz seçin
- e-mail confirmed: aktiv

istifadəçi yaradın. Auth trigger bu e-mail üçün profili avtomatik `super_admin` rolu ilə yaradacaq.

Əgər həmin auth user migrasiyadan əvvəl yaradılmışdısa, aşağıdakı SQL-ni bir dəfə işlədin:

```sql
insert into public.profiles(auth_user_id,email,system_role,is_active)
select id,email,'super_admin',true
from auth.users
where lower(email)=lower('qerib-seferli@mail.ru')
on conflict(auth_user_id) do update
set system_role='super_admin', is_active=true, email=excluded.email;
```

## 4. Edge Functions

Supabase CLI ilə project-ə login/link etdikdən sonra:

```bash
supabase functions deploy admin-users
supabase functions deploy ingest-mention
supabase functions deploy monitor-worker
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` və `SUPABASE_SERVICE_ROLE_KEY` Supabase Edge Function mühitində platforma tərəfindən istifadə olunur. Private service role key-i repository-yə yazmayın.

Monitor worker üçün private secret yaradın:

```bash
supabase secrets set MONITOR_SECRET="UZUN_TESADUFI_SECRET"
```

YouTube monitorinqi də aktiv ediləcəksə:

```bash
supabase secrets set YOUTUBE_API_KEY="YOUR_KEY"
```

## 5. GitHub Actions monitor trigger

Repository → Settings → Secrets and variables → Actions bölməsində bunları əlavə edin:

- `MONITOR_WORKER_URL` = `https://xsmahlsqdszxqordgcvt.supabase.co/functions/v1/monitor-worker`
- `MONITOR_SECRET` = Supabase-da verdiyiniz eyni uzun random secret

`.github/workflows/monitor.yml` hər 15 dəqiqədə worker-i çağıracaq. Secret-lər qoyulmayıbsa workflow təhlükəsiz şəkildə işi skip edir.

## 6. İlk girişdən sonra

Super Admin panelində:

1. Bərdə SMSİİ tenantını yoxlayın.
2. Rayon/kəndləri əlavə edin.
3. Vəzifələri əlavə/dəyişin.
4. `+ İstifadəçi` ilə Vüqar Zeynalov, Vüsal Əliyev, İlqar Mahmudov və digər real əməkdaşların hesablarını yaradın.
5. Hər birinə təşkilat, vəzifə və sistem rolunu seçin.
6. Monitorinq açar sözlərini təşkilata bağlayın.
7. İzlənilən mənbələri əlavə edin.
8. Aylıq qiymət və növbəti ödəniş tarixini təşkilatda saxlayın.

Tərtər/Ağdam üçün eyni kodu dəyişmək lazım deyil: `+ Təşkilat` → rayon → istifadəçilər → açar sözlər/mənbələr.

## Xidmət statusu məntiqi

`profiles.is_active` — konkret şəxsin hesab statusudur.  
`organizations.service_status` — bütün təşkilatın xidmət statusudur.

Təşkilat `suspended` olarsa həmin təşkilatın rəisi, müavini, baş mühəndisi və digər istifadəçiləri giriş edə bilməz. Hesablar və məlumatlar silinmir. Təşkilat `active` ediləndə yenidən işləyir.

## Screenshot/media

`mention_media` bir monitorinq qeydində birdən çox şəkil/screenshot/video preview saxlaya bilir. UI şəkli böyütmə, paylaşma və yükləmə düymələri ilə göstərir. Avtomatik screenshot almaq platformanın icazə və anti-bot qaydalarından asılı olduğuna görə collector mərhələsində fallback belədir:

1. screenshot mümkündür → saxla;
2. screenshot mümkün deyil → preview/media saxla;
3. media mümkün deyil → URL + mətn + metadata saxla.

## Dövlət gerbi haqqında

Repository-də `assets/img/state-emblem.svg` **rəsmi gerb deyil**, premium UI üçün müvəqqəti “AZ” placeholder-dır. İstehsal versiyasında rəsmi dövlət simvolunu yalnız uyğun hüquqi/brand qaydalarına əsasən təsdiqlənmiş asset ilə əvəz edin. Fayl adını eyni saxlasanız UI koduna toxunmaq lazım deyil.

## Təhlükəsizlik

- anon/public key frontend-də istifadə üçün nəzərdə tutulub.
- service role key frontend-ə və GitHub-a commit edilmir.
- istifadəçi yaratma/parol reset yalnız `admin-users` Edge Function-da Super Admin yoxlamasından sonra edilir.
- adi istifadəçi organization/role/is_active kimi kritik profil sahələrini dəyişə bilmir.
- RLS tenant məlumatlarının browser filtrindən asılı olmadan server səviyyəsində ayrılmasını təmin edir.

## Növbəti inkişaf mərhələləri

Bu ZIP foundation/v1-dır. Üzərindən növbəti mərhələlərdə:

- real YouTube video + comment collector;
- daha geniş RSS/xəbər mənbələri;
- platforma icazələri daxilində Facebook/Instagram/TikTok/X connector-ları;
- OCR və video speech-to-text;
- Gemini/Workers AI semantic classifier + fallback router;
- incident clustering/dedup;
- Web Push subscription/server sender;
- PDF/Excel hesabat export;
- screenshot capture worker;
- payment history/automatic grace policies;
- richer permissions matrix;
- mobile UX polish və install prompt

əlavə edilməlidir.

## Əsas fayllar

```text
index.html                Login
app.html                  Təşkilat dashboard-u
monitorinq.html           Monitorinq nəticələri
hesabat.html              Hesabat
profile.html              Profil
admin.html                Super Admin
blocked.html              User/təşkilat blok ekranı
assets/css/app.css        Full responsive UI
assets/js/                Frontend modulları
supabase/migrations/      Database + RLS
supabase/functions/       Secure backend/worker
.github/workflows/        Scheduled monitor trigger
manifest.webmanifest      PWA
sw.js                     Service worker
```
