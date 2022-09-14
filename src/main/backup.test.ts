// Modül G — yedekleme / geri yükleme / veritabanı uçtan uca testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestBackend, type TestBackend } from './test-helpers'
import { applyRetention } from './server/services/backup'
import { lastScheduledAt, shouldRunDaily } from './server/services/backup-job'
import type { BackupListItem, BackupResultDto, BackupStatusDto, RestoreResultDto } from '../shared/backup'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TCKN = '12345678950'
const PW = 'yedek-parola-2'
const ADMIN_PW = 'test-parola-123'

let a: TestBackend
let b: TestBackend
let tmp: string
let animalId = ''
let attachmentId = ''
let backupPath = ''

const count = async (t: TestBackend, table: string) => Number((await t.backend.db.$client.query(`select count(*)::int n from ${table}`)).rows[0].n)

beforeAll(async () => {
  ;[a, b] = await Promise.all([startTestBackend(), startTestBackend()])
  tmp = await mkdtemp(join(tmpdir(), 'patikunye-backup-test-'))
})

afterAll(async () => {
  await a?.stop()
  await b?.stop()
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

describe('Yedekleme', () => {
  it('parola belirlenmeden yedek alınmaz; parola belirlenir ve değiştirilir', async () => {
    const r = await a.api('POST', '/api/backup/run', {})
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('BACKUP_NO_PASSWORD')
    expect((await a.api('POST', '/api/backup/password', { newPassword: 'kisa' })).status).toBe(400)
    expect((await a.api('POST', '/api/backup/password', { newPassword: 'yedek-parola-1' })).status).toBe(200)
    // İkinci kez: mevcut parola gerekir
    expect((await a.api('POST', '/api/backup/password', { newPassword: PW })).status).toBe(400)
    expect((await a.api('POST', '/api/backup/password', { newPassword: PW, currentPassword: 'yanlis-parola' })).status).toBe(400)
    expect((await a.api('POST', '/api/backup/password', { newPassword: PW, currentPassword: 'yedek-parola-1' })).status).toBe(200)
    const st = await a.api<BackupStatusDto>('GET', '/api/backup/status')
    expect(st.data.passwordSet).toBe(true)
    expect(st.data.state).toBe('err') // henüz yedek yok
  })

  it('izinler: teknisyen yedek alamaz/geri yükleyemez, durumu görebilir', async () => {
    const tech = await a.loginAs('tech')
    expect((await a.api('GET', '/api/backup/status', undefined, tech.token)).status).toBe(200)
    expect((await a.api('POST', '/api/backup/run', {}, tech.token)).status).toBe(403)
    expect((await a.api('GET', '/api/backup/list', undefined, tech.token)).status).toBe(403)
    expect((await a.api('POST', '/api/backup/restore', { path: 'C:\\x.pkb', password: 'x', confirm: 'GERİ YÜKLE', adminPassword: 'x' }, tech.token)).status).toBe(403)
    expect((await a.api('PUT', '/api/backup/settings', { time: '03:00', keepDaily: 14, keepMonthly: 12 }, tech.token)).status).toBe(403)
    expect((await a.api('POST', '/api/backup/password', { newPassword: 'baska-parola-1' }, tech.token)).status).toBe(403)
    expect((await a.api('GET', '/api/db/status', undefined, tech.token)).status).toBe(403)
    expect((await a.api('POST', '/api/db/maintenance', {}, tech.token)).status).toBe(403)
    const vet = await a.loginAs('vet')
    expect((await a.api('POST', '/api/backup/restore', { path: 'C:\\x.pkb', password: 'x', confirm: 'GERİ YÜKLE', adminPassword: 'x' }, vet.token)).status).toBe(403)
  })

  it('ayarlar ve hedefler', async () => {
    expect((await a.api('PUT', '/api/backup/settings', { time: '25:00', keepDaily: 14, keepMonthly: 12 })).status).toBe(400)
    expect((await a.api('PUT', '/api/backup/settings', { time: '02:30', keepDaily: 14, keepMonthly: 12 })).status).toBe(200)
    const s = await a.api('GET', '/api/backup/settings')
    expect(s.data.time).toBe('02:30')
    expect(s.data.targets).toEqual([])

    const t1 = join(tmp, 'hedef1')
    const t2 = join(tmp, 'hedef2')
    const test = await a.api('POST', '/api/backup/targets/test', { path: t1 })
    expect(test.data.writable).toBe(true)
    expect((await a.api('POST', '/api/backup/targets/test', { path: 'goreli/yol' })).data.writable).toBe(false)
    expect((await a.api('POST', '/api/backup/targets', { path: t1 })).status).toBe(200)
    expect((await a.api('POST', '/api/backup/targets', { path: t1 })).status).toBe(409)
    expect((await a.api('POST', '/api/backup/targets', { path: t2 })).status).toBe(200)
    const list = await a.api('GET', '/api/backup/targets')
    expect(list.data.map((x: { path: string }) => x.path)).toEqual([t1, t2])
  })

  it('yedek alır, doğrular; veri değişince geri yükler (TCKN ve dosya okunur, sayımlar aynı)', async () => {
    const reg = await a.registerAnimal({ ownerTckn: TCKN })
    animalId = reg.animalId
    await a.registerAnimal({ name: 'Boncuk' })
    const up = await a.api('POST', '/api/files', { ownerType: 'animal', ownerId: animalId, fileName: 'röntgen.png', mime: 'image/png', dataBase64: PNG_B64 })
    expect(up.status).toBe(200)
    attachmentId = up.data.id

    const before = {
      owners: await count(a, 'owners'),
      animals: await count(a, 'animals'),
      attachments: await count(a, 'attachments'),
      microchips: await count(a, 'microchips'),
      users: await count(a, 'users'),
    }

    const run = await a.api<BackupResultDto>('POST', '/api/backup/run', {})
    expect(run.status).toBe(200)
    expect(run.data.targets.every((t) => t.ok)).toBe(true)
    expect(run.data.targets).toHaveLength(2)
    expect(run.data.verified).toBe(true)
    expect(run.data.filesTotal).toBe(1)
    backupPath = join(run.data.targets[0].path, run.data.fileName)
    expect((await readdir(run.data.targets[1].path))).toContain(run.data.fileName)
    // Dosyada düz TCKN görünmemeli (şifreli)
    expect((await readFile(backupPath)).includes(Buffer.from(TCKN))).toBe(false)

    const st = await a.api<BackupStatusDto>('GET', '/api/backup/status')
    expect(st.data.state).toBe('ok')
    expect(st.data.hoursAgo).toBeLessThan(1)

    const list = await a.api<BackupListItem[]>('GET', '/api/backup/list')
    expect(list.data[0].id).toBe(run.data.id)
    expect(list.data[0].verifyOk).toBe(true)

    const v = await a.api('POST', '/api/backup/verify', { backupId: run.data.id })
    expect(v.status).toBe(200)
    expect(v.data.rowsTotal).toBe(run.data.rowsTotal)
    expect(v.data.files).toBe(1)
    const vBad = await a.api('POST', '/api/backup/verify', { path: backupPath, password: 'yanlis-parola' })
    expect(vBad.status).toBe(400)
    expect(vBad.data.code).toBe('BACKUP_WRONG_PASSWORD')

    // Veriyi değiştir / sil
    const db = a.backend.db.$client
    await db.query(`update animals set name = 'Değişti' where id = $1`, [animalId])
    await db.query(`update attachments set deleted_at = now() where id = $1`, [attachmentId])
    await a.registerAnimal({ name: 'Yeni' })
    expect(await count(a, 'animals')).toBe(before.animals + 1)

    // Onay ve parola denetimleri
    const base = { backupId: run.data.id, password: PW, confirm: 'GERİ YÜKLE', adminPassword: ADMIN_PW }
    expect((await a.api('POST', '/api/backup/restore', { ...base, confirm: 'geri' })).data.code).toBe('CONFIRM_REQUIRED')
    expect((await a.api('POST', '/api/backup/restore', { ...base, adminPassword: 'yanlis' })).data.code).toBe('ADMIN_PASSWORD')
    expect((await a.api('POST', '/api/backup/restore', { ...base, password: 'yanlis-parola' })).data.code).toBe('BACKUP_WRONG_PASSWORD')
    expect((await db.query('select name from animals where id = $1', [animalId])).rows[0].name).toBe('Değişti')

    const r = await a.api<RestoreResultDto>('POST', '/api/backup/restore', base)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.preRestoreBackupId).toBeTruthy()
    expect(r.data.files).toBe(1)

    expect((await db.query('select name from animals where id = $1', [animalId])).rows[0].name).toBe('Pamuk')
    expect({
      owners: await count(a, 'owners'),
      animals: await count(a, 'animals'),
      attachments: await count(a, 'attachments'),
      microchips: await count(a, 'microchips'),
      users: await count(a, 'users'),
    }).toEqual(before)
    const o = await db.query('select tckn_enc, tckn_hash from owners where id = $1', [reg.ownerId])
    expect(a.backend.deps.crypto.decrypt(o.rows[0].tckn_enc)).toBe(TCKN)
    expect(o.rows[0].tckn_hash).toBe(a.backend.deps.crypto.hash(TCKN))
    const f = await fetch(a.backend.apiBase + '/api/files/' + attachmentId, { headers: { Authorization: `Bearer ${a.adminToken}` } })
    expect(f.status).toBe(200)
    expect(Buffer.from(await f.arrayBuffer()).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)

    // Geri yükleme öncesi yedek listede; audit sırası (bigserial) çalışıyor
    const list2 = await a.api<BackupListItem[]>('GET', '/api/backup/list')
    expect(list2.data.some((x) => x.reason === 'pre_restore' && !x.error)).toBe(true)
    const audit = await db.query(`select summary from audit_logs order by id desc limit 1`)
    expect(audit.rows[0].summary).toMatch(/Yedekten geri yüklendi/)
  }, 120_000)

  it('bozuk / yabancı dosyalar reddedilir', async () => {
    const bad = join(tmp, 'bozuk.pkb')
    const buf = await readFile(backupPath)
    buf[Math.floor(buf.length / 2)] ^= 0xff
    await writeFile(bad, buf)
    const r1 = await a.api('POST', '/api/backup/verify', { path: bad, password: PW })
    expect(r1.status).toBe(400)
    expect(r1.data.code).toBe('BACKUP_CORRUPT')

    const cut = join(tmp, 'yarim.pkb')
    await writeFile(cut, (await readFile(backupPath)).subarray(0, 200))
    expect((await a.api('POST', '/api/backup/verify', { path: cut, password: PW })).data.code).toBe('BACKUP_CORRUPT')

    const other = join(tmp, 'baska.pkb')
    await writeFile(other, Buffer.alloc(500, 1))
    expect((await a.api('POST', '/api/backup/verify', { path: other, password: PW })).data.code).toBe('BACKUP_NOT_PKB')

    // Bozuk dosyayla geri yükleme veriyi değiştirmemeli
    const animals = await count(a, 'animals')
    const r = await a.api('POST', '/api/backup/restore', { path: bad, password: PW, confirm: 'GERİ YÜKLE', adminPassword: ADMIN_PW })
    expect(r.status).toBe(400)
    expect(r.data.code).toBe('BACKUP_CORRUPT')
    expect(await count(a, 'animals')).toBe(animals)
    const f = await fetch(a.backend.apiBase + '/api/files/' + attachmentId, { headers: { Authorization: `Bearer ${a.adminToken}` } })
    expect(f.status).toBe(200)
  }, 120_000)

  it('farklı anahtarlı başka bir kuruluma taşınır (TCKN araması ve dosya çalışır)', async () => {
    const moved = join(tmp, 'tasinan.pkb')
    await copyFile(backupPath, moved)
    expect((await b.api<BackupStatusDto>('GET', '/api/backup/status')).data.passwordSet).toBe(false)
    const r = await b.api<RestoreResultDto>('POST', '/api/backup/restore', { path: moved, password: PW, confirm: 'GERİ YÜKLE', adminPassword: ADMIN_PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)

    // Anahtarlar gerçekten farklı
    expect(b.backend.deps.crypto.hash(TCKN)).not.toBe(a.backend.deps.crypto.hash(TCKN))
    const db = b.backend.db.$client
    const o = await db.query('select tckn_enc from owners where tckn_hash = $1', [b.backend.deps.crypto.hash(TCKN)])
    expect(o.rowCount).toBe(1)
    expect(b.backend.deps.crypto.decrypt(o.rows[0].tckn_enc)).toBe(TCKN)
    const search = await b.api('GET', '/api/owners?q=' + TCKN)
    expect(search.status).toBe(200)
    expect(JSON.stringify(search.data)).toContain('Deneme')

    const f = await fetch(b.backend.apiBase + '/api/files/' + attachmentId, { headers: { Authorization: `Bearer ${b.adminToken}` } })
    expect(f.status).toBe(200)
    expect(Buffer.from(await f.arrayBuffer()).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
    expect(await count(b, 'animals')).toBe((await count(a, 'animals')))

    // Yeni kurulumda yedek parolası geri yüklenen yedeğinki oldu; otomatik yedek çalışır
    expect((await b.api<BackupStatusDto>('GET', '/api/backup/status')).data.passwordSet).toBe(true)
    const run = await b.api<BackupResultDto>('POST', '/api/backup/run', {})
    expect(run.status, JSON.stringify(run.data)).toBe(200)
  }, 120_000)

  it('saklama politikası: son N gün + her ayın en yenisi', async () => {
    const dir = join(tmp, 'saklama')
    await rm(dir, { recursive: true, force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir)
    const names: string[] = []
    // Ağustos–Ekim arası her gün bir yedek
    for (let d = new Date('2026-08-01T00:00:00Z'); d <= new Date('2026-10-27T00:00:00Z'); d = new Date(d.getTime() + 86400_000)) {
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, '')
      const n = `patikunye-${ymd}-030000-daily-abcd.pkb`
      names.push(n)
      await writeFile(join(dir, n), 'x')
    }
    await writeFile(join(dir, 'baska-dosya.txt'), 'x')
    const deleted = await applyRetention(dir, 3, 2)
    const left = (await readdir(dir)).sort()
    expect(left).toEqual(
      [
        'baska-dosya.txt',
        'patikunye-20260930-030000-daily-abcd.pkb', // eylülün en yenisi
        'patikunye-20261025-030000-daily-abcd.pkb',
        'patikunye-20261026-030000-daily-abcd.pkb',
        'patikunye-20261027-030000-daily-abcd.pkb', // aynı zamanda ekimin en yenisi
      ].sort(),
    )
    expect(deleted.length).toBe(names.length - 4)
  })

  it('günlük iş zamanlaması', async () => {
    // 04:00 TR → bugün 03:00; 02:00 TR → dün 03:00
    expect(lastScheduledAt(new Date('2026-10-27T01:00:00Z'), '03:00').toISOString()).toBe('2026-10-27T00:00:00.000Z')
    expect(lastScheduledAt(new Date('2026-10-26T23:00:00Z'), '03:00').toISOString()).toBe('2026-10-26T00:00:00.000Z')
    // a'da az önce başarılı yedek var → çalışmamalı
    expect(await shouldRunDaily(a.backend.deps)).toBe(false)
    // Saat 2 gün sonrası → çalışmalı
    const later = { ...a.backend.deps, now: () => new Date(Date.now() + 2 * 86400_000) }
    expect(await shouldRunDaily(later)).toBe(true)
  })

  it('hedef silinir', async () => {
    const t2 = join(tmp, 'hedef2')
    expect((await a.api('POST', '/api/backup/targets/remove', { path: t2 })).status).toBe(200)
    expect((await a.api('POST', '/api/backup/targets/remove', { path: t2 })).status).toBe(404)
  })
})

describe('Veritabanı (S-111)', () => {
  it('durum, bakım, tanı paketi', async () => {
    const s = await a.api('GET', '/api/db/status')
    expect(s.status).toBe(200)
    expect(s.data.version).toMatch(/^18/)
    expect(s.data.sizeBytes).toBeGreaterThan(0)
    expect(s.data.tables.find((t: { name: string }) => t.name === 'owners').rows).toBeGreaterThan(0)
    expect(s.data.migrations.some((m: { name: string }) => m.name === '800_backup.sql')).toBe(true)

    const m = await a.api('POST', '/api/db/maintenance', {})
    expect(m.status).toBe(200)

    const res = await fetch(a.backend.apiBase + '/api/db/diagnostics', { headers: { Authorization: `Bearer ${a.adminToken}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment/)
    const text = await res.text()
    const d = JSON.parse(text)
    expect(Array.isArray(d.postgresLog)).toBe(true)
    expect(d.tables.length).toBeGreaterThan(5)
    expect(text).not.toContain(TCKN)
    expect(text).not.toContain('Deneme')
  })
})
