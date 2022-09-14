// Yerel ağ modu — istemci bilgisayar tarafı: keşif, eşleştirme, sabitlenmiş sertifikayla bağlantı.
import { request } from 'node:https'
import { Bonjour } from 'bonjour-service'
import { certFingerprint } from './network'
import type { TLSSocket } from 'node:tls'

export interface ClientConfig {
  hostUrl: string // https://192.168.1.20:47900
  fingerprint: string
  deviceToken: string
  deviceName: string
  clinicName: string
}

export interface DiscoveredHost {
  name: string
  url: string
  clinic: string
}

export interface HelloResult {
  url: string
  clinicName: string
  version: string
  /** Bağlantıda sunulan sertifikanın parmak izi (gerçekte görülen) */
  fingerprint: string
}

/** Yerel ağda yayın yapan ana bilgisayarları arar (mDNS, ~3 sn) */
export function discoverHosts(timeoutMs = 3000): Promise<DiscoveredHost[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredHost>()
    let bonjour: Bonjour | null = null
    try {
      bonjour = new Bonjour()
      bonjour.find({ type: 'patikunye' }, (s) => {
        const ip = (s.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.host
        const url = `https://${ip}:${s.port}`
        found.set(url, { name: s.name, url, clinic: String((s.txt as Record<string, unknown>)?.clinic ?? '') })
      })
    } catch {
      /* mDNS kullanılamıyor: elle adres girilir */
    }
    setTimeout(() => {
      bonjour?.destroy()
      resolve([...found.values()])
    }, timeoutMs)
  })
}

/** Sertifika doğrulamasını kendimiz yaparak (parmak izi) HTTPS isteği */
function pinnedRequest(
  url: string,
  opts: { method?: string; body?: unknown; expectFingerprint?: string; headers?: Record<string, string> },
): Promise<{ status: number; data: unknown; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        // Kendinden imzalı sertifika: zincir doğrulaması yerine parmak izi karşılaştırılır
        rejectUnauthorized: false,
        // Her istekte yeni TLS bağlantısı: yeniden kullanılan bağlantıda sertifika bilgisi boş gelebilir
        agent: false,
        timeout: 8000,
        headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...opts.headers },
      },
      (res) => {
        const sock = res.socket as TLSSocket
        const pem = sock.getPeerCertificate?.()?.raw
        const fp = pem ? certFingerprint(`-----BEGIN CERTIFICATE-----\n${pem.toString('base64')}\n-----END CERTIFICATE-----`) : ''
        if (opts.expectFingerprint && fp !== opts.expectFingerprint) {
          res.destroy()
          return reject(new Error('Ana bilgisayarın sertifikası değişmiş. Güvenlik nedeniyle bağlanılmadı.'))
        }
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let data: unknown = raw
          try {
            data = JSON.parse(raw)
          } catch {
            /* metin */
          }
          resolve({ status: res.statusCode ?? 0, data, fingerprint: fp })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Ana bilgisayar yanıt vermedi.')))
    req.on('error', (e) => reject(new Error(`Ana bilgisayara bağlanılamadı: ${e.message}`)))
    if (body) req.write(body)
    req.end()
  })
}

export function normalizeHostUrl(input: string, defaultPort = 47900): string {
  let s = input.trim()
  if (!/^https?:\/\//.test(s)) s = 'https://' + s
  const u = new URL(s)
  u.protocol = 'https:'
  if (!u.port) u.port = String(defaultPort)
  return `${u.protocol}//${u.hostname}:${u.port}`
}

export async function hello(url: string): Promise<HelloResult> {
  const r = await pinnedRequest(url + '/api/pair/hello', {})
  const d = r.data as { app?: string; clinicName?: string; version?: string }
  if (r.status !== 200 || d.app !== 'PatiKunye') throw new Error('Bu adreste PatiKünye ana bilgisayarı bulunamadı.')
  return { url, clinicName: d.clinicName ?? '', version: d.version ?? '', fingerprint: r.fingerprint }
}

export async function pair(url: string, code: string, deviceName: string, fingerprint: string, version: string): Promise<{ deviceToken: string }> {
  const r = await pinnedRequest(url + '/api/pair', { method: 'POST', body: { code, deviceName, version }, expectFingerprint: fingerprint })
  const d = r.data as { deviceToken?: string; error?: string }
  if (r.status !== 200 || !d.deviceToken) throw new Error(d.error ?? `Eşleştirme başarısız (${r.status}).`)
  return { deviceToken: d.deviceToken }
}

/** İstemci açılışında ana bilgisayara ulaşılabiliyor mu */
export async function checkHost(cfg: ClientConfig): Promise<void> {
  const r = await pinnedRequest(cfg.hostUrl + '/api/health', { expectFingerprint: cfg.fingerprint })
  if (r.status !== 200) throw new Error(`Ana bilgisayar hata döndürdü (${r.status}).`)
}
