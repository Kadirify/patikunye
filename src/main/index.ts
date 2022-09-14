// Electron ana süreci: pencereyi hemen açar, veritabanı + API'yi başlatır (ilk açılışta adım adım),
// tepside çalışmaya devam eder, kapanışta veritabanını düzgün durdurur.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBackend } from './backend'
import { ElectronSecretStore } from './secrets-electron'
import { checkHost, discoverHosts, hello, normalizeHostUrl, pair, type ClientConfig } from './client'
import { certFingerprint } from './network'
import { createBackup } from './server/services/backup'
import electronUpdater from 'electron-updater'
import type { BackendStatus, SetupStep } from '../preload/api'

// Geliştirmede kullanıcı verisi, kurulu sürümle karışmasın
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'PatiKunye-dev'))

const dataRoot = join(app.getPath('userData'), 'data')
mkdirSync(dataRoot, { recursive: true })
const logFile = join(dataRoot, 'app.log')
const log = (m: string) => {
  const line = `${new Date().toISOString()} ${m}\n`
  appendFileSync(logFile, line)
  if (!app.isPackaged) process.stdout.write(line)
}

const devUrl = process.env.ELECTRON_RENDERER_URL
const resources = app.isPackaged ? process.resourcesPath : app.getAppPath()

let backend: Awaited<ReturnType<typeof startBackend>> | null = null
let starting: Promise<BackendStatus> | null = null
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const STEP_LABELS: Record<string, string> = {
  binaries: 'PostgreSQL dosyaları denetleniyor',
  port: 'Boş port seçiliyor',
  initdb: 'Veri klasörü oluşturuluyor',
  start: 'Veritabanı başlatılıyor',
  database: 'Uygulama veritabanı ve kullanıcısı hazırlanıyor',
  migrate: 'Tablolar oluşturuluyor',
  api: 'Uygulama sunucusu başlatılıyor',
  host: 'Ana bilgisayara bağlanılıyor',
}

/* İstemci modu yapılandırması (yerel ağdaki ana bilgisayara bağlı bilgisayar) — DPAPI ile şifreli */
const clientFile = join(dataRoot, 'client.bin')
async function loadClient(): Promise<ClientConfig | null> {
  if (!existsSync(clientFile)) return null
  const { result } = await safeStorage.decryptStringAsync(readFileSync(clientFile))
  return JSON.parse(result) as ClientConfig
}
async function saveClient(c: ClientConfig) {
  writeFileSync(clientFile, await safeStorage.encryptStringAsync(JSON.stringify(c)), { mode: 0o600 })
}
let clientCfg: ClientConfig | null = null
let clientHooksInstalled = false

const status: BackendStatus = {
  state: 'idle',
  firstRun: !existsSync(join(dataRoot, 'pgdata', 'PG_VERSION')) && !existsSync(clientFile),
  steps: [],
  dataRoot,
  logFile,
  mode: existsSync(clientFile) ? 'client' : 'host',
}

/** Ana bilgisayarın kendinden imzalı sertifikasına yalnızca sabitlenmiş parmak iziyle güven; cihaz anahtarını ekle */
function installClientHooks(cfg: ClientConfig) {
  const host = new URL(cfg.hostUrl).hostname
  const ses = session.defaultSession
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.hostname === host) return cb(certFingerprint(req.certificate.data) === clientCfg?.fingerprint ? 0 : -2)
    cb(-3) // varsayılan Chromium doğrulaması
  })
  if (clientHooksInstalled) return
  clientHooksInstalled = true
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    if (clientCfg && details.url.startsWith(clientCfg.hostUrl)) details.requestHeaders['X-Device-Token'] = clientCfg.deviceToken
    cb({ requestHeaders: details.requestHeaders })
  })
}

function publish() {
  win?.webContents.send('backend:status', status)
}

function setStep(key: string, state: SetupStep['state'], detail?: string) {
  let s = status.steps.find((x) => x.key === key)
  if (!s) {
    s = { key, label: STEP_LABELS[key] ?? key, state: 'pending' }
    status.steps.push(s)
  }
  const now = Date.now()
  if (state === 'start') (s as SetupStep & { t0?: number }).t0 = now
  else s.ms = now - ((s as SetupStep & { t0?: number }).t0 ?? now)
  s.state = state
  if (detail) s.detail = detail
  publish()
}

