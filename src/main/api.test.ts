// API uçtan uca testi: geçici bir PostgreSQL kümesi kurar, gerçek HTTP istekleriyle akışı dener.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startBackend } from './backend'
import { FileSecretStore } from './secrets-file'
import { sha256 } from './crypto'
import { canonical } from './server/audit'
import type { AnimalDetail, ChipLookupDto, PetvetTaskDetail, PetvetTaskListItem, QuickRegisterResult, SessionDto } from '../shared/api-types'

const TODAY = '2026-10-27'
let backend: Awaited<ReturnType<typeof startBackend>>
let dir: string
let token = ''
let vetId = ''

async function api<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; data: T }> {
  const res = await fetch(backend.apiBase + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: (await res.json()) as T }
}

const baseOwner = {
  firstName: 'şükrü',
  lastName: 'IŞIK',
  phone: '0532 123 45 67',
  city: 'Ankara',
  district: 'Çankaya',
  kvkkNotice: true,
}
const baseAnimal = { name: 'pamuk', species: 'cat', breed: 'Tekir', sex: 'female', neutered: true, birthDate: '2025-03-01', birthDateEstimated: false, color: 'Gri tekir' }
const implant = () => ({ date: '2026-10-20', vetId, bodySite: 'Boyun sol', verified: true })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patikunye-test-'))
  backend = await startBackend({
    dataRoot: dir,
    migrationsFolder: resolve('drizzle'),
    secrets: new FileSecretStore(join(dir, 'secrets.json')),
    allowedOrigins: ['http://localhost:5173'],
    today: () => TODAY,
    jobs: false,
    sharedBuffers: '16MB',
  })
}, 120_000)

