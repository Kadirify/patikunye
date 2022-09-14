// Modül testleri için ortak yardımcı: geçici PostgreSQL kümesi + API + giriş yapılmış istemci.
// Kullanım:
//   const t = await startTestBackend()          // beforeAll içinde (120 sn zaman aşımı verin)
//   const r = await t.api('POST', '/api/...', body)
//   await t.stop()                              // afterAll içinde
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startBackend } from './backend'
import { FileSecretStore } from './secrets-file'
import type { QuickRegisterResult, Role, SessionDto } from '../shared/api-types'

export const TEST_TODAY = '2026-10-27'

export interface TestBackend {
  backend: Awaited<ReturnType<typeof startBackend>>
  /** Yönetici (hekim yetkili) oturumuyla istek */
  api<T = any>(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; data: T }>
  adminToken: string
  adminId: string
  /** Belirli rolde kullanıcı oluşturup oturum açar (admin modülü kullanıcı API'si yoksa doğrudan veritabanına yazar) */
  loginAs(role: Role): Promise<{ token: string; userId: string }>
  /** Örnek hayvan + sahip + çip kaydı */
  registerAnimal(opts?: { chipNo?: string; name?: string; species?: string; ownerTckn?: string; phone?: string }): Promise<QuickRegisterResult>
  stop(): Promise<void>
}

let chipSeq = 100000

export async function startTestBackend(opts: { today?: string; now?: () => Date } = {}): Promise<TestBackend> {
  const dir = mkdtempSync(join(tmpdir(), 'patikunye-test-'))
  const backend = await startBackend({
    dataRoot: dir,
    migrationsFolder: resolve('drizzle'),
    moduleMigrationsFolder: resolve('migrations'),
    secrets: new FileSecretStore(join(dir, 'secrets.json')),
    allowedOrigins: ['http://localhost:5173'],
    today: () => opts.today ?? TEST_TODAY,
    now: opts.now,
    jobs: false,
    sharedBuffers: '16MB',
  })

  async function api<T>(method: string, path: string, body?: unknown, token?: string | null) {
    const t = token === undefined ? adminToken : token
    const res = await fetch(backend.apiBase + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {
      /* metin/dosya yanıtı */
    }
    return { status: res.status, data: data as T }
  }

  let adminToken = ''
  const setup = await api<SessionDto>(
    'POST',
    '/api/setup',
    {
      clinicName: 'Test Kliniği',
      city: 'Ankara',
      district: 'Çankaya',
      admin: { fullName: 'Test Hekim', username: 'admin', password: 'test-parola-123', chamberRegNo: '06-1' },
    },
    null,
  )
  if (setup.status !== 200) {
    await backend.stop()
    throw new Error('Test kurulumu başarısız: ' + JSON.stringify(setup.data))
  }
  adminToken = setup.data.token
  const adminId = setup.data.user.id

  return {
    backend,
    api,
    adminToken,
    adminId,
    async loginAs(role) {
      const { hash } = await import('@node-rs/argon2')
      const username = `${role}${Math.floor(Math.random() * 1e6)}`
      const r = await backend.db.$client.query(
        `insert into users (username, full_name, role, password_hash, chamber_reg_no) values ($1,$2,$3,$4,$5) returning id`,
        [username, `Test ${role}`, role, await hash('test-parola-123'), role === 'vet' ? '06-2' : null],
      )
      const login = await api<SessionDto>('POST', '/api/auth/login', { username, password: 'test-parola-123' }, null)
      return { token: login.data.token, userId: r.rows[0].id }
    },
    async registerAnimal(o = {}) {
      const chipNo = o.chipNo ?? `792091000${String(chipSeq++).padStart(6, '0')}`
      const r = await api<QuickRegisterResult>('POST', '/api/quick-register', {
        chipNo,
        owner: {
          firstName: 'Deneme',
          lastName: 'Sahip',
          tckn: o.ownerTckn,
          phone: o.phone ?? `05${String(30000000 + chipSeq).padStart(9, '0')}`.slice(0, 11),
          city: 'Ankara',
          district: 'Çankaya',
          kvkkNotice: true,
        },
        animal: {
          name: o.name ?? 'Pamuk',
          species: o.species ?? 'cat',
          breed: 'Tekir',
          sex: 'female',
          neutered: false,
          birthDate: '2025-03-01',
          birthDateEstimated: false,
          color: 'Gri',
        },
        implant: { date: opts.today ?? TEST_TODAY, vetId: adminId, bodySite: 'Boyun sol', verified: true },
      })
      if (r.status !== 200) throw new Error('Örnek kayıt başarısız: ' + JSON.stringify(r.data))
      return r.data
    },
    async stop() {
      await backend.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
