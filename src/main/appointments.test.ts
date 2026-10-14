// Randevu modülü uçtan uca testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, type TestBackend } from './test-helpers'
import type { AppointmentConfigDto, AppointmentDto, AppointmentSaveResult, WaitingRoomDto } from '../shared/appointments'

let t: TestBackend
// 27.10.2026 Salı, 10:00 İstanbul - testler saati ilerletebilir
let nowVal = new Date('2026-10-27T10:00:00+03:00')
let cfg: AppointmentConfigDto
let animalId = ''
let animal2 = ''
let typeId = ''
let vet2 = ''

const at = (hhmm: string, date = '2026-10-27') => `${date}T${hhmm}:00+03:00`

beforeAll(async () => {
  t = await startTestBackend({ now: () => nowVal })
  animalId = await seedAnimal('Pamuk', 'cat')
  animal2 = await seedAnimal('Duman', 'dog')
  const c = await t.api<AppointmentConfigDto>('GET', '/api/appointments/config')
  expect(c.status).toBe(200)
  cfg = c.data
  typeId = cfg.types.find((x) => x.name.startsWith('Muayene'))!.id
  vet2 = (await t.loginAs('vet')).userId
})

afterAll(async () => {
  await t?.stop()
})

/** Sahip + hayvan kaydını doğrudan veritabanına yazar (başka modüllerin kayıt akışından bağımsız) */
async function seedAnimal(name: string, species: string): Promise<string> {
  const q = t.backend.db.$client
  const o = await q.query(`insert into owners (first_name, last_name, phone) values ('Deneme', 'Sahip', '+905321234567') returning id`)
  const a = await q.query(`insert into animals (name, species, sex, birth_date) values ($1, $2, 'female', '2025-03-01') returning id`, [name, species])
  await q.query(`insert into animal_owners (animal_id, owner_id, is_primary) values ($1, $2, true)`, [a.rows[0].id, o.rows[0].id])
  return a.rows[0].id
}

function body(over: Record<string, unknown> = {}) {
  return { animalId, startsAt: at('14:00'), durationMinutes: 30, vetId: t.adminId, typeId, reason: 'Kontrol', reminder: true, ...over }
}

describe('randevu yapılandırması', () => {
  it('tohum randevu türleri ve çalışma saatleri gelir', () => {
    expect(cfg.types.map((x) => x.name)).toEqual(['Muayene / kontrol', 'Aşı', 'Çip uygulama', 'Operasyon', 'Bakım'])
    expect(cfg.types.find((x) => x.name === 'Operasyon')!.defaultMinutes).toBe(90)
    expect(cfg.slotMinutes).toBe(15)
    expect(cfg.workHours.length).toBe(7)
    expect(cfg.vets.some((v) => v.id === t.adminId)).toBe(true)
  })
})

