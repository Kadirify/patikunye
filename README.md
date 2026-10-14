# PatiKunye

Veteriner klinikleri icin mikrocip, hayvan kaydi ve PETVET takip programi (Windows).

Kedi ve kopeklere mikrocip zorunlu hale gelince kliniklerde ayni bilgi iki kere girilmeye basladi: bir kere klinik programina, bir kere PETVET'e. PatiKunye bu iki isi tek ekranda toplamak icin yazildi. Cip okutulur, hayvan ve sahibi bulunur ya da birkac alanla kaydedilir; PETVET'e girilmesi gereken her sey 15 gunluk suresiyle birlikte is listesine duser.

Program internet gerektirmez. Veritabani (PostgreSQL) programla birlikte gelir, ayrica bir sey kurmaniz gerekmez.

Bu program su anda 3-4 veteriner klinikte aktif olarak kullaniliyor. Kaynak kodu herkese acik paylasiyorum; inceleyebilir, ornek alabilir veya kendi kliniginiz icin uyarlayabilirsiniz. Ticari olarak da kullanabilir veya satabilirsiniz.

**[Son surumu indir (Windows, .exe)](https://github.com/Kadirify/patikunye/releases/latest)**

![Bugun ekrani](docs/tanitim/img/02-bugun.png)

## Kurulum

Windows 10 veya 11 (64 bit), yaklasik 500 MB bos alan. USB barkod/cip okuyucu varsa takili olsun, yoksa cip numarasi elle de yazilabilir.

1. [Releases](https://github.com/Kadirify/patikunye/releases/latest) sayfasindan `PatiKunye-Kurulum-0.1.0.exe` dosyasini indirin.
2. Dosyayi calistirin. Kurulum dosyasi imzali olmadigi icin Windows uyari verebilir: **Ek bilgi -> Yine de calistir** ile devam edin.
3. Programin kimler icin kurulacagini secin. Tek bilgisayarli klinikte **Sadece benim icin** yeterli.

Kaldirmak icin: **Ayarlar -> Uygulamalar -> PatiKunye -> Kaldir**. Kaldirma klinik verilerini silmez.

## Ilk acilis

Program ilk acildiginda kurulum sihirbazi cikar: klinik bilgileri, yonetici hekim, kurtarma kodu, yedekleme ayari, disk sifreleme kontrolu, cip okuyucu testi ve mesajlasma ayarlari. Bircogu birkac saniye surer.

Kurtarma kodu (12 kelime) bir kez gosterilir - kagida yazip bilgisayardan ayri saklayin. Yedekleri baska bilgisayarda acmak ve yonetici parolasi unutuldugunda girmek icin bu kod gerekir.

## Ne yapar?

- **Cip ve kayit:** USB okuyucuyla her ekrandan cip yakalama, cip dogrulama, hizli kayit, kampanya gunleri icin seri kayit
- **Sahipler ve hayvanlar:** Sahip/hayvan kartlari, mukerrer sahip birlestirme, olum, kayip, bulundu ve sahip degisikligi islemleri
- **Muayene:** SOAP, otomatik taslak, imza ve ek surumler, tedavi satirlari, alerji uyarisi, kilo takibi
- **Asilar:** Asi uygulama, protokoller, asi takvimi, kuduz asisinda PETVET gorevi
- **PETVET:** 15 gun kuralina gore is listesi, TARBIL'e kopyalanacak alanlar, eksik TCKN takibi
- **Randevu:** Hekim sutunlu takvim, surukle-birak, bekleme salonu, randevu turleri ve tatil gunleri
- **Mesajlar:** Asi ve randevu hatirlatmalari (SMS: Netgsm, Iletimerkezi; e-posta), sablonlar, sessiz saatler
- **Yonetim:** Kullanicilar ve roller, PIN ile hizli giris, kilit ekrani, KVKK talepleri ve anonimlesitirme, degistirilemez denetim kaydi
- **Yedekleme:** Kurtarma koduyla sifreli gunluk yedek, dogrulama, baska bilgisayara geri yukleme
- **Raporlar:** Raporlar ve CSV disa aktarma, asi karnesi, cip karti, muayene ozeti, onam formu

## Ekranlar

![Hizli kayit](docs/tanitim/img/03-hizli-kayit.png)

![Hayvan karti](docs/tanitim/img/05-hayvan-detay.png)

![PETVET isleri](docs/tanitim/img/08-petvet.png)

![Randevular](docs/tanitim/img/14-randevular.png)

## Veriler nerede durur?

- **Veritabani ve ayarlar:** `%APPDATA%\PatiKunye\data`
- **Yedekler:** Kurulumda secilen klasor

Veritabani yalnizca bu bilgisayardan erisilebilir (`127.0.0.1`). Agdaki diger bilgisayarlar veritabanina degil, programin kendi sunucusuna HTTPS ile baglanir.

TCKN gibi hassas alanlar veritabaninda sifreli tutulur. Yedekler kurtarma koduyla sifrelenir; kod olmadan acilamaz.

## Gelistirme

```bash
npm install
npm run dev          # Electron, ilk acilista kurulum sihirbazi
```

Arayuz uzerinde tarayicidan calismak icin iki terminal:

```bash
npm run dev:server   # veritabani (.dev-data) + API, port 47800
npm run dev:web      # arayuz, http://localhost:5173
```

```bash
npm test
npm run typecheck
npm run dist         # kurulum dosyasi: dist/PatiKunye-Kurulum-<surum>.exe
```

Ornek veri basmak icin (gelistirme veritabanina):

```bash
npx tsx scripts/seed-demo.ts --dev
npx tsx scripts/seed-history.ts --dev
```

Kullanilanlar: Electron, React, Fastify, Drizzle ORM, PostgreSQL (embedded-postgres), electron-builder.

## Bilinen eksikler

- Kurulum dosyasi imzasiz, Windows ilk calistirmada uyari veriyor.
- PostgreSQL programin alt sureci olarak calisiyor; program sistem tepsisinde acik kaldigi surece veritabani da acik.
- Guncelleme sunucusu yok.
- SMS saglayicilari gercek hesapla denenmedi.
- Asi protokolleri, tani listesi ve KVKK metinleri ornek olarak konuldu; kullanmadan once kendi kliniginize gore duzenleyin.

Hata bulursaniz ya da oneriniz varsa Issues'a yazabilirsiniz.