async function ensureBackend(): Promise<BackendStatus> {
  if (status.state === 'ready') return status
  if (starting) return starting
  status.state = 'starting'
  status.error = undefined
  status.steps = []
  publish()
  starting = (async () => {
    try {
      clientCfg = clientCfg ?? (await loadClient())
      if (clientCfg) {
        // İstemci: veritabanı yok; ana bilgisayara bağlan
        status.mode = 'client'
        status.client = { hostUrl: clientCfg.hostUrl, clinicName: clientCfg.clinicName, deviceName: clientCfg.deviceName }
        setStep('host', 'start')
        installClientHooks(clientCfg)
        await checkHost(clientCfg)
        setStep('host', 'done', clientCfg.hostUrl)
        status.apiBase = clientCfg.hostUrl
        status.state = 'ready'
        return status
      }
      backend = await startBackend({
        appVersion: app.getVersion(),
        dataRoot,
        migrationsFolder: join(resources, 'drizzle'),
        moduleMigrationsFolder: join(resources, 'migrations'),
        secrets: new ElectronSecretStore(join(dataRoot, 'secrets.bin')),
        allowedOrigins: devUrl ? [new URL(devUrl).origin, 'null', 'file://'] : ['null', 'file://'],
        log,
        onProgress: setStep,
      })
      setStep('api', 'done', backend.apiBase)
      setupUpdater()
      status.apiBase = backend.apiBase
      status.state = 'ready'
    } catch (e) {
      log(`[fatal] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      status.state = 'error'
      status.error = e instanceof Error ? e.message : String(e)
    } finally {
      starting = null
      publish()
    }
    return status
  })()
  return starting
}

function trayIcon() {
  // 16x16 pirinç renkli künye simgesi (BGRA)
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = x >= 2 && x <= 13 && y >= 1 && y <= 14 && !((x === 2 || x === 13) && (y === 1 || y === 14))
      const hole = (x - 7.5) ** 2 + (y - 4.5) ** 2 < 2.5
      if (inside && !hole) {
        buf[i] = 0x1a
        buf[i + 1] = 0x66
        buf[i + 2] = 0xa0
        buf[i + 3] = 0xff
      }
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('PatiKünye — hatırlatmalar ve otomatik yedek için çalışıyor')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'PatiKünye\'yi aç', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Çıkış', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => showWindow())
}

function showWindow() {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function webPrefs() {
  return {
    preload: join(__dirname, '../preload/index.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [`--pk-version=${app.getVersion()}`],
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    backgroundColor: '#ECEAE5',
    title: 'PatiKünye',
    show: false,
    webPreferences: webPrefs(),
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    // Kapat = tepsiye gizle (hatırlatmalar ve otomatik yedek çalışmaya devam eder)
    if (!quitting && tray && status.state === 'ready' && status.mode === 'host') {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Uygulamanın kendi sayfaları (yazdırma önizlemesi) ve ek dosya önizlemesi (blob:) yeni pencerede
    const own = url.startsWith('file://') || (devUrl && url.startsWith(devUrl)) || url.startsWith('blob:')
    if (own) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 900, height: 1000, autoHideMenuBar: true, title: 'PatiKünye', webPreferences: webPrefs() },
      }
    }
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file://')) e.preventDefault()
  })
  if (devUrl) await win.loadURL(devUrl)
  else await win.loadFile(join(__dirname, '../renderer/index.html'))
}

/* Otomatik güncelleme (S-113). Güncelleme sunucusu adresi verilmişse çalışır:
   ortam değişkeni PATIKUNYE_UPDATE_URL ya da kurulum klasöründeki update-url.txt */
type UpdState = { state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'; version?: string; error?: string; percent?: number }
let upd: UpdState = { state: 'disabled' }
function updateUrl(): string | null {
  if (process.env.PATIKUNYE_UPDATE_URL) return process.env.PATIKUNYE_UPDATE_URL
  const f = join(resources, 'update-url.txt')
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || null : null
}
function setupUpdater() {
  const url = updateUrl()
  if (!app.isPackaged || !url || status.mode !== 'host') return
  const { autoUpdater } = electronUpdater
  autoUpdater.setFeedURL({ provider: 'generic', url })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false // önce yedek alınacak
  const pub = (u: UpdState) => {
    upd = u
    win?.webContents.send('upd:status', upd)
  }
  autoUpdater.on('checking-for-update', () => pub({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => pub({ state: 'downloading', version: i.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => pub({ ...upd, state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-not-available', () => pub({ state: 'none' }))
  autoUpdater.on('update-downloaded', (i) => pub({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => pub({ state: 'error', error: e.message }))
  upd = { state: 'idle' }
  autoUpdater.checkForUpdates().catch(() => undefined)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => undefined), 6 * 3600_000)
}
ipcMain.handle('upd:status', () => upd)
ipcMain.handle('upd:check', async () => {
  if (upd.state === 'disabled') return upd
  await electronUpdater.autoUpdater.checkForUpdates().catch(() => undefined)
  return upd
})
ipcMain.handle('upd:install', async () => {
  if (upd.state !== 'ready' || !backend) return { ok: false, error: 'Kurulmaya hazır güncelleme yok.' }
  try {
    log('[update] güncelleme öncesi yedek alınıyor')
    await createBackup(backend.deps, 'pre_update')
  } catch (e) {
    return { ok: false, error: `Güncelleme öncesi yedek alınamadı, güncelleme yapılmadı: ${(e as Error).message}` }
  }
  quitting = true
  await backend.stop().catch(() => undefined)
  backend = null
  electronUpdater.autoUpdater.quitAndInstall(true, true)
  return { ok: true }
})

/* IPC */
ipcMain.handle('backend:status', () => status)
ipcMain.handle('backend:start', () => ensureBackend())
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggle-maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
ipcMain.on('win:close', () => win?.close())
ipcMain.on('sys:show-log', () => shell.showItemInFolder(logFile))

/* Yerel ağ — istemci eşleştirme (S-03) */
ipcMain.handle('net:discover', () => discoverHosts())
ipcMain.handle('net:hello', (_e, address: string) => hello(normalizeHostUrl(address)))
ipcMain.handle('net:pair', async (_e, input: { url: string; code: string; deviceName: string; fingerprint: string }) => {
  if (existsSync(join(dataRoot, 'pgdata', 'PG_VERSION'))) throw new Error('Bu bilgisayarda zaten bir veritabanı var; istemci yapılamaz.')
  const h = await hello(input.url)
  if (h.fingerprint !== input.fingerprint) throw new Error('Sertifika parmak izi değişti. Eşleştirmeyi baştan yapın.')
  const { deviceToken } = await pair(input.url, input.code, input.deviceName, input.fingerprint, app.getVersion())
  clientCfg = { hostUrl: input.url, fingerprint: input.fingerprint, deviceToken, deviceName: input.deviceName, clinicName: h.clinicName }
  await saveClient(clientCfg)
  status.firstRun = false
  status.mode = 'client'
  return ensureBackend()
})
ipcMain.handle('net:forget', async () => {
  if (existsSync(clientFile)) rmSync(clientFile)
  clientCfg = null
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('sys:choose-folder', async (_e, title?: string) => {
  const r = await dialog.showOpenDialog(win!, { title: title ?? 'Klasör seçin', properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('sys:bitlocker', async () => {
  // Yönetici yetkisi gerektirmeyen yöntem: Kabuk özelliği System.Volume.BitLockerProtection
  // 1 = açık, 2 = kapalı, 3 = şifreleniyor, 5 = açılıyor (Windows sürümüne göre) ⚠️ doğrulanacak
  if (process.platform !== 'win32') return 'unknown'
  const drive = (process.env.SystemDrive ?? 'C:').replace(/\\$/, '')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Shell.Application).NameSpace('${drive}').Self.ExtendedProperty('System.Volume.BitLockerProtection')`],
      { windowsHide: true, timeout: 8000 },
      (err, out) => {
        const v = Number(String(out).trim())
        if (err || Number.isNaN(v)) return resolve('unknown')
        resolve(v === 1 || v === 3 || v === 5 ? 'on' : v === 2 ? 'off' : 'unknown')
      },
    )
  })
})

