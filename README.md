# DropFile - Geçici Dosya Paylaşım Platformu

![DropFile Arayüzü](public/preview.png)

DropFile, dosyalarınızı hızlı, güvenli ve geçici olarak paylaşmanızı sağlayan, modern tasarıma sahip bir web uygulamasıdır. Dosyalar tarayıcıdan yerel DropFile sunucusuna yüklenir; sunucu bunları **AES-256-GCM** ile şifreleyip [tmpfiles.org](https://tmpfiles.org) altyapısına iletir. DropFile sunucusunda dosyalar kalıcı olarak tutulmaz; yalnızca şifreleme anahtarı/IV meta verisi saklanır. İndirme sırasında şifreli blob sunucudan çekilir ve çözülerek istemciye iletilir.

## Özellikler

- 🔒 **Sunucu Tarafında Şifreleme:** Dosyalar AES-256-GCM ile uçtan uca şifrelenir; tmpfiles.org yalnızca şifreli kopyayı tutar, anahtar DropFile meta verisinde kalır.
- 📦 **Çoklu Dosya Yükleme:** Birden fazla dosyayı tek seferde sürükleyip bırakabilir veya seçebilirsiniz; her dosya için ayrı ayrı doğrudan ve önizleme linkleri üretilir.
- 📱 **Mobil Uyumlu Modern Arayüz:** Karanlık tema (Dark Mode) ve glassmorphism detaylarıyla premium bir kullanıcı deneyimi sunar.
- ⚡ **Minimal Bağımlılık:** Arka plandaki Node.js sunucusu yerleşik modüller (`http`, `fs`, `crypto`) ve multipart ayrıştırma için `busboy` paketi ile çalışır.
- ⏱️ **Özelleştirilebilir Saklama Süresi:** Dosyalarınızın 1 saatten 48 saate kadar ne kadar süreyle saklanacağını seçebilirsiniz.
- 🔗 **Doğrudan İndirme & Önizleme:** Yükleme tamamlandığında hem doğrudan indirme linki hem de dosya detaylarını gösteren bir önizleme sayfası linki sağlar.
- 📷 **QR Kod Üretimi:** Tek dosya yüklemelerinde, mobil cihazlardan hızlı erişim için anında QR kod oluşturur.

## Kurulum ve Çalıştırma

Proje, çok hafif bir `node:alpine` Docker imajı üzerinde çalışacak şekilde yapılandırılmıştır.

### Gereksinimler
- Docker
- Docker Compose

### Adımlar

1. Proje dizininde bir terminal açın.
2. Aşağıdaki komut ile Docker konteynerini derleyip arka planda başlatın:
   ```bash
   docker compose up --build -d
   ```
3. Tarayıcınızda [http://localhost:9392](http://localhost:9392) adresine giderek uygulamayı kullanmaya başlayabilirsiniz.
   *(Eğer sunucu üzerinde çalıştırıyorsanız sunucunuzun IP adresini ve 9392 portunu kullanın).*

Alternatif olarak Docker olmadan doğrudan Node.js ile de çalıştırabilirsiniz:

```bash
npm install
node server.js
```

## Proje Yapısı

```text
.
├── Dockerfile             # Node.js Alpine tabanlı çok hafif imaj yapılandırması
├── docker-compose.yml     # Konteyneri 9392 portu ile dışa açan yapılandırma
├── package.json           # npm bağımlılıkları (busboy)
├── server.js              # HTTP sunucusu: AES-256-GCM şifreleme, tmpfiles.org yükleme,
│                          # /d/:id indirme, /f/:id önizleme, statik dosya servisi, TTL cleanup
├── data/                  # Şifreleme anahtarı/IV meta verisi (kalıcı, .gitignore'da)
└── public/                # İstemci tarafı (Frontend) dosyaları
    ├── index.html         # Ana sayfa ve sayfa iskeleti
    ├── preview.png        # Sosyal paylaşımlar (Open Graph) için görsel
    ├── favicon.svg        # Marka ikonu (Geometrik "D" Logosu)
    ├── css/style.css      # Özelleştirilmiş dark-theme arayüz tasarımları
    └── js/app.js          # Çoklu dosya yükleme, ilerleme takibi, toast bildirimleri, QR kod
```

## Güvenlik Altyapısı

- **AES-256-GCM şifreleme:** Dosyalar sunucuda şifrelenir; anahtar/IV meta verisi `data/` dizininde saklanır, süresi dolduğunda kalıcı olarak silinir.
- **Dizin dışına çıkma (Directory Traversal) koruması:** Statik dosya servisinde özel yol normalizasyonu sağlanmıştır.
- **Güçlü HTTP header'ları:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` ve HTML yanıtları için `Content-Security-Policy` tanımlanmıştır.
- **Content-Disposition güvenliği:** İndirme başlığında CRLF enjeksiyonu engellenmiş, UTF-8 dosya adları RFC 5987 (`filename*`) ile iletilir.
- **Tedarik zinciri (supply chain):** CDN script'leri (Lucide, QRious) sabit sürüme sabitlenmiş ve `crossorigin="anonymous"` ile yüklenir.
- Tek npm bağımlılığı `busboy`'dur (multipart form ayrıştırma). Şifreleme için yerleşik `crypto` modülü kullanılır.

## Yasal Uyarı / Bilgilendirme

Bu proje yüklenen dosyaları şifreli olarak [tmpfiles.org](https://tmpfiles.org) genel hizmeti üzerinde geçici olarak barındırır. Kişisel ve hassas verileri yüklemeden önce bu durumu ve ilgili platformun kullanım koşullarını göz önünde bulundurunuz.