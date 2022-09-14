// Aşı modülü (D) uçtan uca testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, TEST_TODAY, type TestBackend } from './test-helpers'
import { addDaysIso } from '../shared/petvet'
import type { AnimalVaccinesDto, CalendarDto, VaccinateResult, VaccinePreviewDto, VaccineProduct, VaccineProtocol } from '../shared/vaccines'

let t: TestBackend
let seq = 0
/**
 * Doğrudan veritabanına örnek sahip + hayvan yazar.
 * (t.registerAnimal() hızlı kayıt uç noktasını kullanır; B modülü createOwner'daki boş etiket dizisi hatası
 *  düzelene kadar aşı testleri ona bağımlı olmasın.)
 */
async function makeAnimal(o: { name?: string; species?: string; tckn?: boolean; birthDate?: string } = {}) {
  const c = t.backend.db.$client
  seq++
  const owner = await c.query(
    `insert into owners (first_name, last_name, phone, tckn_hash, tckn_last4, kvkk_notice_at) values ($1, 'Sahip', $2, $3, $4, now()) returning id`,
    [`Deneme${seq}`, `+90530${String(1000000 + seq).padStart(7, '0')}`, o.tckn ? `hash-${seq}-${Date.now()}` : null, o.tckn ? '1234' : null],
  )
  const animal = await c.query(
    `insert into animals (name, species, sex, birth_date) values ($1, $2, 'female', $3) returning id`,
    [o.name ?? 'Pamuk', o.species ?? 'cat', o.birthDate ?? '2025-03-01'],
  )
  await c.query(`insert into animal_owners (animal_id, owner_id, is_primary, from_date) values ($1, $2, true, $3)`, [animal.rows[0].id, owner.rows[0].id, TEST_TODAY])
  return { animalId: animal.rows[0].id as string, ownerId: owner.rows[0].id as string }
}

let products: VaccineProduct[]
const prod = (name: string) => products.find((p) => p.name === name)!

beforeAll(async () => {
  t = await startTestBackend()
  products = (await t.api<VaccineProduct[]>('GET', '/api/vaccine-products')).data
}, 120_000)

afterAll(async () => {
  await t?.stop()
}, 60_000)

const rabies = (animalId: string, extra: Record<string, unknown> = {}) => ({
  animalId,
  kind: 'rabies',
  productId: prod('Rabisin').id,
  lotNo: 'R2231',
  expiryDate: '2027-06-30',
  givenAt: TEST_TODAY,
  givenBy: t.adminId,
  passportRecorded: true,
  ...extra,
})

async function animalVaccines(id: string) {
  return (await t.api<AnimalVaccinesDto>('GET', `/api/animals/${id}/vaccines`)).data
}

describe('ürün ve protokol tohumları', () => {
  it('örnek ürünler ve protokoller gelir', async () => {
    expect(products.length).toBeGreaterThanOrEqual(8)
    const protos = (await t.api<VaccineProtocol[]>('GET', '/api/vaccine-protocols?species=cat')).data
    expect(protos.some((p) => p.kind === 'combo')).toBe(true)
  })

  it('ürün ekleme ayar izni ister', async () => {
    const vet = await t.loginAs('vet')
    const body = { name: 'Deneme Aşı', kind: 'other', species: ['dog'], immunityDays: 180 }
    expect((await t.api('POST', '/api/vaccine-products', body, vet.token)).status).toBe(403)
    const r = await t.api<VaccineProduct>('POST', '/api/vaccine-products', body)
    expect(r.status).toBe(200)
    const u = await t.api<VaccineProduct>('PUT', `/api/vaccine-products/${r.data.id}`, { ...body, active: false })
    expect(u.data.active).toBe(false)
  })

  it('protokolde rapel yalnızca son adımda olabilir', async () => {
    const r = await t.api('POST', '/api/vaccine-protocols', {
      species: 'dog',
      kind: 'lyme',
      name: 'Hatalı',
      steps: [{ label: '1. doz', thenEveryDays: 365 }, { label: '2. doz', afterPrevWeeks: 3 }],
    })
    expect(r.status).toBe(400)
  })
})

