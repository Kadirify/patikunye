//  testleri: sahipler (CRUD, iyimser kilit, TCKN, birleştirme, silme, CSV) ve hayvan işlemleri
// (form, durum değişiklikleri, PETVET görevleri, çip uygula/düzelt, izinler)
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, type TestBackend } from './test-helpers'
import type { AnimalListRow, AnimalDetailFull, OwnerDetail, OwnerListResult, StatusResult, ChipActionResult, TimelineRow, OwnershipRow, HistoryRow } from '../shared/owners'
import type { PetvetTaskListItem } from '../shared/api-types'

let t: TestBackend
let secretary: { token: string; userId: string }
let tech: { token: string; userId: string }

const owner = (o: Record<string, unknown> = {}) => ({
  firstName: 'mehmet',
  lastName: 'yılmaz',
  phone: '0532 111 22 33',
  city: 'Ankara',
  district: 'Çankaya',
  kvkkNotice: true,
  kvkkMethod: 'printed',
  reminderConsent: true,
  marketingConsent: false,
  tags: ['VIP'],
  ...o,
})
const animal = (ownerId: string, a: Record<string, unknown> = {}) => ({
  ownerId,
  name: 'boncuk',
  species: 'dog',
  breed: 'Golden',
  sex: 'male',
  neutered: false,
  birthDate: '2025-01-10',
  birthDateEstimated: false,
  color: 'Sarı',
  allergies: ['Penisilin'],
  chronicDiseases: [],
  behavior: 'shy',
  source: 'purchase',
  weightKg: 12.5,
  ...a,
})

async function createOwner(o: Record<string, unknown> = {}) {
  const r = await t.api<{ id: string }>('POST', '/api/owners', owner(o))
  expect(r.status, JSON.stringify(r.data)).toBe(200)
  return r.data.id
}
async function getOwner(id: string) {
  return (await t.api<OwnerDetail>('GET', `/api/owners/${id}`)).data
}
async function getAnimal(id: string) {
  return (await t.api<AnimalDetailFull>('GET', `/api/animals/${id}`)).data
}
async function tasksOf(animalId: string) {
  return (await getAnimal(animalId)).petvetTasks as PetvetTaskListItem[]
}

beforeAll(async () => {
  t = await startTestBackend()
  secretary = await t.loginAs('secretary')
  tech = await t.loginAs('tech')
}, 120_000)

afterAll(async () => {
  await t?.stop()
}, 60_000)