describe('randevu oluşturma', () => {
  let firstId = ''
  it('çalışma saatinde, uyarısız oluşturur', async () => {
    const r = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body())
    expect(r.status).toBe(200)
    expect(r.data.overlap).toBe(false)
    expect(r.data.warnings).toEqual([])
    firstId = r.data.id
    const g = await t.api<AppointmentDto>('GET', `/api/appointments/${firstId}`)
    expect(g.data).toMatchObject({ status: 'planned', date: '2026-10-27', time: '14:00', endTime: '14:30', animalName: 'Pamuk', typeName: 'Muayene / kontrol' })
    expect(g.data.ownerId).toBeTruthy()
  })

  it('aynı hekim + saat çakışmasını uyarır ama engellemez', async () => {
    const r = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ animalId: animal2, startsAt: at('14:15') }))
    expect(r.status).toBe(200)
    expect(r.data.overlap).toBe(true)
    expect(r.data.warnings.map((w) => w.code)).toContain('OVERLAP')
    const list = await t.api<AppointmentDto[]>('GET', '/api/appointments?from=2026-10-27&to=2026-10-27')
    const both = list.data.filter((x) => x.id === firstId || x.id === r.data.id)
    expect(both.every((x) => x.overlap)).toBe(true)
    // Başka hekim aynı saat: çakışma yok
    const r2 = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ animalId: animal2, startsAt: at('14:00'), vetId: vet2 }))
    expect(r2.data.overlap).toBe(false)
  })

  it('geçmiş saat, öğle arası, kapalı gün ve tatil için uyarı verir', async () => {
    const past = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('09:00'), vetId: vet2 }))
    expect(past.status).toBe(200)
    expect(past.data.warnings.map((w) => w.code)).toContain('PAST')

    const lunch = await t.api<{ warnings: { code: string }[] }>('POST', '/api/appointments/check', { startsAt: at('12:45'), durationMinutes: 30 })
    expect(lunch.data.warnings.map((w) => w.code)).toEqual(['BREAK'])

    const sunday = await t.api<{ warnings: { code: string }[] }>('POST', '/api/appointments/check', { startsAt: at('10:00', '2026-11-01'), durationMinutes: 30 })
    expect(sunday.data.warnings.map((w) => w.code)).toContain('CLOSED_DAY')

    const late = await t.api<{ warnings: { code: string }[] }>('POST', '/api/appointments/check', { startsAt: at('17:45', '2026-10-28'), durationMinutes: 30 })
    expect(late.data.warnings.map((w) => w.code)).toEqual(['OUTSIDE_HOURS'])

    const h = await t.api('POST', '/api/holidays', { date: '2026-10-29', name: 'Cumhuriyet Bayramı' })
    expect(h.status).toBe(200)
    const dupH = await t.api('POST', '/api/holidays', { date: '2026-10-29', name: 'Tekrar' })
    expect(dupH.status).toBe(409)
    const hol = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('10:00', '2026-10-29') }))
    expect(hol.status).toBe(200)
    expect(hol.data.warnings.map((w) => w.code)).toContain('HOLIDAY')
  })

  it('doğrulama hataları', async () => {
    const noPatient = await t.api<{ code: string }>('POST', '/api/appointments', body({ animalId: undefined }))
    expect(noPatient.status).toBe(400)
    const badTime = await t.api('POST', '/api/appointments', body({ startsAt: 'yarın' }))
    expect(badTime.status).toBe(400)
    const shortDur = await t.api('POST', '/api/appointments', body({ durationMinutes: 2 }))
    expect(shortDur.status).toBe(400)
    const badPhone = await t.api<{ error: string }>('POST', '/api/appointments', body({
      animalId: undefined,
      newPatient: { ownerName: 'Ali Kaya', phone: '123', animalName: 'Karabaş', species: 'dog' },
    }))
    expect(badPhone.status).toBe(400)
    expect(badPhone.data.error).toMatch(/telefon/i)
    const notVet = await t.api('POST', '/api/appointments', body({ vetId: (await t.loginAs('secretary')).userId }))
    expect(notVet.status).toBe(400)
  })

  it('yeni hasta mini kaydıyla randevu', async () => {
    const r = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({
      animalId: undefined,
      startsAt: at('15:00'),
      newPatient: { ownerName: 'ali kaya', phone: '0535 220 14 08', animalName: 'karabaş', species: 'dog' },
    }))
    expect(r.status).toBe(200)
    const g = await t.api<AppointmentDto>('GET', `/api/appointments/${r.data.id}`)
    expect(g.data).toMatchObject({ isNewPatient: true, animalName: 'Karabaş', ownerName: 'Ali Kaya', ownerPhone: '+905352201408', species: 'dog', ownerId: null })
  })
})

describe('taşıma ve iyimser kilit', () => {
  it('sürükle-bırak taşır, eski sürümle 409 verir', async () => {
    const c = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('16:00', '2026-10-28') }))
    const id = c.data.id
    const mv = await t.api<AppointmentSaveResult>('PATCH', `/api/appointments/${id}/move`, {
      startsAt: at('16:30', '2026-10-28'),
      endsAt: at('17:15', '2026-10-28'),
      vetId: vet2,
      version: c.data.version,
      notifyOwner: true,
    })
    expect(mv.status).toBe(200)
    expect(mv.data.version).toBe(c.data.version + 1)
    const g = await t.api<AppointmentDto>('GET', `/api/appointments/${id}`)
    expect(g.data).toMatchObject({ time: '16:30', endTime: '17:15', durationMinutes: 45, vetId: vet2 })

    const stale = await t.api<{ code: string }>('PATCH', `/api/appointments/${id}/move`, {
      startsAt: at('11:00', '2026-10-28'),
      endsAt: at('11:30', '2026-10-28'),
      vetId: vet2,
      version: c.data.version,
    })
    expect(stale.status).toBe(409)
    expect(stale.data.code).toBe('VERSION_CONFLICT')

    const staleEdit = await t.api<{ code: string }>('PUT', `/api/appointments/${id}`, { ...body({ startsAt: at('11:00', '2026-10-28') }), version: c.data.version })
    expect(staleEdit.status).toBe(409)
    const edit = await t.api<AppointmentSaveResult>('PUT', `/api/appointments/${id}`, { ...body({ startsAt: at('11:00', '2026-10-28'), reason: 'Aşı' }), version: mv.data.version })
    expect(edit.status).toBe(200)
    const g2 = await t.api<AppointmentDto>('GET', `/api/appointments/${id}`)
    expect(g2.data).toMatchObject({ time: '11:00', reason: 'Aşı', vetId: t.adminId, version: edit.data.version })
  })
})

