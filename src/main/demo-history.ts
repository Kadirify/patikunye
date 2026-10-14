// Yıllara yayılmış örnek geçmiş (ekran görüntüleri ve test için). Uygulamanın API'si üzerinden yazılır;
// kayıt zaman damgaları (created_at vb.) sonradan scripts/seed-history.ts tarafından geriye çekilir.
import { addDaysIso } from '../shared/petvet'
import {
  type Call,
  rng,
  fakeTckn,
  FIRST_M,
  FIRST_F,
  LAST,
  PLACES,
  CAT_NAMES,
  DOG_NAMES,
  CAT_BREEDS,
  DOG_BREEDS,
  CAT_COLORS,
  DOG_COLORS,
  COMPLAINTS,
  DIAGNOSES,
  DRUGS,
} from './demo-data'

export interface HistoryResult {
  animals: number
  vaccinations: number
  visits: number
  appointments: number
  deaths: number
  petvetDone: number
  /** Kayıt tarihlerini geriye çekmek için: hayvan -> çip tarihi */
  backdate: { animalId: string; ownerId: string; date: string }[]
  errors: string[]
}

/**
 * from (örn. 2020-02-03) ile bugünün ~3 ay öncesi arasında çiplenen hayvanlar; her yıl karma + kuduz aşısı
 * yıllar içinde muayeneler ve bitmiş randevular, birkaç vefat. 2023 öncesinde tek hekim yöneticidir.
 */
