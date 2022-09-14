// Yerel ağ modu: eşleştirme, sertifika sabitleme, cihaz anahtarı, bağlantı kesme
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import { startTestBackend, type TestBackend } from './test-helpers'
import { checkHost, hello, normalizeHostUrl, pair } from './client'

let t: TestBackend
let url = ''
const port = 47950 + Math.floor(Math.random() * 40)

function lanFetch(path: string, opts: { method?: string; body?: unknown; device?: string; token?: string } = {}) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const u = new URL(url + path)
    const body = opts.body ? JSON.stringify(opts.body) : undefined
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: opts.method ?? 'GET',
        rejectUnauthorized: false,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.device ? { 'X-Device-Token': opts.device } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

beforeAll(async () => {
  t = await startTestBackend()
  const r = await t.api('POST', '/api/network/enable', { enabled: true, port })
  expect(r.status).toBe(200)
  expect(r.data).toMatchObject({ enabled: true, running: true, port })
  url = normalizeHostUrl(`127.0.0.1:${port}`)
}, 120_000)

afterAll(async () => {
  await t?.stop()
}, 60_000)

describe('yerel ağ', () => {
  let device = ''
  let fp = ''

  it('tanışma ucu klinik adı ve sertifika parmak izini verir', async () => {
    const h = await hello(url)
    expect(h.clinicName).toBe('Test Kliniği')
    expect(h.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    const st = await t.api('GET', '/api/network/status')
    expect(st.data.fingerprint).toBe(h.fingerprint)
    fp = h.fingerprint
  })

  it('cihaz anahtarı olmadan erişim yok; kurulum ağdan yapılamaz', async () => {
    expect((await lanFetch('/api/animals')).status).toBe(401)
    expect((await lanFetch('/api/setup', { method: 'POST', body: {} })).status).toBe(403)
  })

  it('yanlış kod reddedilir, doğru kod tek kullanımlıktır', async () => {
    await expect(pair(url, '000000', 'Oda 1', fp, '0.0.0')).rejects.toThrow(/yanlış|süresi/)
    const c = await t.api('POST', '/api/network/pairing-code')
    expect(c.data.code).toMatch(/^\d{6}$/)
    const r = await pair(url, c.data.code, 'Muayene Odası 1', fp, '0.0.0')
    device = r.deviceToken
    expect(device.length).toBeGreaterThan(30)
    await expect(pair(url, c.data.code, 'Oda 2', fp, '0.0.0')).rejects.toThrow()
  })

  it('sürüm uyumsuzluğu bildirilir', async () => {
    const c = await t.api('POST', '/api/network/pairing-code')
    await expect(pair(url, c.data.code, 'Oda 3', fp, '9.9.9')).rejects.toThrow(/Sürüm uyumsuz/)
  })

  it('farklı parmak izine bağlanılmaz', async () => {
    await expect(checkHost({ hostUrl: url, fingerprint: 'AA:BB', deviceToken: device, deviceName: 'x', clinicName: '' })).rejects.toThrow(/sertifika/i)
    await checkHost({ hostUrl: url, fingerprint: fp, deviceToken: device, deviceName: 'x', clinicName: '' })
  })

  it('eşleşmiş cihazla giriş yapılır ve veri okunur; oturumlar paylaşılır', async () => {
    await t.registerAnimal({ name: 'Ağdaki' })
    const login = await lanFetch('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'test-parola-123' }, device })
    expect(login.status).toBe(200)
    const list = await lanFetch('/api/animals', { device, token: login.data.token })
    expect(list.status).toBe(200)
    expect(list.data.map((a: { name: string }) => a.name)).toContain('Ağdaki')
    // Yerel dinleyicide açılan oturum ağ dinleyicisinde de geçerli (aynı oturum deposu)
    const me = await lanFetch('/api/auth/me', { device, token: t.adminToken })
    expect(me.status).toBe(200)
  })

  it('bağlantısı kesilen cihaz erişemez', async () => {
    const devs = await t.api('GET', '/api/network/devices')
    const d = devs.data.find((x: { name: string }) => x.name === 'Muayene Odası 1')
    expect(d.lastIp).toBeTruthy()
    expect((await t.api('POST', `/api/network/devices/${d.id}/revoke`)).status).toBe(200)
    expect((await lanFetch('/api/health')).status).toBe(200)
    expect((await lanFetch('/api/auth/me', { device, token: t.adminToken })).status).toBe(401)
  })

  it('yerel ağ kapatılınca dinleyici kapanır', async () => {
    await t.api('POST', '/api/network/enable', { enabled: false })
    await expect(hello(url)).rejects.toThrow()
  })
})
