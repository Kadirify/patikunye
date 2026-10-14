// Muayene modülü uçtan uca testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, type TestBackend } from './test-helpers'
import type { VisitAnimalContext, VisitDetail, VisitListResult, AnimalTreatmentDto, DiagnosisSuggestion, VisitPhrase } from '../shared/visits'

let t: TestBackend
let animalId: string

beforeAll(async () => {
  // Saat sabit: muayene saati "ileri zaman" denetimi ve 24 saat kuralı gerçek saate bağlı kalmasın
  t = await startTestBackend({ now: () => new Date('2026-10-27T12:00:00Z') })
  animalId = await makeAnimal()
}, 120_000)

/** t.registerAnimal(); başka modüldeki geçici bir hata yüzünden başarısız olursa doğrudan SQL ile örnek kayıt */
async function makeAnimal() {
  try {
    return (await t.registerAnimal({ name: 'Karabaş', species: 'dog' })).animalId
  } catch {
    const q = t.backend.db.$client
    const o = await q.query(`insert into owners (first_name, last_name, phone) values ('Deneme', 'Sahip', '+905301000001') returning id`)
    const a = await q.query(`insert into animals (name, species, sex, birth_date) values ('Karabaş', 'dog', 'male', '2022-05-01') returning id`)
    await q.query(`insert into animal_owners (animal_id, owner_id, is_primary) values ($1, $2, true)`, [a.rows[0].id, o.rows[0].id])
    return a.rows[0].id as string
  }
}

afterAll(async () => {
  await t?.stop()
})

const visitAt = '2026-10-27T07:15:00.000Z'

async function newDraft(extra: Record<string, unknown> = {}, token?: string) {
  const r = await t.api<{ id: string; rev: number }>('POST', '/api/visits', { animalId, visitAt, ...extra }, token)
  expect(r.status, JSON.stringify(r.data)).toBe(200)
  return r.data
}