describe('durum geçişleri', () => {
  it('Planlandı -> Geldi -> Muayenede -> Tamamlandı; geçersiz geçiş 409', async () => {
    const c = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('10:00'), vetId: vet2 }))
    const id = c.data.id
    const arrived = await t.api<AppointmentDto>('POST', `/api/appointments/${id}/status`, { status: 'arrived' })
    expect(arrived.status).toBe(200)
    expect(arrived.data.status).toBe('arrived')
    expect(arrived.data.arrivedAt).toBe(nowVal.toISOString())

    const exam = await t.api<AppointmentDto>('POST', `/api/appointments/${id}/status`, { status: 'in_exam', room: 'Oda 2' })
    expect(exam.data).toMatchObject({ status: 'in_exam', room: 'Oda 2' })

    const done = await t.api<AppointmentDto>('POST', `/api/appointments/${id}/status`, { status: 'done' })
    expect(done.data.status).toBe('done')
    expect(done.data.finishedAt).toBeTruthy()

    const bad = await t.api<{ code: string }>('POST', `/api/appointments/${id}/status`, { status: 'planned' })
    expect(bad.status).toBe(409)
    expect(bad.data.code).toBe('INVALID_TRANSITION')

    const same = await t.api('POST', `/api/appointments/${id}/status`, { status: 'done' })
    expect(same.status).toBe(409)

    const moveDone = await t.api('PATCH', `/api/appointments/${id}/move`, { startsAt: at('11:00'), endsAt: at('11:30'), vetId: vet2, version: done.data.version })
    expect(moveDone.status).toBe(409)
  })

  it('iptal: taraf ve neden zorunlu, iptal son durumdur', async () => {
    const c = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('11:00', '2026-10-30') }))
    const id = c.data.id
    const noSide = await t.api('POST', `/api/appointments/${id}/status`, { status: 'cancelled', cancelReason: 'Şehir dışında' })
    expect(noSide.status).toBe(400)
    const noReason = await t.api('POST', `/api/appointments/${id}/status`, { status: 'cancelled', cancelledBySide: 'owner' })
    expect(noReason.status).toBe(400)
    const stale = await t.api('POST', `/api/appointments/${id}/status`, { status: 'cancelled', cancelledBySide: 'owner', cancelReason: 'x', version: 99 })
    expect(stale.status).toBe(409)
    const ok = await t.api<AppointmentDto>('POST', `/api/appointments/${id}/status`, {
      status: 'cancelled',
      cancelledBySide: 'owner',
      cancelReason: 'Şehir dışında',
      notifyOwner: true,
      version: c.data.version,
    })
    expect(ok.status).toBe(200)
    expect(ok.data).toMatchObject({ status: 'cancelled', cancelledBySide: 'owner', cancelReason: 'Şehir dışında' })
    const again = await t.api('POST', `/api/appointments/${id}/status`, { status: 'arrived' })
    expect(again.status).toBe(409)
    // İptal edilen randevu çakışma sayılmaz
    const r = await t.api<AppointmentSaveResult>('POST', '/api/appointments', body({ startsAt: at('11:00', '2026-10-30') }))
    expect(r.data.overlap).toBe(false)
  })

  it('denetim kaydına yazılır', async () => {
    const r = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where entity = 'appointment'`)
    expect(r.rows[0].n).toBeGreaterThan(5)
  })
})

describe('bekleme salonu ve randevusuz hasta', () => {
  it('randevusuz hasta doğrudan "Geldi" olur; bekleme süresi ve gelmedi önerisi hesaplanır', async () => {
    nowVal = new Date('2026-10-27T10:00:00+03:00')
    const w = await t.api<AppointmentDto>('POST', '/api/appointments/walk-in', {
      newPatient: { ownerName: 'Derya Ok', phone: '05321112233', animalName: 'Kont', species: 'cat' },
      reason: 'Kusma',
    })
    expect(w.status).toBe(200)
    expect(w.data).toMatchObject({ status: 'arrived', walkIn: true, vetId: null, animalName: 'Kont', time: '10:00' })

    const w2 = await t.api<AppointmentDto>('POST', '/api/appointments/walk-in', { animalId: animal2, typeId, vetId: t.adminId })
    expect(w2.status).toBe(200)
    expect(w2.data.durationMinutes).toBe(30)

    nowVal = new Date('2026-10-27T10:20:00+03:00')
    const wr = await t.api<WaitingRoomDto>('GET', '/api/waiting-room')
    expect(wr.status).toBe(200)
    expect(wr.data.today).toBe('2026-10-27')
    const kont = wr.data.items.find((x) => x.id === w.data.id)!
    expect(kont.waitMinutes).toBe(20)
    // 09:00 randevusu hâlâ "planlandı" -> gelmedi önerisi
    const nine = wr.data.items.find((x) => x.time === '09:00')!
    expect(nine.suggestNoShow).toBe(true)
    // 14:00 randevusu için henüz öneri yok
    expect(wr.data.items.filter((x) => x.time === '14:00').every((x) => !x.suggestNoShow)).toBe(true)
    // Başka günün randevuları ve iptaller listede yok
    expect(wr.data.items.every((x) => x.date === '2026-10-27' && x.status !== 'cancelled')).toBe(true)

    // Hekimi olmayan kapıdan gelen hasta muayeneye alınınca alan hekim atanır
    const exam = await t.api<AppointmentDto>('POST', `/api/appointments/${w.data.id}/status`, { status: 'in_exam' })
    expect(exam.data.vetId).toBe(t.adminId)
    nowVal = new Date('2026-10-27T10:32:00+03:00')
    const wr2 = await t.api<WaitingRoomDto>('GET', '/api/waiting-room')
    expect(wr2.data.items.find((x) => x.id === w.data.id)!.waitMinutes).toBe(12)

    const ns = await t.api<AppointmentDto>('POST', `/api/appointments/${nine.id}/status`, { status: 'no_show' })
    expect(ns.data.status).toBe('no_show')
  })

  it('hekim filtresi ve aralık listesi', async () => {
    const r = await t.api<AppointmentDto[]>('GET', `/api/appointments?from=2026-10-26&to=2026-11-01&vetId=${vet2}`)
    expect(r.status).toBe(200)
    expect(r.data.length).toBeGreaterThan(0)
    expect(r.data.every((x) => x.vetId === vet2)).toBe(true)
    const wide = await t.api('GET', '/api/appointments?from=2026-01-01&to=2026-12-31')
    expect(wide.status).toBe(400)
    const byAnimal = await t.api<AppointmentDto[]>('GET', `/api/appointments?animalId=${animalId}`)
    expect(byAnimal.data.every((x) => x.animalId === animalId)).toBe(true)
  })
})

describe('randevu türleri ve izinler', () => {
  it('yönetici tür ekler, düzenler, pasifleştirir', async () => {
    const c = await t.api<{ id: string; name: string }>('POST', '/api/appointment-types', { name: 'Tıraş', color: '#c99088', defaultMinutes: 45 })
    expect(c.status).toBe(200)
    const dup = await t.api('POST', '/api/appointment-types', { name: 'tıraş', color: '#C99088', defaultMinutes: 45 })
    expect(dup.status).toBe(409)
    const u = await t.api<{ defaultMinutes: number; color: string }>('PUT', `/api/appointment-types/${c.data.id}`, { name: 'Tıraş', color: '#AABBCC', defaultMinutes: 60 })
    expect(u.data).toMatchObject({ defaultMinutes: 60, color: '#AABBCC' })
    const badColor = await t.api('PUT', `/api/appointment-types/${c.data.id}`, { name: 'Tıraş', color: 'mavi', defaultMinutes: 60 })
    expect(badColor.status).toBe(400)
    const d = await t.api('DELETE', `/api/appointment-types/${c.data.id}`)
    expect(d.status).toBe(200)
    const list = await t.api<{ id: string; active: boolean }[]>('GET', '/api/appointment-types')
    expect(list.data.find((x) => x.id === c.data.id)!.active).toBe(false)
  })

  it('oturumsuz 401, yetkisiz 403', async () => {
    expect((await t.api('GET', '/api/appointments', undefined, null)).status).toBe(401)
    expect((await t.api('GET', '/api/waiting-room', undefined, null)).status).toBe(401)
    const sec = await t.loginAs('secretary')
    // Sekreter randevu verebilir...
    const ok = await t.api('POST', '/api/appointments', body({ startsAt: at('10:30', '2026-11-02') }), sec.token)
    expect(ok.status).toBe(200)
    // ...ama randevu türü ve tatil ayarlarını değiştiremez
    expect((await t.api('POST', '/api/appointment-types', { name: 'Deneme', color: '#123456', defaultMinutes: 20 }, sec.token)).status).toBe(403)
    expect((await t.api('POST', '/api/holidays', { date: '2026-12-31', name: 'Yılbaşı arifesi' }, sec.token)).status).toBe(403)
    const vet = await t.loginAs('vet')
    expect((await t.api('DELETE', `/api/appointment-types/${typeId}`, undefined, vet.token)).status).toBe(403)
  })
})
