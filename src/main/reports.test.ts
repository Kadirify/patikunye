// Raporlar ve yazdırma (Modül H) uçtan uca testleri + Code 128 birim testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, TEST_TODAY, type TestBackend } from './test-helpers'
import { CODE128_PATTERNS, code128Bars, encodeCode128B, reportToCsv, type ReportResult, type ReportsMetaDto } from '../shared/reports'

// Algoritmaya uyan örnek TCKN — hiçbir yanıtta tam hali görünmemeli
const TCKN = '10000000146'
const RANGE = 'from=2026-10-01&to=2026-10-31'

let t: TestBackend
let vet: { token: string; userId: string }
let tech: { token: string; userId: string }
let sec: { token: string; userId: string }
let a1: { animalId: string; ownerId: string }
let a2: { animalId: string; ownerId: string }
let visitId = ''
let visit2Id = ''
let apptId = ''
let kvkkId = ''

const db = () => t.backend.db.$client
const report = async (key: string, qs = RANGE, token?: string) => t.api<ReportResult>('GET', `/api/reports/${key}?${qs}`, undefined, token)
const table = (r: ReportResult, title: string) => {
  const tb = r.tables.find((x) => x.title.startsWith(title))
  if (!tb) throw new Error('Tablo yok: ' + title)
  return tb
}
const rowOf = (r: ReportResult, title: string, k: string, col = 'kind') => table(r, title).rows.find((x) => x[col] === k)!

async function insertAnimal(o: { name: string; species: string; birth: string | null; createdAt?: string; phone?: string }) {
  const owner = await db().query(`insert into owners (first_name, last_name, phone) values ($1, 'Arama', $2) returning id`, [
    o.name + 'Sahibi',
    o.phone ?? '+905301112233',
  ])
  const a = await db().query(`insert into animals (name, species, sex, birth_date, created_at) values ($1, $2, 'male', $3, $4) returning id`, [
    o.name,
    o.species,
    o.birth,
    o.createdAt ?? '2026-10-15T10:00:00+03:00',
  ])
  await db().query(`insert into animal_owners (animal_id, owner_id, is_primary, from_date) values ($1, $2, true, '2026-01-01')`, [a.rows[0].id, owner.rows[0].id])
  return a.rows[0].id as string
}