ipcMain.handle('sys:diagnostics', async () => {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Tanı paketini kaydet',
    defaultPath: join(app.getPath('desktop'), `PatiKunye-tani-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (r.canceled || !r.filePath) return null
  const tail = (f: string, n: number) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').slice(-n).join('\n') : '')
  const pgdata = join(dataRoot, 'pgdata')
  // Kişisel veri içermez: sürümler, durum, log kuyrukları, klasör boyutları
  const diag = {
    createdAt: new Date().toISOString(),
    app: app.getVersion(),
    electron: process.versions.electron,
    os: `${process.platform} ${process.getSystemVersion()}`,
    status: { ...status, apiBase: undefined },
    dataRootFiles: existsSync(dataRoot) ? readdirSync(dataRoot).map((f) => ({ f, size: statSync(join(dataRoot, f)).size })) : [],
    pgdataExists: existsSync(pgdata),
    appLog: tail(logFile, 300),
    postgresLog: tail(join(dataRoot, 'postgres.log'), 500),
  }
  writeFileSync(r.filePath, JSON.stringify(diag, null, 2))
  return r.filePath
})

/* Yaşam döngüsü */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    createTray()
    await createWindow()
    // İlk açılışta veritabanı kurulumu sihirbazdan başlatılır; sonraki açılışlarda hemen
    if (!status.firstRun) ensureBackend()
  })
}

app.on('before-quit', async (e) => {
  if (quitting) return
  quitting = true
  if (!backend) return
  e.preventDefault()
  try {
    await backend.stop()
  } catch (err) {
    log(`[stop] ${String(err)}`)
  }
  app.exit(0)
})

app.on('window-all-closed', () => {
  // Tepside kalır; tepsi yoksa çık
  if (!tray) app.quit()
})
