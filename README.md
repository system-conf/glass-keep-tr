# Keep Pro

Modern not uygulaması. Markdown, yapilacaklar listesi, Gorseller, etiketler, renk temalari, karanlik mod, surukle-birak, ice/disa aktarma, kimlik dogrulama ve gercek zamanli isbirligi.

**Teknoloji:** React 19, Vite 7, Express, Turso (cloud SQLite), StarkCDN (görsel depolama), Tailwind CSS 4

---

## Ozellikler

**Kimlik Dogrulama**
- Kayit, giris, cikis
- Gizli kurtarma anahtari ile giris
- Rastgele olusturulan admin sifresi (ilk kurulumda konsolda gosterilir)
- Kullanici bazli not erisimi

**Yapay Zeka Asistani (Llama 3.2)**
- Sunucu tarafinda calisan, tamamen ozel AI
- Notlarinizi okuyarak sorularinizi yanitlar
- Akilli arama - notlariniz arasinda anlam bazli arama

**Gercek Zamanli Isbirligi**
- Coklu kullanici ayni anda not duzenleyebilir
- Kullanici adi/e-posta ile isbirlikci ekleme/cikarma
- Otomatik cakisma cozumleme
- Salt okunur mod desteği

**Yonetim Paneli**
- Kullanici olusturma, duzenleme, silme
- Yeni hesap olusturmayi acma/kapama
- Kullanici bazli depolama ve not istatistikleri

**Not Turleri**
- Markdown destekli metin notlari (H1-H3, bold, italic, code, link)
- Yapilacaklar listesi (surukle-birak siralama)
- Cizim notlari (serbest cizim, ozellestirilebilir firca)
- Akilli Enter - listeleri otomatik devam ettirir

**Gorseller**
- Coklu gorsel ekleme (istemci tarafinda sicistirma)
- StarkCDN bulut depolama
- Tam ekran goruntulleyici (indirme, onceki/sonraki)

**Organizasyon**
- Sabitle / Sabitlemekten vazgec
- Etiket cipleri (virgulle ekleme, hizli ekleme/cikarma)
- Not bazli renk temalari
- Arama (baslik, markdown, etiketler, kontrol listesi, Gorsel adlari)
- Surukle-birak siralama

**Veri**
- JSON olarak disa/ice aktarma
- Google Keep'ten ice aktarma
- Markdown dosyalarindan ice aktarma
- Not bazli .md indirme

**PWA** - Masaustu ve mobilde kurulabilir

**Tema** - Tailwind v4 glassmorphism tasarim, karanlik/aydinlik mod, responsive

---

## Mimari

```
.
├─ public/                 PWA ikonlari
├─ src/                    React uygulamasi
│  ├─ App.jsx             Ana uygulama bileseni
│  ├─ DrawingCanvas.jsx   Cizim bileseni
│  ├─ ai.js               AI asistan modulu
│  └─ main.jsx            Giris noktasi
├─ server/                 Express API
│  ├─ index.js            Ana sunucu dosyasi
│  ├─ db.js               Turso veritabani modulu
│  └─ cdn.js              StarkCDN Gorsel modulu
├─ api/                    Vercel serverless entry point
│  └─ index.js
├─ .github/workflows/      GitHub Actions CI
│  └─ ci.yml
├─ index.html
├─ vite.config.js
├─ vercel.json             Vercel deploy yapilandirmasi
└─ package.json
```

---

## Kurulum

### Ortam Degiskenleri

Projede `.env` dosyasi olusturun:

```env
JWT_SECRET=uzun-rastgele-bir-string-yazin
TURSO_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
STARKCDN_API_KEY=your-starkcdn-api-key
STARKCDN_PROJECT_ID=8
```

### Gelistirme

```bash
npm install
npm run dev
```

Frontend: http://localhost:5173 | API: http://localhost:8080

### Turso Veritabani

1. [turso.tech](https://turso.tech) adresinden ucretsiz hesap olusturun
2. Yeni bir veritabani olusturun
3. URL ve Auth Token'i `.env` dosyasina ekleyin
4. Tablolar otomatik olusturulur

---

## Deploy

### Vercel

1. [vercel.com](https://vercel.com) adresinden New Project olusturun
2. `glass-keep-tr` reposunu secin
3. Environment Variables ekleyin:

```
JWT_SECRET=uzun-rastgele-string
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
STARKCDN_API_KEY=your-key
STARKCDN_PROJECT_ID=8
```

4. Deploy edin

### Docker

```bash
docker build -t glass-keep .
docker run -d \
  --name glass-keep \
  --restart unless-stopped \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e JWT_SECRET="uzun-rastgele-string" \
  -e TURSO_URL="libsql://your-db.turso.io" \
  -e TURSO_AUTH_TOKEN="your-token" \
  -e STARKCDN_API_KEY="your-key" \
  -e STARKCDN_PROJECT_ID="8" \
  glass-keep
```

---

## Yonetim Paneli

- **Gelistirme:** http://localhost:5173/#/admin
- **Production:** http://localhost:8080/#/admin
- **Erisim:** `is_admin = 1` olan kullanicilar
- **Ilk giris:** Sunucu ilk basladiginda konsolda admin sifresi gosterilir

---

## Guvenlik

- JWT Secret zorunlu (hardcoded fallback yok)
- bcrypt ile sifre hashleme (async)
- Rate limiting: Auth endpoint'leri (20/15dk), AI endpoint'i (10/dk)
- DOMPurify ile XSS korumasi (markdown rendering)
- Helmet.js security header'lari (HSTS, X-Frame-Options, vb.)
- CORS allowlist (origin reflection yok)
- Gorsel depolama StarkCDN uzerinden (base64 DB'de tutulmuyor)
- Input uzunluk validasyonu
- `is_admin` strict boolean kontrolu
- Guvenli ID uretimi (crypto.randomUUID)
- Content Security Policy

---

## Lisans

MIT