beforeAll(async () => {
  t = await startTestBackend({ now: () => new Date('2026-10-27T18:00:00+03:00') })
  vet = await t.loginAs('vet')
  tech = await t.loginAs('tech')
  sec = await t.loginAs('secretary')

  // --- Kimliklendirme: hızlı kayıtla iki çip (bugün, yönetici hekim)
  a1 = await t.registerAnimal({ name: 'Pamuk', species: 'cat', ownerTckn: TCKN, phone: '05321234567' })
  a2 = await t.registerAnimal({ name: 'Karabaş', species: 'dog' })
  await db().query(`update animals set created_at = '2026-10-15T10:00:00+03:00'`)

  // --- PETVET: biri zamanında girilmiş, biri süresi geçmiş (CHIP_NEW)
  await db().query(
    `insert into petvet_tasks (kind, animal_id, owner_id, vet_id, event_date, due_date, status, done_at, petvet_ref)
     values ('CHIP_NEW', $1, $2, $3, '2026-10-01', '2026-10-16', 'done', '2026-10-10T12:00:00+03:00', 'REF-1'),
            ('CHIP_NEW', $1, $2, $3, '2026-10-02', '2026-10-17', 'pending', null, null)`,
    [a1.animalId, a1.ownerId, t.adminId],
  )

  // --- Aşılar: API ile iki kuduz (aynı lot), biri hekim kullanıcısı tarafından
  const products = (await t.api<{ id: string; name: string }[]>('GET', '/api/vaccine-products')).data
  const rabisin = products.find((p) => p.name === 'Rabisin')!.id
  const v1 = await t.api('POST', '/api/vaccinations', { animalId: a1.animalId, kind: 'rabies', productId: rabisin, lotNo: 'R-777', expiryDate: '2027-06-30', givenAt: TEST_TODAY, givenBy: t.adminId })
  expect(v1.status, JSON.stringify(v1.data)).toBe(200)
  const v2 = await t.api('POST', '/api/vaccinations', { animalId: a2.animalId, kind: 'rabies', productId: rabisin, lotNo: 'R-777', expiryDate: '2027-06-30', givenAt: '2026-10-20', givenBy: vet.userId })
  expect(v2.status, JSON.stringify(v2.data)).toBe(200)

  // --- Aşı uyumu: vadesi geçmiş/yapılmamış (karma), zamanında (FeLV), geç (KC)
  const felv = await db().query(`insert into vaccinations (animal_id, kind, product_name, lot_no, given_at, given_by) values ($1, 'felv', 'Purevax FeLV', 'F-1', '2026-10-08', $2) returning id`, [a1.animalId, t.adminId])
  const kc = await db().query(`insert into vaccinations (animal_id, kind, product_name, lot_no, given_at, given_by) values ($1, 'kc', 'Nobivac KC', 'K-1', '2026-10-15', $2) returning id`, [a2.animalId, t.adminId])
  await db().query(
    `insert into vaccination_plans (animal_id, kind, dose_label, due_date, status, vaccination_id) values
       ($1, 'combo', '2. doz', '2026-10-05', 'planned', null),
       ($1, 'felv', '1. doz', '2026-10-10', 'done', $2),
       ($3, 'kc', '1. doz', '2026-10-12', 'done', $4)`,
    [a1.animalId, felv.rows[0].id, a2.animalId, kc.rows[0].id],
  )

  // --- Muayeneler: biri yönetici (Gastrit + iç not), biri hekim kullanıcısı
  const m1 = await t.api<{ id: string }>('POST', '/api/visits', {
    animalId: a1.animalId,
    visitAt: '2026-10-27T10:00:00+03:00',
    subjective: 'İki gündür kusma',
    diagnoses: ['Gastrit'],
    ownerAdvice: 'Hafif diyet',
    internalNote: 'GIZLI-IC-NOT',
    findings: { vitals: { temp: 38.6, weight: 4.2 }, systems: { sindirim: { status: 'abnormal', note: 'Karın hassas' } } },
    treatments: [{ drug: 'Maropitant', dose: 1, doseUnit: 'mg/kg', route: 'SC', frequency: 'Günde 1', duration: '3 gün', kind: 'prescribed' }],
  })
  expect(m1.status, JSON.stringify(m1.data)).toBe(200)
  visitId = m1.data.id
  const m2 = await t.api<{ id: string }>('POST', '/api/visits', {
    animalId: a2.animalId,
    vetId: vet.userId,
    visitAt: '2026-10-26T15:00:00+03:00',
    diagnoses: ['Gastrit', 'Otitis externa'],
  })
  expect(m2.status, JSON.stringify(m2.data)).toBe(200)
  visit2Id = m2.data.id

  // --- Çipsiz hayvanlar: uygun köpek, çok genç kedi (hariç), yetişkin tavşan (hariç)
  await insertAnimal({ name: 'Çipsiz', species: 'dog', birth: '2024-01-01', phone: '+905309998877' })
  await insertAnimal({ name: 'Yavru', species: 'cat', birth: '2026-08-01' })
  await insertAnimal({ name: 'Tavşan', species: 'rabbit', birth: '2023-01-01' })
  // 12 aydır gelmeyen (2024 kaydı, hiç ziyaret yok); çipli olsun ki çipsiz listesine girmesin
  const old = await insertAnimal({ name: 'Eski', species: 'cat', birth: null, createdAt: '2024-05-01T10:00:00+03:00' })
  await db().query(`insert into microchips (chip_no, format, animal_id, implanted_at, status) values ('792091999999999', 'iso', $1, '2024-05-01', 'active')`, [old])

  // --- Mesajlar: 2 başarılı (3 birim), 1 başarısız, 1 test (hariç)
  await db().query(
    `insert into messages (channel, to_address, body, status, provider, cost_units, sent_at, is_test) values
       ('sms', '+905321234567', 'a', 'sent', 'log', 2, '2026-10-20T10:00:00+03:00', false),
       ('sms', '+905321234567', 'b', 'failed', 'log', 1, '2026-10-21T10:00:00+03:00', false),
       ('email', 'x@example.com', 'c', 'delivered', 'smtp', 1, '2026-10-22T10:00:00+03:00', false),
       ('sms', '+905321234567', 'd', 'sent', 'log', 1, '2026-10-22T10:00:00+03:00', true)`,
  )

  // --- Randevular: 2 geldi (bekleme 20 ve 10 dk), 1 gelmedi, 1 sahip iptali, 1 planlı
  const type = (await db().query(`select id from appointment_types order by sort limit 1`)).rows[0].id
  const ap = await db().query(
    `insert into appointments (animal_id, owner_id, vet_id, type_id, starts_at, ends_at, status, arrived_at, started_at, cancelled_by_side) values
       ($1, $2, $3, $5, '2026-10-20T10:00:00+03:00', '2026-10-20T10:30:00+03:00', 'done', '2026-10-20T10:00:00+03:00', '2026-10-20T10:20:00+03:00', null),
       ($1, $2, $4, $5, '2026-10-21T11:00:00+03:00', '2026-10-21T11:30:00+03:00', 'done', '2026-10-21T11:00:00+03:00', '2026-10-21T11:10:00+03:00', null),
       ($1, $2, $3, $5, '2026-10-22T11:00:00+03:00', '2026-10-22T11:30:00+03:00', 'no_show', null, null, null),
       ($1, $2, $3, $5, '2026-10-23T11:00:00+03:00', '2026-10-23T11:30:00+03:00', 'cancelled', null, null, 'owner'),
       ($1, $2, $3, $5, '2026-10-30T11:00:00+03:00', '2026-10-30T11:30:00+03:00', 'planned', null, null, null)
     returning id`,
    [a1.animalId, a1.ownerId, t.adminId, vet.userId, type],
  )
  apptId = ap.rows[4].id

  // --- KVKK talebi
  const kr = await db().query(
    `insert into kvkk_requests (owner_id, type, received_at, channel, due_date, status, response_note) values ($1, 'info', '2026-10-20', 'written', '2026-11-19', 'done', 'Bilgi verildi.') returning id`,
    [a1.ownerId],
  )
  kvkkId = kr.rows[0].id
}, 180_000)