describe('aşı uygula (S-50)', () => {
  it('kuduz: kaydeder, sonraki planı ve PETVET VACCINE görevini açar', async () => {
    const a = await makeAnimal({ tckn: true })
    const pre = await t.api<VaccinePreviewDto>('GET', `/api/vaccines/preview?animalId=${a.animalId}&kind=rabies&productId=${prod('Rabisin').id}`)
    expect(pre.status).toBe(200)
    expect(pre.data.doseLabel).toBe('1. doz')
    expect(pre.data.nextDueDate).toBe(addDaysIso(TEST_TODAY, 364))
    expect(pre.data.petvetTask).toBe(true)

    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', rabies(a.animalId))
    expect(r.status).toBe(200)
    expect(r.data.nextDueDate).toBe(addDaysIso(TEST_TODAY, 52 * 7))
    expect(r.data.petvetStatus).toBe('pending')

    const task = await t.backend.db.$client.query(`select kind, due_date, source_type from petvet_tasks where id = $1`, [r.data.petvetTaskId])
    expect(task.rows[0]).toMatchObject({ kind: 'VACCINE', due_date: addDaysIso(TEST_TODAY, 15), source_type: 'vaccination' })

    const v = await animalVaccines(a.animalId)
    expect(v.vaccinations).toHaveLength(1)
    expect(v.vaccinations[0]).toMatchObject({ doseLabel: '1. doz', lotNo: 'R2231', petvetStatus: 'pending' })
    expect(v.plans.filter((p) => p.status === 'planned')).toHaveLength(1)
    expect(v.plans[0].doseLabel).toBe('Yıllık rapel')
  })

  it('sahipte TCKN yoksa görev eksik bilgi açılır', async () => {
    const a = await makeAnimal()
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', rabies(a.animalId))
    expect(r.data.petvetStatus).toBe('missing_info')
  })

  it('karma aşı için PETVET görevi açılmaz; doz sırası protokolden gelir ve açık plan kapanır', async () => {
    const a = await makeAnimal()
    const combo = { animalId: a.animalId, kind: 'combo', productId: prod('Purevax RCP').id, givenBy: t.adminId }
    const r1 = await t.api<VaccinateResult>('POST', '/api/vaccinations', { ...combo, givenAt: addDaysIso(TEST_TODAY, -21) })
    expect(r1.status).toBe(200)
    expect(r1.data.petvetTaskId).toBeNull()
    expect(r1.data.nextDueDate).toBe(TEST_TODAY) // 3 hafta sonra 2. doz

    const r2 = await t.api<VaccinateResult>('POST', '/api/vaccinations', { ...combo, givenAt: TEST_TODAY })
    expect(r2.status).toBe(200)
    expect(r2.data.nextDueDate).toBe(addDaysIso(TEST_TODAY, 28)) // kedi karma 3. doz +4 hafta
    const v = await animalVaccines(a.animalId)
    expect(v.vaccinations.map((x) => x.doseLabel)).toEqual(['2. doz', '1. doz'])
    expect(v.plans.find((p) => p.id === r1.data.nextPlanId)?.status).toBe('done')
    expect(v.plans.filter((p) => p.status === 'planned')).toHaveLength(1)
  })

  it('sonraki doz tarihi elle değiştirilebilir', async () => {
    const a = await makeAnimal()
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', rabies(a.animalId, { nextDueDate: '2027-09-01' }))
    expect(r.data.nextDueDate).toBe('2027-09-01')
  })

  it('kuduzda lot ve SKT zorunlu', async () => {
    const a = await makeAnimal()
    const noLot = await t.api<{ error: string }>('POST', '/api/vaccinations', rabies(a.animalId, { lotNo: undefined }))
    expect(noLot.status).toBe(400)
    expect(noLot.data.error).toContain('lot')
    const noExp = await t.api<{ error: string }>('POST', '/api/vaccinations', rabies(a.animalId, { expiryDate: undefined }))
    expect(noExp.status).toBe(400)
    expect(noExp.data.error).toContain('son kullanma')
    // karma aşıda lot zorunlu değil
    const combo = await t.api('POST', '/api/vaccinations', { animalId: a.animalId, kind: 'combo', productId: prod('Purevax RCP').id, givenAt: TEST_TODAY, givenBy: t.adminId })
    expect(combo.status).toBe(200)
  })

  it('SKT uygulama tarihinden önceyse engeller', async () => {
    const a = await makeAnimal()
    const r = await t.api<{ code: string }>('POST', '/api/vaccinations', rabies(a.animalId, { expiryDate: addDaysIso(TEST_TODAY, -1) }))
    expect(r.status).toBe(400)
    expect(r.data.code).toBe('EXPIRED')
  })

  it('minimum yaş altında uyarı verir (engellemez)', async () => {
    const young = await makeAnimal()
    await t.backend.db.$client.query(`update animals set birth_date = $2 where id = $1`, [young.animalId, addDaysIso(TEST_TODAY, -6 * 7)])
    const pre = await t.api<VaccinePreviewDto>('GET', `/api/vaccines/preview?animalId=${young.animalId}&kind=rabies`)
    expect(pre.data.warnings.join(' ')).toContain('en küçük yaş 12 hafta')
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', rabies(young.animalId))
    expect(r.status).toBe(200)
    expect(r.data.warnings.length).toBeGreaterThan(0)
  })

  it('ürün türü ve hayvan türü uyuşmalı; uygulayan hekim olmalı', async () => {
    const a = await makeAnimal()
    const wrongKind = await t.api('POST', '/api/vaccinations', rabies(a.animalId, { productId: prod('Purevax RCP').id }))
    expect(wrongKind.status).toBe(400)
    const dogOnly = await t.api('POST', '/api/vaccinations', { animalId: a.animalId, kind: 'combo', productId: prod('Nobivac DHPPi+L').id, givenAt: TEST_TODAY, givenBy: t.adminId })
    expect(dogOnly.status).toBe(400)
    const tech = await t.loginAs('tech')
    const notVet = await t.api('POST', '/api/vaccinations', rabies(a.animalId, { givenBy: tech.userId }))
    expect(notVet.status).toBe(400)
  })

  it('teknisyen (hekim seçerek) uygulayabilir, sekreter uygulayamaz', async () => {
    const a = await makeAnimal()
    const sec = await t.loginAs('secretary')
    expect((await t.api('POST', '/api/vaccinations', rabies(a.animalId), sec.token)).status).toBe(403)
    const tech = await t.loginAs('tech')
    expect((await t.api('POST', '/api/vaccinations', rabies(a.animalId), tech.token)).status).toBe(200)
  })

  it('ölü hayvanda uygulama kaydedilir ama plan oluşmaz', async () => {
    const a = await makeAnimal()
    await t.backend.db.$client.query(`update animals set status = 'dead' where id = $1`, [a.animalId])
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', { animalId: a.animalId, kind: 'combo', productId: prod('Purevax RCP').id, givenAt: TEST_TODAY, givenBy: t.adminId })
    expect(r.status).toBe(200)
    expect(r.data.nextPlanId).toBeNull()
  })

  it('hatalı kayıt silinince PETVET görevi iptal olur', async () => {
    const a = await makeAnimal({ tckn: true })
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', rabies(a.animalId))
    const d = await t.api('POST', `/api/vaccinations/${r.data.id}/delete`, { reason: 'Yanlış hayvana girildi' })
    expect(d.status).toBe(200)
    const task = await t.backend.db.$client.query(`select status from petvet_tasks where id = $1`, [r.data.petvetTaskId])
    expect(task.rows[0].status).toBe('cancelled')
    const v = await animalVaccines(a.animalId)
    expect(v.vaccinations).toHaveLength(0)
  })
})

