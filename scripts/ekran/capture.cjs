// Tanıtım ekran görüntüleri (docs/tanitim/img). Önce: npx tsx scripts/shots-server.ts <token-dosyası> ve npx vite --config vite.web.config.ts
// Sonra: SHOT_TOKEN=<token-dosyası> SHOT_IDS=<ids.json> SHOT_OUT=docs/tanitim/img npx electron scripts/ekran/capture.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { SHOT_TOKEN: tokenFile, SHOT_IDS: idsFile, SHOT_OUT: outDir, SHOT_ONLY: only } = process.env
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'))
const shots = [
  ['01-giris', null],
  ['02-bugun', ''],
  ['03-hizli-kayit', 'kayit'],
  ['04-hayvanlar', 'hayvanlar'],
  ['05-hayvan-detay', `hayvanlar/${ids.animal}`],
  ['06-sahipler', 'sahipler'],
  ['07-sahip-detay', `sahipler/${ids.owner}`],
  ['08-petvet', 'petvet'],
  ['09-petvet-gorev', `petvet/${ids.task}`],
  ['10-muayeneler', 'muayeneler'],
  ['11-muayene', `muayene/${ids.visit}`],
  ['12-asi-takvimi', 'asilar'],
  ['13-asi-uygula', `asilar/uygula?animal=${ids.animal}`],
  ['14-randevular', 'randevular'],
  ['15-bekleme', 'bekleme'],
  ['16-mesajlar', 'mesajlar'],
  ['17-raporlar', 'raporlar'],
  ['18-yedekleme', 'ayarlar/yedekleme'],
  ['19-ayar-klinik', 'ayarlar/klinik'],
  ['20-ayar-kullanicilar', 'ayarlar/kullanicilar'],
  ['21-ayar-roller', 'ayarlar/roller'],
  ['22-ayar-sozlukler', 'ayarlar/sozlukler'],
  ['23-ayar-okuyucu', 'ayarlar/okuyucu'],
  ['24-ayar-petvet', 'ayarlar/petvet'],
  ['25-ayar-randevu', 'ayarlar/randevu'],
  ['26-ayar-asilar', 'ayarlar/asilar'],
  ['27-ayar-mesajlasma', 'ayarlar/mesajlasma'],
  ['28-ayar-sablonlar', 'ayarlar/sablonlar'],
  ['29-kvkk', 'ayarlar/kvkk'],
  ['30-denetim', 'ayarlar/denetim'],
  ['31-ayar-veritabani', 'ayarlar/veritabani'],
  ['32-ayar-ag', 'ayarlar/ag'],
  ['33-yazdir-asi-karnesi', `yazdir/vaccine-card/${ids.animal}`],
  ['34-yazdir-cip-karti', `yazdir/chip-card/${ids.animal}`],
  ['35-yazdir-muayene', `yazdir/visit/${ids.visit}`],
  ['36-yazdir-recete', `yazdir/prescription/${ids.visit}`],
]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false, contextIsolation: false, sandbox: false, preload: require('path').join(__dirname, 'stub-preload.cjs') } })
  const base = 'http://localhost:5173/'
  for (const [name, route] of shots) {
    if (only && !name.includes(only)) continue
    if (route === null) {
      await win.loadURL(base)
      await win.webContents.executeJavaScript(`sessionStorage.removeItem('pk.token')`)
      await win.loadURL(base)
    } else {
      if (!win.webContents.getURL().startsWith(base)) await win.loadURL(base)
      await win.webContents.executeJavaScript(`sessionStorage.setItem('pk.token', ${JSON.stringify(token)})`)
      await win.loadURL('about:blank')
      await win.loadURL(base + '#/' + route)
    }
    await wait(route && route.startsWith('yazdir') ? 3500 : 2500)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG())
    console.log('ok', name, img.getSize().width + 'x' + img.getSize().height)
  }
  app.quit()
})