export async function seedHistory(call: Call, opts: { today: string; from: string; to?: string; uniform?: boolean; count: number; log?: (m: string) => void }): Promise<HistoryResult> {
  const r = rng((Date.now() * 7) % 1e9)
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const chance = (p: number) => r() < p
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
  const T = opts.today
  const log = opts.log ?? (() => undefined)
  const res: HistoryResult = { animals: 0, vaccinations: 0, visits: 0, appointments: 0, deaths: 0, petvetDone: 0, backdate: [], errors: [] }
  const err = (what: string, x: { status: number; data: unknown }) => {
    const msg = `${what}: ${x.status} ${JSON.stringify(x.data).slice(0, 200)}`
    if (res.errors.length < 30) res.errors.push(msg)
    log('[geçmiş] ' + msg)
  }
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
  const weekday = (d: string) => (new Date(d + 'T12:00:00+03:00').getUTCDay() === 0 ? addDaysIso(d, 1) : d)
  const at = (d: string) => `${d}T${String(int(9, 16)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}:00+03:00`
  const span = days(opts.from, opts.to ?? addDaysIso(T, -90))

  const users = (await call<{ id: string; role: string; fullName: string }[]>('GET', '/api/users')).data
  const admin = users.find((u) => u.role === 'admin') ?? users[0]
  const vets = users.filter((u) => u.role === 'vet')
  const vetOn = (d: string) => (d < '2023-01-01' || !vets.length || chance(0.5) ? admin : pick(vets))
  const products = (await call<{ id: string; kind: string; species: string[]; active: boolean }[]>('GET', '/api/vaccine-products')).data
  const productFor = (kind: string, species: string) => products.find((p) => p.kind === kind && p.active && (p.species.length === 0 || p.species.includes(species)))
  const types = (await call<{ id: string; defaultMinutes: number; active: boolean }[]>('GET', '/api/appointment-types')).data.filter((t) => t.active)
  const usedChips = new Set<string>()
  const chipNo = () => {
    let c = ''
    do c = '792091' + String(int(0, 999_999_999)).padStart(9, '0')
    while (usedChips.has(c))
    usedChips.add(c)
    return c
  }

  for (let i = 0; i < opts.count; i++) {
    // Klinik yıllar içinde büyür: sonraki yıllarda daha çok kayıt (karekök dağılımı)
    const implant = weekday(addDaysIso(opts.from, Math.floor((opts.uniform ? r() : Math.sqrt(r())) * span)))
    const isCat = chance(0.55)
    const species = isCat ? 'cat' : 'dog'
    const birth = addDaysIso(implant, -int(70, 2200))
    const first = pick(chance(0.5) ? FIRST_F : FIRST_M)
    const [city, district] = pick(PLACES)
    const dies = chance(0.07)
    const end = dies ? addDaysIso(T, -int(30, Math.max(31, days(implant, T) - 60))) : T
    const reg = await call<{ animalId: string; ownerId: string }>('POST', '/api/quick-register', {
      chipNo: chipNo(),
      owner: {
        firstName: first,
        lastName: pick(LAST),
        tckn: fakeTckn(r),
        phone: `05${pick(['30', '32', '33', '35', '41', '42', '43', '44', '52', '53', '54', '55'])}${String(int(0, 9_999_999)).padStart(7, '0')}`,
        city,
        district,
        address: `${pick(['Atatürk', 'Cumhuriyet', 'İnönü', 'Gazi', 'Lale', 'Menekşe', 'Bağdat', 'Halaskargazi'])} Cad. No:${int(1, 120)}`,
        kvkkNotice: true,
        reminderConsent: chance(0.9),
      },
      animal: {
        name: pick(isCat ? CAT_NAMES : DOG_NAMES),
        species,
        breed: pick(isCat ? CAT_BREEDS : DOG_BREEDS),
        sex: chance(0.5) ? 'female' : 'male',
        neutered: chance(0.55),
        birthDate: birth,
        birthDateEstimated: chance(0.3),
        color: pick(isCat ? CAT_COLORS : DOG_COLORS),
      },
      implant: { date: implant, vetId: vetOn(implant).id, bodySite: 'Boyun sol', verified: true, passportNo: chance(0.5) ? `TR${int(10_000_000, 99_999_999)}` : undefined },
    })
    if (reg.status !== 200) {
      err('kayıt', reg)
      continue
    }
    res.animals++
    const animalId = reg.data.animalId
    res.backdate.push({ animalId, ownerId: reg.data.ownerId, date: implant })

    // Aşılar: çip günü karma, 2-4 hafta sonra kuduz; her yıl tekrar. Bazı sahipler bir süre sonra gelmeyi bırakır.
    const quitAfter = chance(0.3) ? int(1, 3) : 99
    let d = implant
    for (let year = 0; d < end && year <= quitAfter; year++) {
      for (const kind of ['combo', 'rabies'] as const) {
        const prod = productFor(kind, species)
        if (!prod) continue
        const given = kind === 'rabies' ? addDaysIso(d, int(14, 28)) : d
        if (given >= end || given > T) continue
        const v = await call('POST', '/api/vaccinations', {
          animalId,
          kind,
          productId: prod.id,
          lotNo: `L${int(1000, 9999)}${pick(['A', 'B', 'K'])}`,
          expiryDate: addDaysIso(given, int(200, 700)),
          givenAt: given,
          givenBy: vetOn(given).id,
          passportRecorded: kind === 'rabies',
        })
        if (v.status === 200) res.vaccinations++
        else err(`aşı ${kind}`, v)
      }
      d = weekday(addDaysIso(d, int(355, 380)))
    }

    // Muayeneler; çoğu bir randevudan gelir (randevu: geldi -> muayenede -> bitti)
    const n = int(1, 5)
    for (let k = 0; k < n; k++) {
      const vd = weekday(addDaysIso(implant, int(5, Math.max(6, days(implant, end) - 1))))
      if (vd >= end || vd >= T) continue
      const vet = vetOn(vd)
      const when = at(vd)
      if (types.length && chance(0.6)) {
        const type = pick(types)
        const ap = await call<{ appointment?: { id: string }; id?: string }>('POST', '/api/appointments', {
          animalId,
          startsAt: when,
          durationMinutes: type.defaultMinutes ?? 30,
          vetId: vet.id,
          typeId: type.id,
          reason: pick(['Kontrol', 'Aşı', 'Kulak kaşıntısı', 'Kusma', 'Diş taşı', 'Topallık', 'Genel muayene']),
          reminder: false,
        })
        if (ap.status === 200) {
          res.appointments++
          const id = ap.data.appointment?.id ?? ap.data.id
          for (const st of ['arrived', 'in_exam', 'done']) {
            const s = await call('POST', `/api/appointments/${id}/status`, { status: st })
            if (s.status !== 200) {
              err('randevu durumu', s)
              break
            }
          }
        } else err('randevu', ap)
      }
      const complaint = pick(COMPLAINTS)
      const healthy = complaint.startsWith('Genel') || complaint.startsWith('Aşı')
      const v = await call<{ id: string }>('POST', '/api/visits', {
        animalId,
        vetId: vet.id,
        visitAt: new Date(when).toISOString(),
        type: pick(['exam', 'exam', 'control', 'vaccine', 'emergency']),
        subjective: complaint,
        findings: {
          vitals: { temp: int(375, 393) / 10, pulse: isCat ? int(140, 200) : int(70, 130), resp: int(18, 36), weight: isCat ? int(30, 60) / 10 : int(50, 350) / 10, bcs: int(4, 6) },
          systems: { genel: { status: 'normal' } },
        },
        assessment: healthy ? 'Genel durum iyi.' : 'Klinik bulgular değerlendirildi.',
        diagnoses: healthy ? ['Sağlıklı'] : [pick(DIAGNOSES)],
        planText: healthy ? 'Rutin aşı takvimine devam.' : 'Tedavi başlandı, kontrol önerildi.',
        treatments: healthy ? [] : [{ ...pick(DRUGS), kind: chance(0.5) ? 'prescribed' : 'administered' }],
      })
      if (v.status !== 200) {
        err('muayene', v)
        continue
      }
      res.visits++
      const s = await call('POST', `/api/visits/${v.data.id}/sign`, {})
      if (s.status !== 200) err('imza', s)
    }

    if (dies) {
      const s = await call('POST', `/api/animals/${animalId}/death`, { date: end, cause: pick(['disease', 'disease', 'euthanasia', 'accident', 'unknown']), confirm: true })
      if (s.status === 200) res.deaths++
      else err('vefat', s)
    }
    if ((i + 1) % 20 === 0) log(`[geçmiş] ${i + 1}/${opts.count}`)
  }

  // Bu hayvanların PETVET bildirimleri zamanında girilmiş olmalı
  res.petvetDone += await closeOldPetvet(call, T, 45, err)
  return res
}

/** event tarihi `olderThanDays` günden eski bekleyen PETVET görevlerini "girildi" yapar (liste 100'lük sayfalarla gelir) */
export async function closeOldPetvet(call: Call, today: string, olderThanDays: number, err?: (w: string, x: { status: number; data: unknown }) => void): Promise<number> {
  const limit = addDaysIso(today, -olderThanDays)
  const r = rng(Date.now() % 1e9)
  let done = 0
  const skip = new Set<string>()
  for (;;) {
    const tasks = (await call<{ id: string; status: string; eventDate: string }[]>('GET', '/api/petvet/tasks?filter=open')).data
    const todo = tasks.filter((t) => t.status === 'pending' && t.eventDate < limit && !skip.has(t.id))
    if (!todo.length) break
    for (const t of todo) {
      const s = await call('POST', `/api/petvet/tasks/${t.id}/done`, { petvetRef: `PV-${100000 + Math.floor(r() * 900000)}` })
      if (s.status === 200) done++
      else {
        skip.add(t.id)
        err?.('PETVET', s)
      }
    }
  }
  return done
}
