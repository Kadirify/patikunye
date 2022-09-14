// Yerel PostgreSQL kümesini yönetir: ilk kurulum (initdb), başlatma, düzgün durdurma.
// Geliştirmede @embedded-postgres binary'leri kullanılır; satış sürümünde aynı adımlar
// "PatiKunye-DB" Windows servisiyle (pg_ctl register) yapılacak.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)

/**
 * pg_ctl start, postgres sürecini başlatıp çıkar; ama postgres çıktı borularını devralır.
 * Boru bağlanırsa execFile hiç dönmez (Windows). Bu yüzden stdio bağlamadan çalıştırılır.
 */
function runNoPipes(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    p.once('error', reject)
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} çıkış kodu ${code}`))))
  })
}

export interface DbSecrets {
  port: number
  superPassword: string
  appPassword: string
  /** TCKN şifreleme (AES-256-GCM) ve arama (HMAC) anahtarları, base64 */
  dataKey: string
  hashKey: string
}

export interface SecretStore {
  load(): DbSecrets | null | Promise<DbSecrets | null>
  save(s: DbSecrets): void | Promise<void>
}

export interface PgBinaries {
  initdb: string
  pg_ctl: string
}

export interface SupervisorOptions {
  dataDir: string
  logFile: string
  secrets: SecretStore
  log?: (msg: string) => void
  /** Kurulum sihirbazına adım bildirimi: binaries | initdb | port | start | database */
  onProgress?: (step: string, state: 'start' | 'done' | 'error', detail?: string) => void
  /** Paylaşımlı bellek (varsayılan 256MB; testlerde küçük tutulur) */
  sharedBuffers?: string
}

export const APP_DB = 'patikunye'
export const APP_ROLE = 'patikunye_app'
export const DEFAULT_PORT = 54329

/** Platforma göre PostgreSQL binary paketi (package.json'da optionalDependencies) */
export function binaryPackage(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32' && arch === 'x64') return '@embedded-postgres/windows-x64'
  if (platform === 'darwin' && arch === 'arm64') return '@embedded-postgres/darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@embedded-postgres/darwin-x64'
  if (platform === 'linux' && arch === 'x64') return '@embedded-postgres/linux-x64'
  throw new Error(`Bu platform desteklenmiyor: ${platform} ${arch}`)
}

async function loadBinaries(): Promise<PgBinaries> {
  const pkg = binaryPackage()
  let mod: PgBinaries
  try {
    // Değişken yol: paketleyici bunu gömmesin, çalışma anında platformun paketi yüklensin
    mod = (await import(/* @vite-ignore */ pkg)) as unknown as PgBinaries
  } catch (e) {
    throw new Error(`PostgreSQL paketi yüklenemedi (${pkg}). "npm install" çalıştırın.`, { cause: e })
  }
  // Paketlenmiş uygulamada binary'ler app.asar dışına açılır (asarUnpack); yol oraya çevrilir
  const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const bins = { initdb: unpacked(mod.initdb), pg_ctl: unpacked(mod.pg_ctl) }
  if (!existsSync(bins.pg_ctl)) throw new Error(`PostgreSQL dosyaları bulunamadı: ${bins.pg_ctl}`)
  if (process.platform !== 'win32') {
    // macOS/Linux: npm paketinden gelen dosyalarda çalıştırma izni eksik olabilir
    for (const f of [bins.initdb, bins.pg_ctl, join(dirname(bins.pg_ctl), 'postgres')]) {
      try {
        chmodSync(f, 0o755)
      } catch {
        /* zaten çalıştırılabilir ya da salt okunur */
      }
    }
  }
  return bins
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/** Önce istenen port; doluysa aralıktan rastgele (aynı anda başlayan kümeler çakışmasın diye) */
async function findPort(start: number): Promise<number> {
  if (await isPortFree(start)) return start
  for (let i = 0; i < 60; i++) {
    const p = start + 1 + Math.floor(Math.random() * 400)
    if (await isPortFree(p)) return p
  }
  throw new Error('Veritabanı için boş port bulunamadı.')
}

const newSecret = () => randomBytes(24).toString('base64url')

export class DbSupervisor {
  private bins?: PgBinaries
  private secrets?: DbSecrets
  constructor(private opts: SupervisorOptions) {}

  private log(msg: string) {
    this.opts.log?.(`[db] ${msg}`)
  }

  get isInitialised() {
    return existsSync(join(this.opts.dataDir, 'PG_VERSION'))
  }

  /** Kümeyi gerekirse oluşturur, başlatır, uygulama rolü ve veritabanını hazırlar. */
  private async step<T>(name: string, fn: () => Promise<T>, detail?: () => string | undefined): Promise<T> {
    this.opts.onProgress?.(name, 'start')
    try {
      const r = await fn()
      this.opts.onProgress?.(name, 'done', detail?.())
      return r
    } catch (e) {
      this.opts.onProgress?.(name, 'error', e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  async start(): Promise<{ connectionString: string; secrets: DbSecrets }> {
    this.bins = await this.step('binaries', loadBinaries, () => 'PostgreSQL 18')
    let secrets = await this.opts.secrets.load()

    if (!this.isInitialised) {
      const port = await this.step('port', () => findPort(DEFAULT_PORT), () => undefined)
      secrets = {
        port,
        superPassword: newSecret(),
        appPassword: newSecret(),
        dataKey: randomBytes(32).toString('base64'),
        hashKey: randomBytes(32).toString('base64'),
      }
      await this.step('initdb', () => this.initCluster(secrets!), () => this.opts.dataDir)
      await this.opts.secrets.save(secrets)
    }
    if (!secrets) throw new Error('Veritabanı anahtarları bulunamadı. Kurtarma koduyla geri yükleme gerekli.')
    this.secrets = secrets

    await this.step('start', () => this.startServer(), () => `port ${this.secrets!.port}`)
    await this.step('database', () => this.ensureAppDatabase())
    return {
      connectionString: `postgres://${APP_ROLE}:${encodeURIComponent(secrets.appPassword)}@127.0.0.1:${secrets.port}/${APP_DB}`,
      secrets,
    }
  }

  private async initCluster(s: DbSecrets) {
    const { dataDir } = this.opts
    mkdirSync(dataDir, { recursive: true })
    const pwFile = join(dataDir, '..', `.pw-${process.pid}`)
    writeFileSync(pwFile, s.superPassword, { mode: 0o600 })
    this.log(`initdb → ${dataDir}`)
    try {
      const base = ['-D', dataDir, '-U', 'postgres', `--pwfile=${pwFile}`, '--auth=scram-sha-256', '--encoding=UTF8']
      try {
        // Türkçe sıralama ve büyük/küçük harf (İ/ı) için ICU
        await run(this.bins!.initdb, [...base, '--locale-provider=icu', '--icu-locale=tr-TR', '--locale=C'])
      } catch (e) {
        // ICU'suz derlenmiş binary'ler (bazı macOS/Linux paketleri): düz C yerel ayarıyla kur
        this.log(`ICU ile kurulamadı, C yerel ayarıyla deneniyor: ${(e as Error).message.split('\n')[0]}`)
        rmSync(dataDir, { recursive: true, force: true })
        mkdirSync(dataDir, { recursive: true })
        await run(this.bins!.initdb, [...base, '--locale=C'])
      }
    } finally {
      rmSync(pwFile, { force: true })
    }
    appendFileSync(
      join(dataDir, 'postgresql.conf'),
      [
        '',
        '# PatiKünye',
        "listen_addresses = '127.0.0.1'",
        `port = ${s.port}`,
        'max_connections = 30',
        `shared_buffers = ${this.opts.sharedBuffers ?? '256MB'}`,
        'log_min_duration_statement = 500',
        "timezone = 'Europe/Istanbul'",
        '',
      ].join('\n'),
    )
  }

  private async status(): Promise<boolean> {
    try {
      await run(this.bins!.pg_ctl, ['status', '-D', this.opts.dataDir])
      return true
    } catch {
      return false
    }
  }

  private async startServer() {
    if (await this.status()) {
      this.log('zaten çalışıyor')
      return
    }
    // Windows portu başka programa ya da ayrılmış bir aralığa vermiş olabilir
    if (!(await isPortFree(this.secrets!.port))) await this.relocatePort('port dolu')
    // Port bağlama hatasında (geçici "Permission denied" ya da aynı anda başka küme) başka portla yeniden dene
    for (let attempt = 0; ; attempt++) {
      const logSize = this.logSize()
      try {
        await this.pgStart()
        return
      } catch (e) {
        if (attempt >= 3 || !this.logMentionsBindErrorSince(logSize)) throw this.startError(e)
        await this.relocatePort('port açılamadı')
      }
    }
  }

  private logSize(): number {
    try {
      return statSync(this.opts.logFile).size
    } catch {
      return 0
    }
  }

  private async pgStart() {
    this.log(`başlatılıyor (port ${this.secrets!.port})`)
    await runNoPipes(this.bins!.pg_ctl, ['start', '-D', this.opts.dataDir, '-l', this.opts.logFile, '-w', '-t', '60'])
  }

  private startError(cause: unknown) {
    return new Error(`Veritabanı başlatılamadı. Ayrıntı: ${this.opts.logFile}`, { cause })
  }

  /** Bu başlatma denemesinden sonra loga yazılanlarda bağlama hatası var mı */
  private logMentionsBindErrorSince(offset: number): boolean {
    try {
      const tail = readFileSync(this.opts.logFile, 'utf8').slice(offset)
      return /could not (bind|create any TCP\/IP sockets)|Address already in use/.test(tail)
    } catch {
      return false
    }
  }

  /** Yeni boş port seçer; postgresql.conf'a yazar (sondaki satır geçerlidir) ve anahtar deposunu günceller. */
  private async relocatePort(reason: string) {
    const s = this.secrets!
    const port = await findPort(s.port + 1)
    this.log(`${reason} (${s.port}), yeni port ${port}`)
    appendFileSync(join(this.opts.dataDir, 'postgresql.conf'), `\nport = ${port}\n`)
    s.port = port
    await this.opts.secrets.save(s)
  }

  private async ensureAppDatabase() {
    const s = this.secrets!
    const admin = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'postgres', password: s.superPassword, database: 'postgres' })
    await admin.connect()
    try {
      const role = await admin.query('select 1 from pg_roles where rolname = $1', [APP_ROLE])
      if (role.rowCount === 0) {
        // Parola rastgele üretildiği için yalnızca güvenli karakterler içerir (base64url)
        await admin.query(`create role ${APP_ROLE} login password '${s.appPassword}'`)
      }
      const db = await admin.query('select 1 from pg_database where datname = $1', [APP_DB])
      if (db.rowCount === 0) await admin.query(`create database ${APP_DB} owner ${APP_ROLE}`)
    } finally {
      await admin.end()
    }
    // Eklentiler süper kullanıcıyla, uygulama veritabanında
    const ext = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'postgres', password: s.superPassword, database: APP_DB })
    await ext.connect()
    try {
      await ext.query('create extension if not exists pgcrypto')
      await ext.query('create extension if not exists pg_trgm')
      await ext.query('create extension if not exists unaccent')
    } finally {
      await ext.end()
    }
  }

  async stop() {
    if (!this.bins) return
    if (!(await this.status())) return
    this.log('durduruluyor')
    await run(this.bins.pg_ctl, ['stop', '-D', this.opts.dataDir, '-m', 'fast', '-w', '-t', '30'], { windowsHide: true })
  }
}
