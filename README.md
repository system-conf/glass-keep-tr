# Glass Keep

Keep tarzı not uygulaması - Markdown, yapılacaklar listesi, görseller, etiketler, renk temaları, karanlık mod, sürükle-bırak, içe/dışa aktarma, kimlik doğrulama, gerçek zamanlı işbirliği ve cam efektli UI. Vite + React + Turso (cloud SQLite) + StarkCDN görsel depolama.

---

## ✨ Özellikler

- **Kimlik Doğrulama & Çok Kullanıcı**
  - Kayıt, Giriş (kullanıcı adı + şifre), Çıkış
  - Rastgele oluşturulan admin şifresi (ilk kurulumda konsolda gösterilir)
  - Gizli kurtarma anahtarı indirme + Gizli Anahtar ile giriş
  - Her kullanıcı sadece kendi notlarını görür

- **Yapay Zeka Asistanı (Llama 3.2)**
  - Sunucu tarafında çalışan, tamamen özel AI
  - Notlarınızı okuyarak sorularınızı yanıtlar
  - Akıllı arama - notlarınız arasında anlam bazlı arama

- **Gerçek Zamanlı İşbirliği**
  - Çoklu kullanıcı aynı anda not düzenleyebilir
  - Kullanıcı adı/e-posta ile işbirlikçi ekleme/çıkarma
  - Otomatik çakışma çözümleme
  - Salt okunur mod desteği

- **Yönetim Paneli**
  - Kullanıcı oluşturma, düzenleme, silme
  - Yeni hesap oluşturmayı açma/kapama
  - Kullanıcı bazlı depolama ve not istatistikleri

- **Notlar**
  - Markdown destekli metin notları (H1-H3, bold, italic, code, link)
  - Yapılacaklar listesi (sürükle-bırak sıralama)
  - Çizim/notlar (serbest çizim, özelleştirilebilir fırça)
  - Akıllı Enter - listeleri otomatik devam ettirir
  - Biçimlendirme araç çubuğu

- **Görseller**
  - Çoklu görsel ekleme (istemci tarafı sıkıştırma)
  - StarkCDN bulut depolama
  - Tam ekran görüntüleyici (indirme, önceki/sonraki)

- **Organizasyon**
  - Sabitle / Sabitlemekten vazgeç
  - Etiket çipleri (virgülle ekleme, hızlı ekleme/çıkarma)
  - Etiket sidebar/drawer
  - Not bazlı renk temaları
  - Arama (başlık, markdown, etiketler, kontrol listesi, görsel adları)
  - Sürükle-bırak sıralama

- **Toplu İşlemler**
  - Çoklu seçim: İndir, Sabitle, Sil, Renk Değiştir

- **Veri**
  - JSON olarak dışa/içe aktarma
  - Google Keep'ten içe aktarma
  - Markdown dosyalarından içe aktarma
  - Not bazlı .md indirme

- **PWA** - Masaüstü ve mobilde kurulabilir

- **UI/Tema**
  - Tailwind v4 + glassmorphism tasarım
  - Karanlık/Aydınlık mod
  - Responsive tasarım

---

## 🧰 Gereksinimler

- **Node.js 20+** ve npm
- **Turso** hesabı (ücretsiz) - bulut veritabanı
- **StarkCDN** hesabı (opsiyonel) - görsel depolama

---

## 📦 Proje Yapısı

```
.
├─ public/                # PWA ikonları
├─ src/                   # React uygulaması
│  ├─ App.jsx            # Ana uygulama bileşeni
│  ├─ DrawingCanvas.jsx  # Çizim bileşeni
│  ├─ ai.js              # AI asistan modülü
│  └─ main.jsx           # Giriş noktası
├─ server/                # Express API
│  ├─ index.js           # Ana sunucu dosyası
│  ├─ db.js              # Turso veritabanı modülü
│  └─ cdn.js             # StarkCDN görsel modülü
├─ api/                   # Vercel serverless entry point
│  └─ index.js
├─ index.html
├─ vite.config.js
├─ vercel.json           # Vercel deploy yapılandırması
└─ package.json
```

---

## 🛠 Kurulum (Geliştirme)

### 1) Ortam Değişkenleri

```bash
cp .env.example .env
```

`.env` dosyasını düzenleyin:
```env
JWT_SECRET=uzun-rastgele-bir-string-yazin
TURSO_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
STARKCDN_API_KEY=your-starkcdn-api-key
STARKCDN_PROJECT_ID=1
```

### 2) Bağımlılıkları yükleyin

```bash
npm install
```

### 3) Çalıştırın

```bash
npm run dev
```

- Frontend (Vite): http://localhost:5173
- API: http://localhost:8080

### 4) Turso Veritabanı Kurulumu

1. [turso.tech](https://turso.tech) adresinden ücretsiz hesap oluşturun
2. Yeni bir veritabanı oluşturun
3. URL ve Auth Token'ı `.env` dosyasına ekleyin
4. Tablolar otomatik oluşturulur

---

## 🚀 Vercel Deploy

### 1) Vercel'de import edin
- [vercel.com](https://vercel.com) → New Project → `glass-keep-tr` reposunu seçin

### 2) Environment Variables ekleyin
```
JWT_SECRET=uzun-rastgele-string
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
STARKCDN_API_KEY=your-key
STARKCDN_PROJECT_ID=1
```

### 3) Deploy!
- Frontend statik olarak sunulur
- API serverless fonksiyon olarak çalışır

---

## 🐳 Docker Deploy

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
  -e STARKCDN_PROJECT_ID="1" \
  glass-keep
```

---

## 🧭 Yönetim Paneli

- **Erişim**: http://localhost:5173/#/admin (geliştirme) veya http://localhost:8080/#/admin (production)
- **Kimler erişebilir**: `is_admin = 1` olan kullanıcılar
- **İlk giriş**: Sunucu ilk başladığında konsolda admin şifresi gösterilir

---

## 🔐 Güvenlik

- JWT Secret zorunlu (hardcoded fallback yok)
- bcrypt ile şifre hashleme (async)
- Rate limiting: Auth endpoint'leri (20/15dk), AI endpoint'i (10/dk)
- DOMPurify ile XSS koruması (markdown rendering)
- Helmet.js security header'ları
- CORS allowlist (origin reflection yok)
- Görsel depolama StarkCDN üzerinden (base64 DB'de tutulmuyor)
- Input uzunluk validasyonu
- `is_admin` strict boolean kontrolü
- Güvenli ID üretimi (crypto.randomUUID)

---

## 📝 Lisans

MIT