describe('sahipler', () => {
  let ownerId = ''

  it('yeni sahip: ad büyük harfle, rıza geçmişi yazılır', async () => {
    ownerId = await createOwner({ tckn: '10000000146' })
    const o = await getOwner(ownerId)
    expect(o).toMatchObject({ firstName: 'Mehmet', lastName: 'Yılmaz', phone: '+905321112233', tcknLast4: '0146', hasTckn: true, tags: ['VIP'], version: 1 })
    expect(o.consents.map((c) => `${c.type}:${c.granted}`).sort()).toEqual(['kvkk_notice:true', 'marketing:false', 'reminder:true'])
    expect(o.consents[0].textVersion).toBeTruthy()
  })

  it('doğrulama: aydınlatma olmadan, geçersiz telefon / TCKN reddedilir', async () => {
    expect((await t.api('POST', '/api/owners', owner({ kvkkNotice: false }))).status).toBe(400)
    expect((await t.api('POST', '/api/owners', owner({ phone: '0212 111 22 33' }))).status).toBe(400)
    expect((await t.api('POST', '/api/owners', owner({ tckn: '12345678951' }))).status).toBe(400)
    const dup = await t.api<{ code: string; details: { ownerId: string } }>('POST', '/api/owners', owner({ tckn: '10000000146' }))
    expect(dup.status).toBe(409)
    expect(dup.data.code).toBe('DUPLICATE_TCKN')
    expect(dup.data.details.ownerId).toBe(ownerId)
  })

  it('aynı telefon/TCKN kontrolü', async () => {
    const r = await t.api<{ tcknOwner: { id: string } | null; phoneOwners: { id: string }[] }>('GET', '/api/owners/check?tckn=10000000146&phone=05321112233')
    expect(r.data.tcknOwner?.id).toBe(ownerId)
    expect(r.data.phoneOwners.map((x) => x.id)).toContain(ownerId)
    const ex = await t.api<{ tcknOwner: unknown }>('GET', `/api/owners/check?tckn=10000000146&exclude=${ownerId}`)
    expect(ex.data.tcknOwner).toBeNull()
  })

  it('düzenleme: sürüm artar, eski sürümle kaydetme 409 VERSION_CONFLICT', async () => {
    const r1 = await t.api<{ version: number }>('PUT', `/api/owners/${ownerId}`, owner({ version: 1, city: 'İzmir', district: 'Konak', marketingConsent: true }))
    expect(r1.status, JSON.stringify(r1.data)).toBe(200)
    expect(r1.data.version).toBe(2)
    const stale = await t.api<{ code: string }>('PUT', `/api/owners/${ownerId}`, owner({ version: 1 }))
    expect(stale.status).toBe(409)
    expect(stale.data.code).toBe('VERSION_CONFLICT')
    const o = await getOwner(ownerId)
    expect(o).toMatchObject({ city: 'İzmir', version: 2, tcknLast4: '0146' }) // TCKN boş gönderildi -> değişmedi
    expect(o.marketingConsentAt).toBeTruthy()
    expect(o.consents.filter((c) => c.type === 'marketing').map((c) => c.granted)).toEqual([true, false])
  })

  it('TCKN değişikliği şifreli saklanır, düz metin audit’e yazılmaz', async () => {
    const r = await t.api('PUT', `/api/owners/${ownerId}`, owner({ version: 2, city: 'İzmir', district: 'Konak', marketingConsent: true, tckn: '12345678950' }))
    expect(r.status).toBe(200)
    const row = await t.backend.db.$client.query('select tckn_enc, tckn_last4 from owners where id = $1', [ownerId])
    expect(row.rows[0].tckn_enc).not.toContain('12345678950')
    expect(row.rows[0].tckn_last4).toBe('8950')
    const logs = await t.backend.db.$client.query(`select diff::text as d from audit_logs where entity = 'owner' and entity_id = $1`, [ownerId])
    expect(logs.rows.some((x) => x.d?.includes('12345678950'))).toBe(false)
  })

  it('TCKN tam görüntüleme izne bağlı ve denetim kaydına yazılır', async () => {
    const before = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'view_sensitive' and entity_id = $1`, [ownerId])
    const r = await t.api<{ tckn: string }>('POST', `/api/owners/${ownerId}/tckn/reveal`)
    expect(r.data.tckn).toBe('12345678950')
    const after = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'view_sensitive' and entity_id = $1`, [ownerId])
    expect(after.rows[0].n).toBe(before.rows[0].n + 1)
    expect((await t.api('POST', `/api/owners/${ownerId}/tckn/reveal`, undefined, tech.token)).status).toBe(403)
    expect((await t.api('POST', `/api/owners/${ownerId}/tckn/reveal`, undefined, secretary.token)).status).toBe(200)
  })

  it('liste filtreleri ve geçmiş', async () => {
    await createOwner({ firstName: 'Zeynep', lastName: 'Kara', phone: '05339998877', city: 'Ankara', tags: ['Barınak'], marketingConsent: false })
    const all = await t.api<OwnerListResult>('GET', '/api/owners/list')
    expect(all.data.total).toBeGreaterThanOrEqual(2)
    const izmir = await t.api<OwnerListResult>('GET', '/api/owners/list?city=izmir')
    expect(izmir.data.items.map((x) => x.id)).toEqual([ownerId])
    const mk = await t.api<OwnerListResult>('GET', '/api/owners/list?marketing=1')
    expect(mk.data.items.map((x) => x.id)).toEqual([ownerId])
    const tag = await t.api<OwnerListResult>('GET', '/api/owners/list?tag=Bar%C4%B1nak')
    expect(tag.data.items.map((x) => x.fullName)).toEqual(['Zeynep Kara'])
    const byText = await t.api<OwnerListResult>('GET', '/api/owners/list?q=yilmaz')
    expect(byText.data.items[0].id).toBe(ownerId)
    const h = await t.api<HistoryRow[]>('GET', `/api/owners/${ownerId}/history`)
    expect(h.data.map((x) => x.action)).toEqual(expect.arrayContaining(['create', 'update', 'view_sensitive']))
    // basit arama (hızlı kayıt) dizi döndürür
    const simple = await t.api<unknown[]>('GET', '/api/owners?q=zeynep')
    expect(Array.isArray(simple.data)).toBe(true)
  })

  it('CSV dışa aktarma: yalnız owners.export, audit "export"', async () => {
    const r = await t.api<string>('GET', '/api/owners/export.csv')
    expect(r.status).toBe(200)
    expect(r.data).toContain('Mehmet Yılmaz')
    expect(r.data).not.toContain('12345678950')
    const log = await t.backend.db.$client.query(`select count(*)::int as n from audit_logs where action = 'export' and entity = 'owner'`)
    expect(log.rows[0].n).toBe(1)
    expect((await t.api('GET', '/api/owners/export.csv', undefined, secretary.token)).status).toBe(403)
  })

  it('aktif hayvanı olan sahip silinemez; olmayan silinir (yalnız yönetici)', async () => {
    const reg = await t.registerAnimal()
    expect((await t.api<{ code: string }>('DELETE', `/api/owners/${reg.ownerId}`)).data.code).toBe('HAS_ACTIVE_ANIMALS')
    const lonely = await createOwner({ firstName: 'Silinecek', lastName: 'Kişi', phone: '05350000001' })
    expect((await t.api('DELETE', `/api/owners/${lonely}`, undefined, secretary.token)).status).toBe(403)
    expect((await t.api('DELETE', `/api/owners/${lonely}`)).status).toBe(200)
    expect((await t.api('GET', `/api/owners/${lonely}`)).status).toBe(404)
  })

  it('birleştirme: alan seçimi, hayvanlar ve PETVET görevleri taşınır, eski kayıt silinir', async () => {
    // Mükerrer: TCKN'siz sahibin hayvanı (eksik bilgili görev)
    const dupReg = await t.registerAnimal({ name: 'Tarçın' })
    const dupOwnerId = dupReg.ownerId
    expect(dupReg.petvetStatus).toBe('missing_info')
    const keep = await createOwner({ firstName: 'Ayşe', lastName: 'Demir', phone: '05351234567', tckn: '10000000078' })
    expect((await t.api('POST', `/api/owners/${keep}/merge`, { otherId: dupOwnerId }, secretary.token)).status).toBe(403)
    const r = await t.api<{ movedAnimals: number }>('POST', `/api/owners/${keep}/merge`, { otherId: dupOwnerId, pick: { phone: 'other', city: 'other' } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.movedAnimals).toBe(1)
    const k = await getOwner(keep)
    expect(k.animals.map((a) => a.name)).toEqual(['Tarçın'])
    expect(k.firstName).toBe('Ayşe')
    expect(k.tcknLast4).toBe('0078')
    const gone = await t.api<{ details: { mergedInto: string } }>('GET', `/api/owners/${dupOwnerId}`)
    expect(gone.status).toBe(404)
    expect(gone.data.details.mergedInto).toBe(keep)
    // Görev yeni sahibe taşındı ve TCKN artık var -> bekliyor
    const task = (await tasksOf(dupReg.animalId))[0]
    expect(task).toMatchObject({ ownerName: 'Ayşe Demir', status: 'pending' })
  })
})