afterAll(async () => {
  await t?.stop()
}, 60_000)

// ---------------------------------------------------------------- Code 128

describe('Code 128 B', () => {
  it('desen tablosu tutarlı: 107 desen, benzersiz, her biri 11 modül (stop 13)', () => {
    expect(CODE128_PATTERNS).toHaveLength(107)
    expect(new Set(CODE128_PATTERNS).size).toBe(107)
    CODE128_PATTERNS.forEach((p, i) => {
      const sum = p.split('').reduce((a, x) => a + Number(x), 0)
      expect(sum, `desen ${i}`).toBe(i === 106 ? 13 : 11)
      // Çubuk modülleri toplamı çift (Code 128 eşlik kuralı)
      const bars = p.split('').filter((_, j) => j % 2 === 0).reduce((a, x) => a + Number(x), 0)
      expect(bars % 2, `desen ${i} eşlik`).toBe(0)
    })
  })

  it('"PJJ123C" bilinen örnek: değerler ve kontrol karakteri (879 mod 103 = 55)', () => {
    const e = encodeCode128B('PJJ123C')
    expect(e.codes).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106])
    expect(e.checksum).toBe(55)
    expect(e.pattern.startsWith('211214')).toBe(true) // Start B
    expect(e.pattern.endsWith('2331112')).toBe(true) // Stop
    // P = 313121, J = 112133, 1 = 123221, C = 131321 (Code 128 standardı)
    expect(e.pattern.slice(6, 12)).toBe('313121')
    expect(e.pattern.slice(12, 18)).toBe('112133')
    expect(e.pattern.slice(24, 30)).toBe('123221')
    expect(e.pattern.slice(42, 48)).toBe('131321')
    expect(e.pattern.slice(48, 54)).toBe('311321') // kontrol değeri 55
    expect(e.modules).toBe(11 * 9 + 13)
  })

  it('çip numarası: bağımsız hesaplanan checksum ve çubuk yerleşimi', () => {
    const chip = '792091234567891'
    const e = encodeCode128B(chip)
    let sum = 104
    chip.split('').forEach((ch, i) => (sum += (ch.charCodeAt(0) - 32) * (i + 1)))
    expect(e.checksum).toBe(sum % 103)
    expect(e.modules).toBe(11 * 17 + 13)
    const { bars, width } = code128Bars(chip, 10)
    expect(width).toBe(e.modules + 20)
    expect(bars[0]).toEqual({ x: 10, w: 2 }) // Start B ilk çubuk 2 modül
    expect(bars.at(-1)).toEqual({ x: width - 10 - 2, w: 2 }) // Stop son çubuk 2 modül
  })

  it('geçersiz karakter ve boş metin reddedilir', () => {
    expect(() => encodeCode128B('')).toThrow()
    expect(() => encodeCode128B('Çip')).toThrow()
  })
})