describe('muayene: taslak -> imza -> ek/düzeltme', () => {
  let id = ''
  let rev = 0

  it('taslak oluşturur, hekim varsayılan olarak giriş yapan hekimdir', async () => {
    const d = await newDraft({ subjective: '3 gündür sol ön bacağını basmıyor.' })
    id = d.id
    rev = d.rev
    const g = await t.api<VisitDetail>('GET', `/api/visits/${id}`)
    expect(g.status).toBe(200)
    expect(g.data.status).toBe('draft')
    expect(g.data.vetId).toBe(t.adminId)
    expect(g.data.subjective).toContain('sol ön bacağını')
    expect(g.data.animal.name).toBe('Karabaş')
    expect(g.data.owner?.fullName).toBe('Deneme Sahip')
    expect(g.data.versions).toHaveLength(1)
  })

  it('taslağı günceller (PATCH), kilo geçmişine yazar ve mg/kg toplam dozu hesaplar', async () => {
    const r = await t.api<{ rev: number }>('PATCH', `/api/visits/${id}`, {
      rev,
      findings: {
        vitals: { temp: 38.9, pulse: 96, resp: 24, weight: 39.1, bcs: 5 },
        systems: { genel: { status: 'normal' }, kas_iskelet: { status: 'abnormal', note: 'Sol dirsek ağrılı.' } },
      },
      diagnoses: ['Dirsek displazisi', 'dirsek displazisi', ' '],
      differential: ['Yumuşak doku travması'],
      controlDate: '2026-11-03',
      treatments: [
        { drug: 'Karprofen 100 mg', activeIngredient: 'Karprofen', dose: 2, doseUnit: 'mg/kg', route: 'Oral', frequency: '2×1', duration: '7 gün', kind: 'prescribed' },
      ],
    })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.rev).toBe(rev + 1)
    rev = r.data.rev
    const g = await t.api<VisitDetail>('GET', `/api/visits/${id}`)
    expect(g.data.diagnoses).toEqual(['Dirsek displazisi'])
    expect(g.data.findings.systems.kas_iskelet).toEqual({ status: 'abnormal', note: 'Sol dirsek ağrılı.' })
    expect(g.data.treatments[0]).toMatchObject({ perKg: true, totalDose: 78.2, durationDays: 7 })

    const w = await t.backend.db.$client.query(`select kg, source, visit_id from animal_weights where animal_id = $1`, [animalId])
    expect(w.rows).toHaveLength(1)
    expect(w.rows[0]).toMatchObject({ kg: '39.10', source: 'visit', visit_id: id })

    // Kilo değişince tek satır kalır
    const r2 = await t.api<{ rev: number }>('PATCH', `/api/visits/${id}`, { rev, findings: { vitals: { weight: 39.5 }, systems: {} } })
    rev = r2.data.rev
    const w2 = await t.backend.db.$client.query(`select kg from animal_weights where animal_id = $1`, [animalId])
    expect(w2.rows.map((x) => x.kg)).toEqual(['39.50'])
    const g2 = await t.api<VisitDetail>('GET', `/api/visits/${id}`)
    expect(g2.data.treatments[0].totalDose).toBe(79)
  })

  it('iyimser kilit: eski revizyonla güncelleme 409 döner', async () => {
    const r = await t.api('PATCH', `/api/visits/${id}`, { rev: rev - 1, subjective: 'çakışma' })
    expect(r.status).toBe(409)
    expect((r.data as { code: string }).code).toBe('CONFLICT')
  })

  it('imzalar; imzalı kayıt değiştirilemez ve silinemez', async () => {
    const s = await t.api<VisitDetail>('POST', `/api/visits/${id}/sign`, { rev })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(s.data.status).toBe('signed')
    expect(s.data.signedBy).toBe(t.adminId)
    expect(s.data.signedAt).toBeTruthy()

    const p = await t.api<{ code: string }>('PATCH', `/api/visits/${id}`, { rev: s.data.rev, subjective: 'değiştir' })
    expect(p.status).toBe(409)
    expect(p.data.code).toBe('SIGNED')
    const d = await t.api('DELETE', `/api/visits/${id}`)
    expect(d.status).toBe(409)
    const again = await t.api('POST', `/api/visits/${id}/sign`, {})
    expect(again.status).toBe(409)

    // Veritabanı tetikleyicisi de korur
    await expect(t.backend.db.$client.query(`update visits set subjective = 'x' where id = $1`, [id])).rejects.toThrow(/İmzalı muayene/)
  })

  it('ek/düzeltme yeni versiyon oluşturur; eski versiyon görünür kalır', async () => {
    const noReason = await t.api('POST', `/api/visits/${id}/amend`, {})
    expect(noReason.status).toBe(400)

    const a = await t.api<{ id: string; version: number }>('POST', `/api/visits/${id}/amend`, { reason: 'Kilo yanlış girilmiş' })
    expect(a.status, JSON.stringify(a.data)).toBe(200)
    expect(a.data.version).toBe(2)
    const v2 = a.data.id

    // İkinci açık düzeltme engellenir
    const dup = await t.api<{ code: string }>('POST', `/api/visits/${id}/amend`, { reason: 'tekrar deneme' })
    expect(dup.status).toBe(409)
    expect(dup.data.code).toBe('HAS_SUCCESSOR')

    const g = await t.api<VisitDetail>('GET', `/api/visits/${v2}`)
    expect(g.data.status).toBe('draft')
    expect(g.data.supersedesId).toBe(id)
    expect(g.data.diagnoses).toEqual(['Dirsek displazisi'])
    expect(g.data.treatments).toHaveLength(1)

    const p = await t.api<{ rev: number }>('PATCH', `/api/visits/${v2}`, { rev: g.data.rev, findings: { vitals: { weight: 38.6 }, systems: {} } })
    expect(p.status).toBe(200)
    const s = await t.api<VisitDetail>('POST', `/api/visits/${v2}/sign`, { rev: p.data.rev })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(s.data.displayStatus).toBe('amended')
    expect(s.data.versions.map((x) => [x.version, x.status])).toEqual([
      [1, 'signed'],
      [2, 'signed'],
    ])

    // Eski versiyon hâlâ okunabilir ve değişmemiştir
    const old = await t.api<VisitDetail>('GET', `/api/visits/${id}`)
    expect(old.data.status).toBe('signed')
    expect(old.data.findings.vitals.weight).toBe(39.5)
    expect(old.data.supersededById).toBe(v2)

    // Kilo geçmişinde zincir başına tek satır (son versiyon)
    const w = await t.backend.db.$client.query(`select kg, visit_id from animal_weights where animal_id = $1`, [animalId])
    expect(w.rows).toEqual([{ kg: '38.60', visit_id: v2 }])

    // Liste yalnızca geçerli versiyonu gösterir
    const l = await t.api<VisitListResult>('GET', `/api/visits?animalId=${animalId}`)
    expect(l.data.rows.map((x) => x.id)).toEqual([v2])
    expect(l.data.rows[0].displayStatus).toBe('amended')
  })

  it('hayvanın tedavileri ve muayene bağlamı', async () => {
    const tr = await t.api<AnimalTreatmentDto[]>('GET', `/api/treatments?animalId=${animalId}`)
    expect(tr.status).toBe(200)
    expect(tr.data).toHaveLength(1)
    expect(tr.data[0]).toMatchObject({ drug: 'Karprofen 100 mg', active: true, endDate: '2026-11-02' })

    const ctx = await t.api<VisitAnimalContext>('GET', `/api/visits/animal-context/${animalId}`)
    expect(ctx.status).toBe(200)
    expect(ctx.data.lastWeight?.kg).toBe(38.6)
    expect(ctx.data.recentVisits).toHaveLength(1)
    expect(ctx.data.previousVitals?.vitals.weight).toBe(38.6)
    expect(ctx.data.activeTreatments).toHaveLength(1)
  })
})