afterAll(async () => {
  await backend?.stop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('kurulum ve giriş', () => {
  it('ilk açılışta kurulum ister, oturumsuz istekleri reddeder', async () => {
    expect((await api('GET', '/api/setup/status')).data).toEqual({ needsSetup: true })
    expect((await api('GET', '/api/animals')).status).toBe(401)
  })

  it('zayıf parolayı reddeder', async () => {
    const r = await api<{ error: string }>('POST', '/api/setup', {
      clinicName: 'Can Dostlar',
      city: 'Ankara',
      district: 'Çankaya',
      admin: { fullName: 'ayşe demir', username: 'ayse', password: 'kisa', chamberRegNo: '1234' },
    })
    expect(r.status).toBe(400)
    expect(r.data.error).toContain('10 karakter')
  })

  it('kurulumu yapar, ikinci kez izin vermez', async () => {
    const body = {
      clinicName: 'Can Dostlar Veteriner Kliniği',
      city: 'Ankara',
      district: 'Çankaya',
      admin: { fullName: 'ayşe demir', username: 'Ayse', password: 'cok-gizli-parola-1', chamberRegNo: '06-1234' },
    }
    const r = await api<SessionDto>('POST', '/api/setup', body)
    expect(r.status).toBe(200)
    expect(r.data.user).toMatchObject({ username: 'ayse', fullName: 'Ayşe Demir', role: 'admin' })
    expect((await api('POST', '/api/setup', body)).status).toBe(409)
  })

  it('yanlış parolayı reddeder, doğru parolayla giriş yapar', async () => {
    expect((await api('POST', '/api/auth/login', { username: 'ayse', password: 'yanlis-parola' })).status).toBe(401)
    const r = await api<SessionDto>('POST', '/api/auth/login', { username: 'ayse', password: 'cok-gizli-parola-1' })
    expect(r.status).toBe(200)
    token = r.data.token
    vetId = r.data.user.id
    expect((await api<{ clinicName: string }>('GET', '/api/auth/me')).data.clinicName).toBe('Can Dostlar Veteriner Kliniği')
  })

  it('bilinmeyen kökenden gelen isteği reddeder', async () => {
    const res = await fetch(backend.apiBase + '/api/health', { headers: { Origin: 'https://kotu-site.example' } })
    expect(res.status).toBe(403)
  })
})

describe('çip ve hızlı kayıt', () => {
  let animalId = ''
  let taskId = ''

  it('geçersiz çipi bildirir', async () => {
    const r = await api<ChipLookupDto>('GET', '/api/chips/lookup?no=79209123456')
    expect(r.data.validation.ok).toBe(false)
    expect(r.data.match).toBeNull()
  })

  it('kayıtlı olmayan geçerli çip için eşleşme döndürmez', async () => {
    const r = await api<ChipLookupDto>('GET', '/api/chips/lookup?no=792%20091%20234%20567%20890')
    expect(r.data.validation).toMatchObject({ ok: true, value: '792091234567890' })
    expect(r.data.match).toBeNull()
  })

  it('TCKN olmadan kayıt: PETVET görevi "eksik bilgi" açılır', async () => {
    const r = await api<QuickRegisterResult>('POST', '/api/quick-register', {
      chipNo: '792091234567890',
      owner: baseOwner,
      animal: baseAnimal,
      implant: implant(),
    })
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ petvetStatus: 'missing_info', dueDate: '2026-11-04' })
    animalId = r.data.animalId
    taskId = r.data.petvetTaskId!
  })

  it('aynı çip ikinci kez kaydedilemez', async () => {
    const r = await api<{ code: string }>('POST', '/api/quick-register', {
      chipNo: '792091234567890',
      owner: { ...baseOwner, phone: '05321112233' },
      animal: baseAnimal,
      implant: implant(),
    })
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('CHIP_EXISTS')
  })

  it('okuma onayı ve gelecek tarih kontrolü', async () => {
    const r1 = await api<{ error: string }>('POST', '/api/quick-register', {
      chipNo: '792091234567891',
      owner: baseOwner,
      animal: baseAnimal,
      implant: { ...implant(), verified: false },
    })
    expect(r1.status).toBe(400)
    expect(r1.data.error).toContain('tekrar okutulduğunu')
    const r2 = await api('POST', '/api/quick-register', {
      chipNo: '792091234567891',
      owner: baseOwner,
      animal: baseAnimal,
      implant: { ...implant(), date: '2026-11-01' },
    })
    expect(r2.status).toBe(400)
  })

  it('okutulan çip kaydı bulur', async () => {
    const r = await api<ChipLookupDto>('GET', '/api/chips/lookup?no=792091234567890')
    expect(r.data.match?.animal).toMatchObject({ id: animalId, name: 'Pamuk', ownerName: 'Şükrü Işık', ownerPhone: '+905321234567' })
    expect(r.data.match?.animal.petvet).toMatchObject({ status: 'missing_info', daysLeft: 8 })
  })

  it('Türkçe karaktersiz arama ve çip/telefon araması', async () => {
    const byName = await api<{ id: string }[]>('GET', '/api/animals?q=sukru')
    expect(byName.data.map((a) => a.id)).toContain(animalId)
    const byChip = await api<{ id: string }[]>('GET', '/api/animals?q=567890')
    expect(byChip.data.map((a) => a.id)).toContain(animalId)
    const byPhone = await api<{ id: string }[]>('GET', '/api/animals?q=0532%20123')
    expect(byPhone.data.map((a) => a.id)).toContain(animalId)
    const none = await api<unknown[]>('GET', '/api/animals?q=karabas')
    expect(none.data).toHaveLength(0)
  })

  it('eksik bilgili görev kapatılamaz; TCKN eklenince bekliyor olur', async () => {
    expect((await api('POST', `/api/petvet/tasks/${taskId}/done`, {})).status).toBe(409)
    const detail = await api<AnimalDetail>('GET', `/api/animals/${animalId}`)
    const ownerId = detail.data.owners[0].id
    expect((await api('POST', `/api/owners/${ownerId}/tckn`, { tckn: '12345678951' })).status).toBe(400)
    expect((await api('POST', `/api/owners/${ownerId}/tckn`, { tckn: '12345678950' })).status).toBe(200)
    const tasks = await api<PetvetTaskListItem[]>('GET', '/api/petvet/tasks?filter=open')
    expect(tasks.data.find((t) => t.id === taskId)).toMatchObject({ status: 'pending', missingFields: [] })
  })

  it('görev detayı PETVET biçiminde alanlar verir ve TCKN görüntülemeyi kaydeder', async () => {
    const r = await api<PetvetTaskDetail>('GET', `/api/petvet/tasks/${taskId}`)
    const v = Object.fromEntries(r.data.copyFields.map((f) => [f.key, f.value]))
    expect(v).toMatchObject({
      tckn: '12345678950',
      firstName: 'ŞÜKRÜ',
      lastName: 'IŞIK',
      phone: '5321234567',
      cityDistrict: 'ANKARA / ÇANKAYA',
      chipNo: '792091234567890',
      name: 'PAMUK',
      speciesBreed: 'KEDİ / TEKİR',
      sex: 'DİŞİ',
      implant: '20.10.2026 - Boyun sol',
    })
    const log = await backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'view_sensitive'`)
    expect(log.rows[0].n).toBe(1)
  })

  it('TCKN ile yeni sahip: görev doğrudan bekliyor; aynı TCKN ikinci sahipte reddedilir', async () => {
    const r = await api<QuickRegisterResult>('POST', '/api/quick-register', {
      chipNo: '900164001234567',
      owner: { ...baseOwner, firstName: 'Ali', lastName: 'Kaya', tckn: '10000000146', phone: '05334102291' },
      animal: { ...baseAnimal, name: 'Karabaş', species: 'dog', breed: 'Kangal', sex: 'male' },
      implant: { ...implant(), date: '2026-10-07' },
    })
    expect(r.data).toMatchObject({ petvetStatus: 'pending', dueDate: '2026-10-22' })
    const dup = await api<{ code: string }>('POST', '/api/owners', { ...baseOwner, tckn: '10000000146' })
    expect(dup.status).toBe(409)
    expect(dup.data.code).toBe('DUPLICATE_TCKN')
  })

  it('PETVET özeti ve gecikenler', async () => {
    const s = await api<Record<string, number>>('GET', '/api/petvet/summary')
    expect(s.data).toMatchObject({ overdue: 1, open: 2, missing: 0 })
    const overdue = await api<PetvetTaskListItem[]>('GET', '/api/petvet/tasks?filter=overdue')
    expect(overdue.data[0]).toMatchObject({ animalName: 'Karabaş', urgency: 'overdue', daysLeft: -5 })
  })

  it('görev "girildi" olarak kapatılır, ikinci kez kapatılamaz', async () => {
    expect((await api('POST', `/api/petvet/tasks/${taskId}/done`, { petvetRef: 'PV-123' })).status).toBe(200)
    expect((await api('POST', `/api/petvet/tasks/${taskId}/done`, {})).status).toBe(409)
    const s = await api<Record<string, number>>('GET', '/api/petvet/summary')
    expect(s.data).toMatchObject({ open: 1, doneThisMonth: 1 })
  })

  it('test çipi (999) için PETVET görevi açılmaz', async () => {
    const r = await api<QuickRegisterResult>('POST', '/api/quick-register', {
      chipNo: '999000000000001',
      owner: { ...baseOwner, firstName: 'Deneme', lastName: 'Sahip', phone: '05000000000' },
      animal: baseAnimal,
      implant: implant(),
    })
    expect(r.status).toBe(200)
    expect(r.data.petvetTaskId).toBeNull()
  })
})

describe('denetim kaydı', () => {
  it('hash zinciri bozulmamış', async () => {
    const r = await backend.db.$client.query(
      'select created_at as at, user_id, action, entity, entity_id, summary, diff, prev_hash, hash from audit_logs order by id',
    )
    let prev: string | null = null
    for (const row of r.rows) {
      expect(row.prev_hash).toBe(prev)
      const expected = sha256(
        JSON.stringify([prev, new Date(row.at).toISOString(), row.user_id, row.action, row.entity, row.entity_id, row.summary, row.diff === null ? null : canonical(row.diff)]),
      )
      expect(row.hash).toBe(expected)
      prev = row.hash
    }
    expect(r.rows.length).toBeGreaterThan(5)
  })

  it('TCKN veritabanında düz metin olarak durmaz', async () => {
    const r = await backend.db.$client.query('select tckn_enc, tckn_hash, tckn_last4 from owners where tckn_enc is not null')
    for (const row of r.rows) {
      expect(row.tckn_enc).not.toMatch(/\d{11}/)
      expect(row.tckn_last4).toMatch(/^\d{4}$/)
    }
  })
})
