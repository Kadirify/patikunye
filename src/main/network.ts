// Yerel ağ modu - ana bilgisayar tarafı.
// Yerel arayüz 127.0.0.1'deki API'yi kullanır. Ağdaki diğer bilgisayarlar için ayrı bir HTTPS dinleyici açılır:
// kendinden imzalı sertifika (istemci parmak izini sabitler) + eşleştirme kodu + cihaz anahtarı.
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces, hostname } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { generate } from 'selfsigned'
import { Bonjour, type Service } from 'bonjour-service'
import { buildServer } from './server/app'
import type { SessionStore } from './server/routes/auth'
import type { AppDeps } from './server/context'
import { getSettings, updateSettings } from './server/settings'

export const DEFAULT_LAN_PORT = 47900
const PAIR_CODE_TTL_MS = 5 * 60_000

export interface NetworkStatus {
  enabled: boolean
  running: boolean
  port: number
  addresses: string[]
  fingerprint: string | null
  error?: string
}

export interface PairingCode {
  code: string
  expiresAt: string
  fingerprint: string
}

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

/** Sertifika parmak izi: DER'in sha256'sı, "AB:CD:..." biçiminde (Electron certificate.fingerprint ile aynı biçim için ayrıca 'sha256/' base64 da üretilir) */
export function certFingerprint(pem: string): string {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)!.join(':')
}

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  return out
}

export class NetworkController {
  private app: FastifyInstance | null = null
  private bonjour: Bonjour | null = null
  private pairing: { code: string; expires: number } | null = null
  private lastError: string | undefined
  private cert: { key: string; cert: string; fingerprint: string } | null = null

  constructor(
    private deps: AppDeps,
    private sessions: SessionStore,
    private opts: { allowedOrigins: string[]; appVersion: string; log?: (m: string) => void },
  ) {}

  private get netDir() {
    return join(this.deps.dataRoot, 'net')
  }

  /** Kendinden imzalı sertifika (ilk kullanımda üretilir, 10 yıl geçerli) */
  async ensureCert() {
    if (this.cert) return this.cert
    mkdirSync(this.netDir, { recursive: true })
    const keyFile = join(this.netDir, 'server.key')
    const certFile = join(this.netDir, 'server.crt')
    if (!existsSync(keyFile) || !existsSync(certFile)) {
      const notAfter = new Date()
      notAfter.setFullYear(notAfter.getFullYear() + 10)
      const pems = await generate([{ name: 'commonName', value: `PatiKunye-${hostname()}` }], {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: notAfter,
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...lanAddresses().map((ip) => ({ type: 7 as const, ip }))] },
        ],
      } as never)
      writeFileSync(keyFile, pems.private, { mode: 0o600 })
      writeFileSync(certFile, pems.cert)
    }
    const cert = readFileSync(certFile, 'utf8')
    this.cert = { key: readFileSync(keyFile, 'utf8'), cert, fingerprint: certFingerprint(cert) }
    return this.cert
  }

  async status(): Promise<NetworkStatus> {
    const s = (await getSettings(this.deps.db)) as unknown as { network?: { enabled?: boolean; port?: number } }
    return {
      enabled: !!s.network?.enabled,
      running: !!this.app,
      port: s.network?.port ?? DEFAULT_LAN_PORT,
      addresses: lanAddresses(),
      fingerprint: this.cert?.fingerprint ?? (existsSync(join(this.netDir, 'server.crt')) ? certFingerprint(readFileSync(join(this.netDir, 'server.crt'), 'utf8')) : null),
      error: this.lastError,
    }
  }

  /** Ayarlarda açıksa dinleyiciyi başlatır */
  async startIfEnabled() {
    const st = await this.status()
    if (st.enabled) await this.start(st.port)
  }

  async setEnabled(enabled: boolean, port = DEFAULT_LAN_PORT) {
    await updateSettings(this.deps.db, { network: { enabled, port } } as never)
    await this.stop()
    if (enabled) await this.start(port)
    return this.status()
  }

  private async start(port: number) {
    this.lastError = undefined
    try {
      const { key, cert, fingerprint } = await this.ensureCert()
      const app = buildServer({
        ...this.deps,
        allowedOrigins: this.opts.allowedOrigins,
        sessions: this.sessions,
        https: { key, cert },
        lan: {
          fingerprint,
          version: this.opts.appVersion,
          checkDevice: (token, ip) => this.checkDevice(token, ip),
          pair: (code, name, ip) => this.pair(code, name, ip),
        },
      })
      await app.listen({ host: '0.0.0.0', port })
      this.app = app
      try {
        this.bonjour = new Bonjour()
        const clinicName = (await this.deps.db.$client.query('select name from clinic limit 1')).rows[0]?.name ?? 'PatiKünye'
        this.bonjour.publish({ name: `PatiKunye ${hostname()}`, type: 'patikunye', port, txt: { clinic: clinicName, fp: fingerprint.slice(0, 23) } })
      } catch (e) {
        this.opts.log?.(`[net] mDNS yayını başarısız: ${(e as Error).message}`)
      }
      this.opts.log?.(`[net] yerel ağ dinleyicisi açık: ${port}`)
    } catch (e) {
      this.lastError = (e as Error).message
      this.opts.log?.(`[net] başlatılamadı: ${this.lastError}`)
    }
  }

  async stop() {
    if (this.bonjour) {
      await new Promise<void>((r) => this.bonjour!.unpublishAll(() => r()))
      this.bonjour.destroy()
      this.bonjour = null
    }
    if (this.app) {
      await this.app.close()
      this.app = null
    }
  }

  /** 6 haneli eşleştirme kodu (5 dk) */
  async newPairingCode(): Promise<PairingCode> {
    const { fingerprint } = await this.ensureCert()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairing = { code, expires: Date.now() + PAIR_CODE_TTL_MS }
    return { code, expiresAt: new Date(this.pairing.expires).toISOString(), fingerprint }
  }

  private async pair(code: string, name: string, ip: string): Promise<{ deviceId: string; deviceToken: string } | null> {
    const p = this.pairing
    if (!p || p.expires < Date.now() || p.code !== code) return null
    this.pairing = null // tek kullanımlık
    const token = randomBytes(32).toString('base64url')
    const r = await this.deps.db.$client.query(
      `insert into devices (name, token_hash, last_ip, last_seen_at) values ($1, $2, $3, now()) returning id`,
      [name.slice(0, 60), sha256hex(token), ip],
    )
    return { deviceId: r.rows[0].id, deviceToken: token }
  }

  private deviceCache = new Map<string, number>()

  private async checkDevice(token: string, ip: string): Promise<boolean> {
    // Her istekte veritabanına yazmamak için doğrulanmış anahtarlar 60 sn önbellekte
    const cached = this.deviceCache.get(token)
    if (cached && cached > Date.now()) return true
    const r = await this.deps.db.$client.query(
      `update devices set last_seen_at = now(), last_ip = $2 where token_hash = $1 and revoked_at is null returning id`,
      [sha256hex(token), ip],
    )
    const ok = (r.rowCount ?? 0) > 0
    if (ok) this.deviceCache.set(token, Date.now() + 60_000)
    return ok
  }

  /** Cihaz iptal edilince önbelleği temizle */
  forgetDevices() {
    this.deviceCache.clear()
  }
}
