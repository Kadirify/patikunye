# PatiKünye

Veteriner klinikleri için mikroçip, hayvan ve PETVET takip uygulaması. Windows masaüstü (Electron); veriler klinik bilgisayarında, uygulamayla gelen yerel PostgreSQL 18'de durur. Birden çok bilgisayar yerel ağdan ana bilgisayara bağlanabilir.

Plan ve ekran tanımları: `docs/plan/PLAN.md`, `docs/plan/SAYFALAR.md`, onaylı tasarımlar `docs/plan/tasarim/`. Modül geliştirme kuralları: `docs/MODUL-REHBERI.md`.

## Çalıştırma

```bash
npm install
npm run dev          # Electron uygulaması (ilk açılışta kurulum sihirbazı)
```

Arayüzü tarayıcıda geliştirmek için iki terminal:

```bash
npm run dev:server   # veritabanı (.dev-data) + API, port 47800
npm run dev:web      # arayüz, http://localhost:5173
```

```bash
npm test             # 196 test (her test dosyası kendi geçici PostgreSQL kümesini kurar)
npm run typecheck
npm run dist         # Windows kurulum dosyası → dist/PatiKunye-Kurulum-<sürüm>.exe
npm run dist:dir     # kurulum dosyası olmadan paket → dist/win-unpacked
```

## Modüller

| Modül | Ekranlar | Test |
|---|---|---|
| Kurulum ve sistem | 11 adımlı kurulum sihirbazı (adım adım veritabanı kurulumu), başlatma/hata ekranı, kilit ekranı, komut paleti (Ctrl+K), bildirim merkezi, klavye kısayolları | – |
| Çip ve hızlı kayıt | Global çip yakalama (USB okuyucu), çip paneli, hızlı kayıt, kampanya modu | api, shared, chipCapture |
| Sahipler ve hayvanlar | Sahip liste/form/detay/birleştirme, hayvan liste/form/detay (10 sekme), ölüm/kayıp/bulundu/devir, çip uygula/düzelt | owners |
| Muayene | SOAP editörü, otomatik taslak, imza + ek/düzeltme sürümleri, tedavi satırları, alerji uyarısı, kilo | visits |
| Aşılar | Aşı uygula, protokoller, aşı takvimi, Bugün paneli, kuduz → PETVET görevi | vaccines |
| PETVET | İş listesi, görev detayı (TARBİL'e kopyalanacak alanlar), eksik TCKN akışı | api |
| Randevu | Hekim sütunlu takvim, sürükle-bırak, bekleme salonu (kanban), randevu türleri ve tatiller | appointments |
| Mesajlar | Hatırlatma kuyruğu, SMS (Netgsm, İletimerkezi) / e-posta, şablonlar, sessiz saatler, tekrar deneme | messaging |
| Ayarlar, KVKK, denetim | Klinik, kullanıcılar, PIN girişi, sözlükler, okuyucu testi, PETVET ayarları, KVKK talepleri ve anonimleştirme, denetim kaydı ve zincir doğrulama | admin |
| Yedekleme | Şifreli günlük yedek (.pkb), doğrulama, başka bilgisayara geri yükleme, veritabanı durumu | backup |
| Raporlar ve yazdırma | 9 rapor + CSV, aşı karnesi, çip kartı (Code128), muayene özeti, onam formu, denetim paketi | reports |
| Yerel ağ | Ana bilgisayar HTTPS dinleyicisi, eşleştirme kodu, sertifika sabitleme, cihaz yönetimi | network |
| Güncelleme | Güncelleme sunucusu tanımlıysa otomatik indirme, kurulumdan önce zorunlu yedek | – |

## Veriler nerede?

| Ortam | Veri klasörü | Anahtarlar |
|---|---|---|
| Kurulu uygulama | `%APPDATA%\PatiKünye\data` | `secrets.bin` (Windows DPAPI ile şifreli) |
| `npm run dev` | `%APPDATA%\PatiKunye-dev\data` | `secrets.bin` |
| `npm run dev:server` | `./.dev-data` | `secrets.json` (düz metin, yalnızca geliştirme) |

- PostgreSQL yalnızca `127.0.0.1`'i dinler; ağdaki bilgisayarlar yalnızca uygulama sunucusuna (HTTPS, cihaz anahtarı) bağlanır.
- TCKN ve diğer hassas alanlar AES-256-GCM ile şifreli; ek dosyalar şifreli dosya olarak saklanır.
- Yedekler kurtarma koduyla şifrelenir ve farklı bilgisayara geri yüklenebilir (anahtarlar yeniden şifrelenir).

## Bilinen sınırlamalar / yapılacaklar

- **Kod imzalama sertifikası yok:** kurulum dosyası imzasız; Windows SmartScreen "bilinmeyen yayıncı" uyarısı verir.
- **PostgreSQL Windows servisi değil:** uygulamanın alt süreci olarak çalışır; uygulama tepside açık kaldığı sürece çalışır.
- **Güncelleme sunucusu yok:** güncelleme için `PATIKUNYE_UPDATE_URL` ya da kurulum klasörüne `update-url.txt`.
- **SMS sağlayıcı API'leri gerçek hesapla denenmedi** (kodda ⚠️ işaretli).
- **Mevzuat ve tohum veriler (aşı protokolleri, tanılar, KVKK metinleri) örnektir;** hekim ve hukukçu onayı gerekir.
- Ayrıntılar: her modülün kod yorumlarında "⚠️ doğrulanacak" notları.