describe('hayvanlar', () => {
  let ownerId = ''
  let animalId = ''

  beforeAll(async () => {
    ownerId = await createOwner({ firstName: 'Hayvan', lastName: 'Sahibi', phone: '05361112233', tckn: '10000000214' })
  })

  it('çipsiz hayvan kaydı; doğrulamalar', async () => {
    expect((await t.api('POST', '/api/animals', animal(ownerId, { color: '' }))).status).toBe(400) // köpekte renk zorunlu
    expect((await t.api('POST', '/api/animals', animal(ownerId, { birthDate: '2027-01-01' }))).status).toBe(400)
    expect((await t.api('POST', '/api/animals', animal(ownerId, { source: 'adoption' }))).status).toBe(400)
    const r = await t.api<{ id: string }>('POST', '/api/animals', animal(ownerId))
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    animalId = r.data.id
    const a = await getAnimal(animalId)
    expect(a).toMatchObject({ name: 'Boncuk', chips: [], allergies: ['Penisilin'], behavior: 'shy', version: 1, lastWeight: { kg: 12.5 } })
    expect(a.owners[0].id).toBe(ownerId)
  })

  it('liste filtreleri: çipsiz, 6 aydan büyük ve çipsiz, tür', async () => {
    const chipless = await t.api<AnimalListRow[]>('GET', '/api/animals?chip=no')
    expect(chipless.data.map((x) => x.id)).toContain(animalId)
    const risk = await t.api<AnimalListRow[]>('GET', '/api/animals?risk6m=1')
    expect(risk.data.map((x) => x.id)).toContain(animalId)
    const cats = await t.api<AnimalListRow[]>('GET', '/api/animals?species=cat')
    expect(cats.data.map((x) => x.id)).not.toContain(animalId)
    const pending = await t.api<AnimalListRow[]>('GET', '/api/animals?petvet=open')
    expect(pending.data.every((x) => x.petvet)).toBe(true)
  })

  it('düzenleme: iyimser kilit, ek alanlar', async () => {
    const body = { ...animal(ownerId), version: 1, chronicDiseases: ['Kalça displazisi'], bloodGroup: 'DEA 1.1+', diet: 'Tahılsız', notes: 'Not' }
    const r = await t.api<{ version: number }>('PUT', `/api/animals/${animalId}`, body)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect((await t.api<{ code: string }>('PUT', `/api/animals/${animalId}`, body)).data.code).toBe('VERSION_CONFLICT')
    expect(await getAnimal(animalId)).toMatchObject({ chronicDiseases: ['Kalça displazisi'], bloodGroup: 'DEA 1.1+', diet: 'Tahılsız', version: 2 })
  })

  it('kilo: ±%30 farkta onay ister', async () => {
    const big = await t.api<{ code: string }>('POST', `/api/animals/${animalId}/weights`, { kg: 25 })
    expect(big.data.code).toBe('CONFIRM_REQUIRED')
    expect((await t.api('POST', `/api/animals/${animalId}/weights`, { kg: 25, confirm: true })).status).toBe(200)
    expect((await t.api('POST', `/api/animals/${animalId}/weights`, { kg: 200 })).status).toBe(400)
    const w = await t.api<{ kg: number }[]>('GET', `/api/animals/${animalId}/weights`)
    expect(w.data.map((x) => x.kg)).toEqual([25, 12.5])
  })

  it('çip uygula: izin, doğrulama, CHIP_NEW görevi', async () => {
    const body = { chipNo: '792 091 555 000 001', date: '2026-10-25', vetId: t.adminId, bodySite: 'Boyun sol', verified: true }
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, body, secretary.token)).status).toBe(403)
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, { ...body, verified: false })).status).toBe(400)
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, { ...body, chipNo: '79209155500' })).status).toBe(400)
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, { ...body, vetId: tech.userId })).status).toBe(400)
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, { ...body, bodySite: 'Göğüs' })).status).toBe(400) // neden zorunlu
    const r = await t.api<ChipActionResult>('POST', `/api/animals/${animalId}/chips`, body)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data).toMatchObject({ petvetKind: 'CHIP_NEW', petvetStatus: 'pending', dueDate: '2026-11-09' })
    // ikinci kez "ikinci çip" demeden olmaz; başka hayvandaki çip engellenir
    expect((await t.api<{ code: string }>('POST', `/api/animals/${animalId}/chips`, { ...body, chipNo: '792091555000002' })).data.code).toBe('HAS_CHIP')
    const other = await t.registerAnimal()
    const otherChip = (await getAnimal(other.animalId)).chips[0].chipNo
    const clash = await t.api<{ code: string; details: { animalId: string } }>('POST', `/api/animals/${animalId}/chips`, { ...body, chipNo: otherChip, second: true })
    expect(clash.data.code).toBe('CHIP_EXISTS')
    expect(clash.data.details.animalId).toBe(other.animalId)
  })

  it('15 günden eski uygulama uyarı verir', async () => {
    const id = (await t.api<{ id: string }>('POST', '/api/animals', animal(ownerId, { name: 'Eski', species: 'rabbit', color: '' }))).data.id
    const r = await t.api<ChipActionResult>('POST', `/api/animals/${id}/chips`, {
      chipNo: '792091555000099', date: '2026-09-01', vetId: t.adminId, bodySite: 'Boyun sol', verified: true,
    })
    expect(r.status).toBe(200)
    expect(r.data.warnings?.join(' ')).toContain('15 günden eski')
    expect(r.data.petvetTaskId).toBeNull() // tavşan PETVET kapsamında değil
  })

  it('çip düzelt: eski kayıt corrected, CORRECTION olayı; girilmişse UPDATE görevi', async () => {
    const a = await getAnimal(animalId)
    const chipId = a.chips[0].id
    const task = a.petvetTasks.find((x) => x.kind === 'CHIP_NEW')!
    expect((await t.api('POST', `/api/chips/${chipId}/correct`, { newChipNo: '792091555000003', reason: 'Yanlış yazıldı' }, secretary.token)).status).toBe(403)
    expect((await t.api('POST', `/api/chips/${chipId}/correct`, { newChipNo: '792091555000003', reason: '' })).status).toBe(400)
    // Görev henüz girilmedi -> UPDATE açılmaz, görev yeni çipe bağlanır
    const r1 = await t.api<ChipActionResult>('POST', `/api/chips/${chipId}/correct`, { newChipNo: '792091555000003', reason: 'Yanlış yazıldı' })
    expect(r1.status, JSON.stringify(r1.data)).toBe(200)
    expect(r1.data.petvetTaskId).toBeNull()
    const a2 = await getAnimal(animalId)
    expect(a2.chipsFull.map((c) => `${c.chipNo}:${c.status}`)).toEqual(['792091555000001:corrected', '792091555000003:active'])
    expect(a2.chipEvents[0]).toMatchObject({ kind: 'CORRECTION', chipNo: '792091555000003' })
    // Eski numara artık bulunmaz
    const look = await t.api<{ match: unknown }>('GET', '/api/chips/lookup?no=792091555000001')
    expect(look.data.match).toBeNull()
    // Görevi "girildi" yap, tekrar düzelt -> UPDATE
    expect((await t.api('POST', `/api/petvet/tasks/${task.id}/done`, { petvetRef: 'X1' })).status).toBe(200)
    const r2 = await t.api<ChipActionResult>('POST', `/api/chips/${r1.data.chipId}/correct`, { newChipNo: '792091555000004', reason: 'Yine yanlış' })
    expect(r2.data).toMatchObject({ petvetKind: 'UPDATE', petvetStatus: 'pending' })
  })

  it('ikinci çip: eski çip pasif, aramada bulunur', async () => {
    const r = await t.api<ChipActionResult>('POST', `/api/animals/${animalId}/chips`, {
      chipNo: '792091555000005', date: '2026-10-27', vetId: t.adminId, bodySite: 'Boyun sol', verified: true, second: true,
    })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.petvetKind).toBe('UPDATE') // önceki çip PETVET'e girilmişti
    const a = await getAnimal(animalId)
    expect(a.chipsFull.filter((c) => c.status === 'active').map((c) => c.chipNo)).toEqual(['792091555000005'])
    expect(a.chipsFull.find((c) => c.chipNo === '792091555000004')?.status).toBe('inactive')
    const look = await t.api<{ match: { animal: { id: string } } | null }>('GET', '/api/chips/lookup?no=792091555000004')
    expect(look.data.match?.animal.id).toBe(animalId)
  })

  it('kayıp -> bulundu: açık LOST görevi iptal, FOUND açılmaz', async () => {
    expect((await t.api('POST', `/api/animals/${animalId}/lost`, { date: '2026-10-26' }, tech.token)).status).toBe(403)
    const lost = await t.api<StatusResult>('POST', `/api/animals/${animalId}/lost`, { date: '2026-10-26', city: 'Ankara', place: 'Park' }, secretary.token)
    expect(lost.status, JSON.stringify(lost.data)).toBe(200)
    expect(lost.data).toMatchObject({ petvetKind: 'LOST', petvetStatus: 'pending', dueDate: '2026-11-02' })
    expect((await getAnimal(animalId)).status).toBe('lost')
    expect((await t.api('POST', `/api/animals/${animalId}/lost`, { date: '2026-10-26' })).status).toBe(409)
    const found = await t.api<StatusResult & { cancelledTasks: number }>('POST', `/api/animals/${animalId}/found`, { date: '2026-10-27' }, secretary.token)
    expect(found.data).toMatchObject({ cancelledTasks: 1, petvetTaskId: null })
    expect((await getAnimal(animalId)).status).toBe('active')
    const lostTask = (await tasksOf(animalId)).find((x) => x.kind === 'LOST')
    expect(lostTask?.status).toBe('cancelled')
  })

  it('kayıp PETVET’e girilmişse bulununca FOUND görevi açılır', async () => {
    const lost = await t.api<StatusResult>('POST', `/api/animals/${animalId}/lost`, { date: '2026-10-27' })
    expect((await t.api('POST', `/api/petvet/tasks/${lost.data.petvetTaskId}/done`, {})).status).toBe(200)
    const found = await t.api<StatusResult>('POST', `/api/animals/${animalId}/found`, { date: '2026-10-27' })
    expect(found.data).toMatchObject({ petvetKind: 'FOUND', petvetStatus: 'pending' })
  })

  it('devir: eski sahiplik kapanır, TRANSFER görevi yeni sahip adına', async () => {
    const newOwner = await createOwner({ firstName: 'Yeni', lastName: 'Sahip', phone: '05371112233' }) // TCKN yok
    expect((await t.api('POST', `/api/animals/${animalId}/transfer`, { date: '2026-10-27', newOwnerId: ownerId })).status).toBe(400) // zaten sahibi
    const r = await t.api<StatusResult>('POST', `/api/animals/${animalId}/transfer`, { date: '2026-10-27', newOwnerId: newOwner, reason: 'Taşınma' }, secretary.token)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data).toMatchObject({ petvetKind: 'TRANSFER', petvetStatus: 'missing_info' })
    const own = await t.api<OwnershipRow[]>('GET', `/api/animals/${animalId}/ownership`)
    expect(own.data.map((x) => `${x.ownerName}:${x.toDate ?? '-'}`)).toEqual(['Yeni Sahip:-', 'Hayvan Sahibi:2026-10-27'])
    expect(own.data[1].endReason).toBe('Taşınma')
    const prev = await getOwner(ownerId)
    expect(prev.animals.find((a) => a.id === animalId)?.toDate).toBe('2026-10-27')
  })

  it('ölüm: sekreter yapamaz; geri alınamaz onayı; DEATH görevi; sonra durum değişmez', async () => {
    expect((await t.api('POST', `/api/animals/${animalId}/death`, { date: '2026-10-27', cause: 'disease', confirm: true }, secretary.token)).status).toBe(403)
    expect((await t.api('POST', `/api/animals/${animalId}/death`, { date: '2026-10-27', cause: 'disease', confirm: false })).status).toBe(400)
    expect((await t.api('POST', `/api/animals/${animalId}/death`, { date: '2024-01-01', cause: 'disease', confirm: true })).status).toBe(400) // doğumdan önce
    const r = await t.api<StatusResult>('POST', `/api/animals/${animalId}/death`, { date: '2026-10-27', cause: 'euthanasia', note: 'Onam alındı', confirm: true })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data).toMatchObject({ petvetKind: 'DEATH', dueDate: '2026-11-26' })
    expect((await getAnimal(animalId)).status).toBe('dead')
    expect((await t.api('POST', `/api/animals/${animalId}/lost`, { date: '2026-10-27' })).status).toBe(409)
    expect((await t.api('POST', `/api/animals/${animalId}/chips`, { chipNo: '792091555000006', date: '2026-10-27', vetId: t.adminId, bodySite: 'Boyun sol', verified: true, second: true })).status).toBe(409)
    const dead = await t.api<AnimalListRow[]>('GET', '/api/animals?status=dead')
    expect(dead.data.map((x) => x.id)).toContain(animalId)
  })

  it('zaman çizelgesi ve geçmiş', async () => {
    const tl = await t.api<TimelineRow[]>('GET', `/api/animals/${animalId}/timeline`)
    const kinds = new Set(tl.data.map((x) => x.kind))
    expect([...kinds]).toEqual(expect.arrayContaining(['chip', 'status', 'petvet', 'weight', 'create']))
    expect(tl.data.some((x) => x.title === 'Ölüm kaydı' && x.detail.includes('Ötanazi'))).toBe(true)
    const h = await t.api<HistoryRow[]>('GET', `/api/animals/${animalId}/history`)
    expect(h.data.length).toBeGreaterThan(5)
  })

  it('PETVET dışı tür ve çipsiz hayvanda durum değişikliği görev açmaz', async () => {
    const id = (await t.api<{ id: string }>('POST', '/api/animals', animal(ownerId, { name: 'Çipsiz', species: 'cat', color: 'Siyah' }))).data.id
    const r = await t.api<StatusResult>('POST', `/api/animals/${id}/lost`, { date: '2026-10-27' })
    expect(r.data.petvetTaskId).toBeNull()
  })
})