describe('doğrulama', () => {
  it('ateş 30-45 dışında, VKS 1-9 dışında, kilo 150 üstünde reddedilir', async () => {
    const bad = [
      { vitals: { temp: 46 } },
      { vitals: { temp: 29.5 } },
      { vitals: { bcs: 10 } },
      { vitals: { bcs: 4.5 } },
      { vitals: { weight: 151 } },
      { vitals: { weight: 0 } },
    ]
    for (const f of bad) {
      const r = await t.api<{ code: string; error: string }>('POST', '/api/visits', { animalId, findings: { systems: {}, ...f } })
      expect(r.status, JSON.stringify(f)).toBe(400)
      expect(r.data.code).toBe('VALIDATION')
    }
    const temp = await t.api<{ error: string }>('POST', '/api/visits', { animalId, findings: { vitals: { temp: 50 }, systems: {} } })
    expect(temp.data.error).toContain('Ateş')
    // 35-43 dışı yalnızca uyarıdır (arayüzde); kayıt kabul edilir
    const ok = await t.api('POST', '/api/visits', { animalId, findings: { vitals: { temp: 34.2 }, systems: {} } })
    expect(ok.status).toBe(200)
  })

  it('geçersiz tür, ileri tarih, kontrol tarihi muayeneden önce, boş ilaç adı', async () => {
    expect((await t.api('POST', '/api/visits', { animalId, type: 'xyz' })).status).toBe(400)
    expect((await t.api('POST', '/api/visits', { animalId, visitAt: '2099-01-01T10:00:00Z' })).status).toBe(400)
    const c = await t.api<{ error: string }>('POST', '/api/visits', { animalId, visitAt, controlDate: '2026-10-01' })
    expect(c.status).toBe(400)
    expect(c.data.error).toContain('Kontrol tarihi')
    const d = await t.api('POST', '/api/visits', { animalId, treatments: [{ drug: ' ', kind: 'administered' }] })
    expect(d.status).toBe(400)
    expect((await t.api('POST', '/api/visits', { animalId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404)
  })

  it('boş taslak imzalanamaz; taslak silinebilir', async () => {
    const d = await newDraft()
    const s = await t.api<{ error: string }>('POST', `/api/visits/${d.id}/sign`, {})
    expect(s.status).toBe(400)
    const del = await t.api('DELETE', `/api/visits/${d.id}`)
    expect(del.status).toBe(200)
    expect((await t.api('GET', `/api/visits/${d.id}`)).status).toBe(404)
  })

  it('alerjik etken madde onaysız imzalanamaz', async () => {
    await t.backend.db.$client.query(`update animals set allergies = '{Penisilin}' where id = $1`, [animalId])
    const d = await newDraft({
      subjective: 'Yara',
      treatments: [{ drug: 'Penisilin G prokain', activeIngredient: 'Benzilpenisilin', dose: 1, doseUnit: 'ml', kind: 'administered' }],
    })
    const s = await t.api<{ code: string }>('POST', `/api/visits/${d.id}/sign`, {})
    expect(s.status).toBe(400)
    expect(s.data.code).toBe('ALLERGY')
    const g = await t.api<VisitDetail>('GET', `/api/visits/${d.id}`)
    const p = await t.api<{ rev: number }>('PATCH', `/api/visits/${d.id}`, {
      rev: g.data.rev,
      treatments: [{ drug: 'Penisilin G prokain', activeIngredient: 'Benzilpenisilin', dose: 1, doseUnit: 'ml', kind: 'administered', allergyAck: true }],
    })
    const ok = await t.api('POST', `/api/visits/${d.id}/sign`, { rev: p.data.rev })
    expect(ok.status).toBe(200)
    await t.backend.db.$client.query(`update animals set allergies = '{}' where id = $1`, [animalId])
  })
})

describe('izinler', () => {
  it('sekreter muayene içeriğini göremez, yalnızca tarih/hekim/tür', async () => {
    const d = await newDraft({ subjective: 'Gizli öykü', diagnoses: ['Otitis externa'] })
    const sec = await t.loginAs('secretary')
    const g = await t.api<VisitDetail>('GET', `/api/visits/${d.id}`, undefined, sec.token)
    expect(g.status).toBe(200)
    expect(g.data.restricted).toBe(true)
    expect(g.data.subjective).toBeNull()
    expect(g.data.diagnoses).toEqual([])
    expect(g.data.treatments).toEqual([])
    expect(g.data.vetName).toBe('Test Hekim')
    expect(g.data.type).toBe('exam')
    expect(g.data.visitAt).toBe(visitAt)

    const l = await t.api<VisitListResult>('GET', `/api/visits?animalId=${animalId}`, undefined, sec.token)
    expect(l.status).toBe(200)
    expect(l.data.rows.length).toBeGreaterThan(0)
    expect(l.data.rows.every((r) => r.diagnosisSummary === null)).toBe(true)

    expect((await t.api('POST', '/api/visits', { animalId }, sec.token)).status).toBe(403)
    expect((await t.api('GET', `/api/treatments?animalId=${animalId}`, undefined, sec.token)).status).toBe(403)
    expect((await t.api('POST', `/api/visits/${d.id}/sign`, {}, sec.token)).status).toBe(403)
  })

  it('teknisyen taslak yazabilir ama imzalayamaz', async () => {
    const tech = await t.loginAs('tech')
    const d = await newDraft({ subjective: 'Teknisyen ön kaydı' }, tech.token)
    const g = await t.api<VisitDetail>('GET', `/api/visits/${d.id}`, undefined, tech.token)
    expect(g.data.vetId).toBeNull()
    expect(g.data.subjective).toBe('Teknisyen ön kaydı')
    const s = await t.api('POST', `/api/visits/${d.id}/sign`, {}, tech.token)
    expect(s.status).toBe(403)
    // Hekim seçimi yalnızca hekim olabilir
    const bad = await t.api('PATCH', `/api/visits/${d.id}`, { rev: g.data.rev, vetId: tech.userId }, tech.token)
    expect(bad.status).toBe(400)
    // Hekim imzalar; hekim boşsa imzalayan hekim olur
    const ok = await t.api<VisitDetail>('POST', `/api/visits/${d.id}/sign`, {})
    expect(ok.status).toBe(200)
    expect(ok.data.vetId).toBe(t.adminId)
  })
})

describe('liste ve öneriler', () => {
  it('filtreler: hekim, tür, durum, tanı, 24 saatten eski taslak', async () => {
    const vet = await t.loginAs('vet')
    const mine = await newDraft({ type: 'emergency', diagnoses: ['Akut gastroenterit'] }, vet.token)
    const byVet = await t.api<VisitListResult>('GET', `/api/visits?vetId=${vet.userId}`)
    expect(byVet.data.rows.map((r) => r.id)).toEqual([mine.id])
    const byType = await t.api<VisitListResult>('GET', '/api/visits?type=emergency')
    expect(byType.data.rows.map((r) => r.id)).toEqual([mine.id])
    const byDx = await t.api<VisitListResult>('GET', '/api/visits?diagnosis=gastroenterit')
    expect(byDx.data.rows.map((r) => r.id)).toEqual([mine.id])
    const drafts = await t.api<VisitListResult>('GET', '/api/visits?status=draft')
    expect(drafts.data.rows.every((r) => r.status === 'draft')).toBe(true)
    const range = await t.api<VisitListResult>('GET', '/api/visits?from=2026-10-27&to=2026-10-27')
    expect(range.data.total).toBeGreaterThan(0)

    // 24 saatten eski taslak
    await t.backend.db.$client.query(`update visits set created_at = '2026-10-25T08:00:00Z' where id = $1`, [mine.id])
    const stale = await t.api<VisitListResult>('GET', '/api/visits?status=stale')
    expect(stale.data.rows.map((r) => r.id)).toEqual([mine.id])
    expect(stale.data.rows[0].stale).toBe(true)
  })

  it('tanı önerileri ve hazır cümleler', async () => {
    const d = await t.api<DiagnosisSuggestion[]>('GET', '/api/visits/suggest/diagnoses?q=displa')
    expect(d.status).toBe(200)
    const names = d.data.map((x) => x.name)
    expect(names).toContain('Dirsek displazisi')
    expect(d.data.find((x) => x.name === 'Dirsek displazisi')!.uses).toBeGreaterThan(0)
    const ph = await t.api<VisitPhrase[]>('GET', '/api/visits/phrases')
    expect(ph.data.find((x) => x.shortcut === 'kusma')?.text).toContain('kusma')
    const drugs = await t.api<{ drug: string }[]>('GET', '/api/visits/suggest/drugs?q=karpro')
    expect(drugs.data[0]?.drug).toBe('Karprofen 100 mg')
  })
})