describe('plan işlemleri ve takvim (S-51)', () => {
  let overdueAnimal: string
  let overduePlan: string

  beforeAll(async () => {
    // Doğumdan 8 hafta sonrası 6 gün önce → kedi karma 1. doz 6 gün gecikmiş
    const a = await makeAnimal({ name: 'Fıstık' })
    overdueAnimal = a.animalId
    await t.backend.db.$client.query(`update animals set birth_date = $2 where id = $1`, [a.animalId, addDaysIso(TEST_TODAY, -8 * 7 - 6)])
    const r = await t.api<{ plans: { id: string; dueDate: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'combo' })
    expect(r.status).toBe(200)
    overduePlan = r.data.plans[0].id
    expect(r.data.plans[0].dueDate).toBe(addDaysIso(TEST_TODAY, -6))
  })

  it('gecikmiş filtresi planı gösterir, 30+ göstermez', async () => {
    const c = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=overdue')
    expect(c.status).toBe(200)
    const row = c.data.items.find((i) => i.planId === overduePlan)
    expect(row).toMatchObject({ animalName: 'Fıstık', daysLeft: -6, kind: 'combo', doseLabel: '1. doz' })
    expect(c.data.counts.overdue).toBeGreaterThanOrEqual(1)
    const c30 = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=overdue30')
    expect(c30.data.items.some((i) => i.planId === overduePlan)).toBe(false)
    // hatırlatma tablosu yoksa başarısız filtresi boş
    const f = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=failed')
    expect(f.status).toBe(200)
    if (!f.data.remindersAvailable) expect(f.data.items).toHaveLength(0)
  })

  it('hatırlatma başarısız filtresi (reminders tablosu varsa)', async () => {
    const c = t.backend.db.$client
    const reg = await c.query(`select to_regclass('reminders')::text as t`)
    if (!reg.rows[0].t) return
    const a = await makeAnimal({ name: 'Mia' })
    const r = await t.api<{ plans: { id: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'felv' })
    const planId = r.data.plans[0].id
    await c.query(
      `insert into reminders (kind, owner_id, animal_id, source_type, source_id, channel, template_key, send_at, status, last_error)
       values ('vaccine', $1, $2, 'vaccination_plan', $3, 'sms', 'vaccine', now(), 'failed', 'bakiye')`,
      [a.ownerId, a.animalId, planId],
    )
    const f = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=failed')
    expect(f.data.remindersAvailable).toBe(true)
    const row = f.data.items.find((i) => i.planId === planId)
    expect(row?.reminder).toMatchObject({ state: 'failed', error: 'bakiye' })
    expect(f.data.items.some((i) => i.planId === overduePlan)).toBe(false)
  })

  it('bu hafta / bu ay / tür filtresi', async () => {
    const a = await makeAnimal({ name: 'Paşa', species: 'dog' })
    await t.backend.db.$client.query(`update animals set birth_date = $2 where id = $1`, [a.animalId, addDaysIso(TEST_TODAY, -12 * 7 + 2)])
    const r = await t.api<{ plans: { id: string; dueDate: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'rabies' })
    const planId = r.data.plans[0].id
    expect(r.data.plans[0].dueDate).toBe(addDaysIso(TEST_TODAY, 2)) // 29.10 → bu hafta (26.10–01.11)
    const week = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=week')
    expect(week.data.items.some((i) => i.planId === planId)).toBe(true)
    const month = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=month&kind=rabies&species=dog')
    expect(month.data.items.map((i) => i.planId)).toContain(planId)
    expect(month.data.items.every((i) => i.kind === 'rabies' && i.species === 'dog')).toBe(true)
    const cats = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=month&species=cat')
    expect(cats.data.items.some((i) => i.planId === planId)).toBe(false)
  })

  it('ertele: yeni vade, durum ertelendi; geçmiş tarih reddedilir', async () => {
    const bad = await t.api('POST', `/api/vaccination-plans/${overduePlan}/postpone`, { dueDate: addDaysIso(TEST_TODAY, -1) })
    expect(bad.status).toBe(400)
    const sec = await t.loginAs('secretary')
    const r = await t.api('POST', `/api/vaccination-plans/${overduePlan}/postpone`, { dueDate: addDaysIso(TEST_TODAY, 10), reason: 'Sahip tatilde' }, sec.token)
    expect(r.status).toBe(200)
    const v = await animalVaccines(overdueAnimal)
    expect(v.plans.find((p) => p.id === overduePlan)).toMatchObject({ status: 'postponed', dueDate: addDaysIso(TEST_TODAY, 10) })
    const c = await t.api<CalendarDto>('GET', '/api/vaccine-calendar?filter=overdue')
    expect(c.data.items.some((i) => i.planId === overduePlan)).toBe(false)
  })

  it('uygula: ertelenmiş plan kapanır', async () => {
    const r = await t.api<VaccinateResult>('POST', '/api/vaccinations', {
      animalId: overdueAnimal,
      kind: 'combo',
      productId: prod('Purevax RCP').id,
      givenAt: TEST_TODAY,
      givenBy: t.adminId,
      planId: overduePlan,
    })
    expect(r.status).toBe(200)
    const v = await animalVaccines(overdueAnimal)
    expect(v.plans.find((p) => p.id === overduePlan)?.status).toBe('done')
    expect(v.plans.find((p) => p.id === r.data.nextPlanId)).toMatchObject({ status: 'planned', doseLabel: '2. doz' })
  })

  it('iptal: neden zorunlu; kapalı plan tekrar iptal edilemez', async () => {
    const a = await makeAnimal()
    const r = await t.api<{ plans: { id: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'felv' })
    const id = r.data.plans[0].id
    expect((await t.api('POST', `/api/vaccination-plans/${id}/cancel`, {})).status).toBe(400)
    expect((await t.api('POST', `/api/vaccination-plans/${id}/cancel`, { reason: 'Sahip istemiyor' })).status).toBe(200)
    expect((await t.api('POST', `/api/vaccination-plans/${id}/cancel`, { reason: 'Tekrar' })).status).toBe(409)
    const v = await animalVaccines(a.animalId)
    expect(v.plans.find((p) => p.id === id)).toMatchObject({ status: 'cancelled', reason: 'Sahip istemiyor' })
  })

  it('başka klinikte yaptırıldı: dış kayıt, PETVET görevi yok, sonraki plan', async () => {
    const a = await makeAnimal({ tckn: true })
    const r = await t.api<{ plans: { id: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'rabies' })
    const id = r.data.plans[0].id
    const x = await t.api<VaccinateResult>('POST', `/api/vaccination-plans/${id}/external`, { givenAt: addDaysIso(TEST_TODAY, -3), productName: 'Bilinmiyor', externalClinic: 'Başka Klinik' })
    expect(x.status).toBe(200)
    expect(x.data.petvetTaskId).toBeNull()
    const v = await animalVaccines(a.animalId)
    expect(v.plans.find((p) => p.id === id)?.status).toBe('external')
    expect(v.vaccinations[0]).toMatchObject({ external: true, externalClinic: 'Başka Klinik' })
    expect(v.plans.some((p) => p.status === 'planned')).toBe(true)
  })

  it('protokol değiştir: plan yeni protokolle kurulur', async () => {
    const a = await makeAnimal({ species: 'dog' })
    await t.api<VaccinateResult>('POST', '/api/vaccinations', { animalId: a.animalId, kind: 'combo', productId: prod('Nobivac DHPPi+L').id, givenAt: TEST_TODAY, givenBy: t.adminId })
    const p = await t.api<VaccineProtocol>('POST', '/api/vaccine-protocols', {
      species: 'dog',
      kind: 'combo',
      name: 'Köpek karma kısa',
      steps: [{ label: '1. doz', minAgeWeeks: 8 }, { label: '2. doz', afterPrevWeeks: 4 }],
    })
    expect(p.status).toBe(200)
    const r = await t.api<{ dueDate: string }>('POST', `/api/animals/${a.animalId}/vaccine-protocol`, { kind: 'combo', protocolId: p.data.id })
    expect(r.status).toBe(200)
    expect(r.data.dueDate).toBe(addDaysIso(TEST_TODAY, 28))
    const v = await animalVaccines(a.animalId)
    expect(v.protocols.combo).toMatchObject({ protocolId: p.data.id, custom: true })
    expect(v.plans.filter((x) => x.status === 'planned')).toHaveLength(1)
    // kedi protokolü köpeğe atanamaz
    const cat = (await t.api<VaccineProtocol[]>('GET', '/api/vaccine-protocols?species=cat&kind=combo')).data[0]
    expect((await t.api('POST', `/api/animals/${a.animalId}/vaccine-protocol`, { kind: 'combo', protocolId: cat.id })).status).toBe(400)
  })

  it('toplu hatırlatma: mesaj izni ister', async () => {
    const tech = await t.loginAs('tech')
    const a = await makeAnimal()
    const r = await t.api<{ plans: { id: string }[] }>('POST', `/api/animals/${a.animalId}/vaccine-plan/recalculate`, { kind: 'combo' })
    const ids = r.data.plans.map((p) => p.id)
    expect((await t.api('POST', '/api/vaccination-plans/remind', { planIds: ids }, tech.token)).status).toBe(403)
    const ok = await t.api<{ queued: number }>('POST', '/api/vaccination-plans/remind', { planIds: ids })
    expect(ok.status).toBe(200)
    expect(ok.data.queued).toBe(1)
  })
})