describe('CSV biçimi', () => {
  it('BOM, ; ayraç, tırnaklama, ondalık virgül, formül koruması', () => {
    const csv = reportToCsv({
      tables: [{ title: 'T', columns: [{ key: 'a', label: 'Ad' }, { key: 'b', label: 'Oran', num: true }], rows: [{ a: 'x;y "z"', b: 12.5 }, { a: '=1+1', b: 3 }] }],
    })
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe('Ad;Oran')
    expect(lines[1]).toBe('"x;y ""z""";12,5')
    expect(lines[2]).toBe("'=1+1;3")
  })
})

// ---------------------------------------------------------------- raporlar

describe('raporlar', () => {
  it('meta: yönetici tüm raporlar, hekim filtresi sabit değil', async () => {
    const r = await t.api<ReportsMetaDto>('GET', '/api/reports/meta')
    expect(r.status).toBe(200)
    expect(r.data.reports).toHaveLength(9)
    expect(r.data.fixedVetId).toBeNull()
    expect(r.data.canExport).toBe(true)
  })

  it('kimliklendirme: dönemde 2 çip, PETVET durumu', async () => {
    const r = await report('identification')
    expect(r.status).toBe(200)
    const rows = r.data.tables[0].rows
    expect(rows.filter((x) => x.date === '27.10.2026')).toHaveLength(2)
    expect(rows.find((x) => x.animal === 'Pamuk')!.petvet).toBe('Bekliyor')
    expect(rows.find((x) => x.animal === 'Karabaş')!.petvet).toBe('Eksik bilgi')
    // Hekim filtresi: hekim kullanıcısı çip uygulamamış
    const v = await report('identification', `${RANGE}&vetId=${vet.userId}`)
    expect(v.data.tables[0].rows).toHaveLength(0)
  })

  it('PETVET uyum: tür bazında sayılar, zamanında %, geciken listesi', async () => {
    const r = await report('petvet')
    const chip = rowOf(r.data, 'Tür bazında', 'Yeni çip')
    expect(chip.total).toBe(4)
    expect(chip.done).toBe(1)
    expect(chip.onTime).toBe(1)
    expect(chip.onTimePct).toBe(50) // 1 zamanında / (1 girildi + 1 süresi geçmiş)
    expect(chip.avgDays).toBe(9) // 01.10 → 10.10
    expect(chip.overdue).toBe(1)
    const late = table(r.data, 'Geciken').rows
    expect(late).toHaveLength(1)
    expect(late[0].dueDate).toBe('17.10.2026')
    expect(late[0].late).toBe(10)
  })

  it('çipsiz hayvanlar: yalnızca 6 aydan büyük kedi/köpek/gelincik, sahip telefonuyla', async () => {
    const r = await report('chipless')
    const rows = r.data.tables[0].rows
    expect(rows.map((x) => x.animal)).toEqual(['Çipsiz'])
    expect(rows[0].phone).toBe('0530 999 88 77')
  })

  it('aşı raporu: tür/ürün/lot ve lot geri çağırma araması', async () => {
    const r = await report('vaccines', `${RANGE}&lot=r-777`)
    expect(r.status).toBe(200)
    expect(r.data.summary.find((s) => s.label === 'Uygulanan aşı')!.value).toBe('4')
    expect(r.data.summary.find((s) => s.label === 'Kuduz')!.value).toBe('2')
    const lot = rowOf(r.data, 'Tür / ürün', 'R-777', 'lot')
    expect(lot.n).toBe(2)
    expect(table(r.data, '"r-777" lotu').rows.map((x) => x.animal).sort()).toEqual(['Karabaş (Köpek)', 'Pamuk (Kedi)'])
  })

  it('aşı uyum oranı: zamanında / geç / yapılmadı', async () => {
    const r = await report('vaccine-compliance')
    expect(rowOf(r.data, 'Aşı türü', 'Karma').missed).toBe(1)
    expect(rowOf(r.data, 'Aşı türü', 'Lösemi (FeLV)').onTime).toBe(1)
    expect(rowOf(r.data, 'Aşı türü', 'Bronşin (KC)').late).toBe(1)
    expect(rowOf(r.data, 'Aşı türü', 'Lösemi (FeLV)').rate).toBe(100)
    const late = table(r.data, 'Geciken aşılar').rows
    expect(late.find((x) => x.kind === 'Karma')!.late).toBe(22)
  })

  it('muayene istatistiği: hekim/tür/gün ve en sık tanılar', async () => {
    const r = await report('visits')
    expect(r.data.summary[0].value).toBe('2')
    expect(table(r.data, 'En sık tanılar').rows[0]).toEqual({ k: 'Gastrit', n: 2 })
    expect(table(r.data, 'Tür bazında').rows).toEqual(expect.arrayContaining([{ k: 'Kedi', n: 1 }, { k: 'Köpek', n: 1 }]))
    expect(table(r.data, 'Gün bazında').rows).toEqual([{ k: '26.10.2026', n: 1 }, { k: '27.10.2026', n: 1 }])
  })

  it('hasta tabanı: aktif sayısı, yeni hasta, 12 aydır gelmeyen', async () => {
    const r = await report('patients')
    const s = Object.fromEntries(r.data.summary.map((x) => [x.label, x.value]))
    expect(s['Aktif hayvan']).toBe('6')
    expect(s['Yeni hasta (dönem)']).toBe('5')
    expect(s['12 aydır gelmeyen']).toBe('1')
    expect(table(r.data, '12 aydır').rows[0].animal).toBe('Eski (Kedi)')
    expect(table(r.data, 'Yaş dağılımı').rows.find((x) => x.k === 'Bilinmiyor')!.n).toBe(1)
  })

  it('mesaj raporu: gönderilen/başarısız, kanal, birim (test mesajı hariç)', async () => {
    const r = await report('messages')
    const s = Object.fromEntries(r.data.summary.map((x) => [x.label, x.value]))
    expect(s['Gönderim']).toBe('3')
    expect(s['Başarılı']).toBe('2')
    expect(s['Başarısız']).toBe('1')
    expect(s['Birim (maliyet tahmini)']).toBe('3')
    const sms = rowOf(r.data, 'Kanal', 'SMS', 'k')
    expect(sms).toMatchObject({ total: 2, ok: 1, failed: 1, units: 2 })
  })

  it('randevu raporu: gelme oranı, iptal, ortalama bekleme', async () => {
    const r = await report('appointments')
    const s = Object.fromEntries(r.data.summary.map((x) => [x.label, x.value]))
    expect(s['Randevu']).toBe('5')
    expect(s['Geldi']).toBe('2')
    expect(s['Gelmedi']).toBe('1')
    expect(s['İptal']).toBe('1')
    expect(s['Gelme oranı']).toBe('%66,7')
    expect(s['Ort. bekleme']).toBe('15,0 dk')
  })

  it('geçersiz tarih aralığı ve bilinmeyen rapor', async () => {
    expect((await report('visits', 'from=2026-10-31&to=2026-10-01')).status).toBe(400)
    expect((await report('visits', 'from=31.10.2026')).status).toBe(400)
    expect((await report('yok')).status).toBe(404)
  })
})

describe('rapor izinleri', () => {
  it('teknisyen raporları göremez (403)', async () => {
    expect((await report('visits', RANGE, tech.token)).status).toBe(403)
    expect((await t.api('GET', '/api/reports/meta', undefined, tech.token)).status).toBe(403)
  })

  it('hekimde hekim filtresi zorla kendisi', async () => {
    const meta = await t.api<ReportsMetaDto>('GET', '/api/reports/meta', undefined, vet.token)
    expect(meta.data.fixedVetId).toBe(vet.userId)
    expect(meta.data.canExport).toBe(false)
    expect(meta.data.reports.map((r) => r.key)).not.toContain('messages')
    const r = await report('visits', `${RANGE}&vetId=${t.adminId}`, vet.token)
    expect(r.status).toBe(200)
    expect(r.data.vetId).toBe(vet.userId)
    expect(r.data.summary[0].value).toBe('1')
    const vac = await report('vaccines', RANGE, vet.token)
    expect(vac.data.summary[0].value).toBe('1')
    const ap = await report('appointments', RANGE, vet.token)
    expect(ap.data.summary[0].value).toBe('1')
    expect((await report('messages', RANGE, vet.token)).status).toBe(403)
  })

  it('sekreter yalnızca randevu ve mesaj raporlarını görür', async () => {
    expect((await report('appointments', RANGE, sec.token)).status).toBe(200)
    expect((await report('messages', RANGE, sec.token)).status).toBe(200)
    expect((await report('visits', RANGE, sec.token)).status).toBe(403)
    expect((await report('identification', RANGE, sec.token)).status).toBe(403)
  })

  it('CSV: yalnızca reports.export; BOM + ; ayraç + başlık; audit kaydı', async () => {
    expect((await t.api('GET', `/api/reports/identification/csv?${RANGE}`, undefined, vet.token)).status).toBe(403)
    const res = await fetch(`${t.backend.apiBase}/api/reports/identification/csv?${RANGE}`, { headers: { Authorization: `Bearer ${t.adminToken}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('PatiKunye_identification_2026-10-01_2026-10-31.csv')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1)
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('Tarih;Çip no;Tür;Hayvan;Sahip;Hekim;PETVET;Gecikme (gün)')
    expect(lines.filter((l) => l.includes('27.10.2026'))).toHaveLength(2)
    const audit = await db().query(`select count(*)::int as n from audit_logs where action = 'export' and entity = 'report' and entity_id = 'identification'`)
    expect(audit.rows[0].n).toBe(1)
  })
})

// ---------------------------------------------------------------- yazdırma

describe('yazdırma ucu', () => {
  const kinds = () => [
    `vaccine-card/${a1.animalId}`,
    `chip-card/${a1.animalId}?owner=1`,
    `visit/${visitId}`,
    `visit/${visitId}?full=1`,
    `prescription/${visitId}`,
    `kvkk-consent/${a1.ownerId}?animalId=${a1.animalId}`,
    `audit-pack?from=2026-10-01&to=2026-10-31`,
    `kvkk-response/${kvkkId}`,
    `appointment-card/${apptId}`,
    `worklist?list=petvet`,
    `worklist?list=vaccine-calls`,
    `report/petvet?${RANGE}`,
  ]

  it('her çıktı türü 200 döner ve TCKN tam hali hiçbir yanıtta yok', async () => {
    for (const k of kinds()) {
      const r = await t.api('GET', `/api/print/${k}`)
      expect(r.status, `${k}: ${JSON.stringify(r.data)}`).toBe(200)
      const s = JSON.stringify(r.data)
      expect(s, k).not.toContain(TCKN)
      expect(r.data.clinic.name).toBe('Test Kliniği')
    }
    // Raporlar da TCKN içermez
    for (const key of ['identification', 'petvet', 'chipless', 'vaccines', 'vaccine-compliance', 'visits', 'patients', 'appointments']) {
      expect(JSON.stringify((await report(key, `${RANGE}&lot=R-777`)).data)).not.toContain(TCKN)
    }
  })

  it('aşı karnesi: aşılar ve sahip TCKN maskeli', async () => {
    const r = await t.api('GET', `/api/print/vaccine-card/${a1.animalId}`)
    expect(r.data.data.vaccinations.map((v: { kindLabel: string }) => v.kindLabel)).toEqual(['Lösemi (FeLV)', 'Kuduz'])
    expect(r.data.data.owner.tcknMasked).toBe('*******0146')
    expect(r.data.data.animal.chipNo).toMatch(/^792091/)
  })

  it('muayene özeti: sahip sürümünde iç not yok, tam sürümde var; tedavi satırı', async () => {
    const own = await t.api('GET', `/api/print/visit/${visitId}`)
    expect(JSON.stringify(own.data)).not.toContain('GIZLI-IC-NOT')
    const full = await t.api('GET', `/api/print/visit/${visitId}?full=1`)
    expect(full.data.data.visit.internalNote).toBe('GIZLI-IC-NOT')
    const rx = await t.api('GET', `/api/print/prescription/${visitId}`)
    expect(rx.data.data.treatments[0]).toMatchObject({ drug: 'Maropitant', kind: 'prescribed', route: 'SC' })
    expect(JSON.stringify(rx.data)).not.toContain('GIZLI-IC-NOT')
    expect(full.data.data.visit.vitals).toEqual(expect.arrayContaining([{ label: 'Ateş', value: '38,6 °C' }]))
  })

  it('denetim paketi: özet, satırlar, gün farkı, audit kaydı', async () => {
    const r = await t.api('GET', '/api/print/audit-pack?from=2026-10-01&to=2026-10-31&kinds=CHIP_NEW')
    const d = r.data.data
    expect(d.fileName).toBe('PatiKunye_Denetim_2026-10-01_2026-10-31.pdf')
    expect(d.rows).toHaveLength(4)
    const done = d.rows.find((x: { petvetRef: string }) => x.petvetRef === 'REF-1')
    expect(done).toMatchObject({ daysToEntry: 9, lateDays: -6, tcknMasked: '*******0146' })
    expect(d.summary[0]).toMatchObject({ kindLabel: 'Yeni çip', total: 4, done: 1, onTime: 1, open: 3 })
    const n = await db().query(`select count(*)::int as n from audit_logs where entity = 'petvet_audit_pack'`)
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1)
    expect((await t.api('GET', '/api/print/audit-pack?from=2026-10-31&to=2026-10-01')).status).toBe(400)
  })

  it('iş listeleri ve randevu kartı içerik', async () => {
    const p = await t.api('GET', '/api/print/worklist?list=petvet')
    expect(p.data.data.rows.length).toBeGreaterThanOrEqual(3)
    const v = await t.api('GET', '/api/print/worklist?list=vaccine-calls')
    expect(v.data.data.rows.some((x: { kind: string }) => x.kind === 'Karma')).toBe(true)
    expect((await t.api('GET', '/api/print/worklist?list=yok')).status).toBe(400)
    const a = await t.api('GET', `/api/print/appointment-card/${apptId}`)
    expect(a.data.data).toMatchObject({ animalName: 'Pamuk', vetName: 'Test Hekim' })
  })

  it('izinler: teknisyen denetim paketi ve KVKK yanıtı alamaz, sekreter muayene yazdıramaz', async () => {
    expect((await t.api('GET', '/api/print/audit-pack?from=2026-10-01&to=2026-10-31', undefined, tech.token)).status).toBe(403)
    expect((await t.api('GET', `/api/print/kvkk-response/${kvkkId}`, undefined, tech.token)).status).toBe(403)
    expect((await t.api('GET', `/api/print/visit/${visit2Id}`, undefined, sec.token)).status).toBe(403)
    expect((await t.api('GET', `/api/print/report/petvet?${RANGE}`, undefined, vet.token)).status).toBe(403)
    expect((await t.api('GET', `/api/print/visit/${visit2Id}`, undefined, tech.token)).status).toBe(200)
    expect((await t.api('GET', '/api/print/bilinmeyen')).status).toBe(404)
    expect((await t.api('GET', '/api/print/vaccine-card/00000000-0000-0000-0000-000000000000')).status).toBe(404)
  })
})
