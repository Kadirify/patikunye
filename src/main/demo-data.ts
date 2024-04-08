// Örnek (test) verisi: uygulamanın kendi API'si üzerinden üretilir, böylece PETVET görevleri, aşı planları,
// hatırlatmalar ve denetim kaydı gerçek kullanımdaki gibi oluşur. Tüm kişiler ve numaralar uydurmadır.
import { addDaysIso } from '../shared/petvet'

export type Call = <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; data: T }>

export interface DemoSummary {
  users: number
  owners: number
  animals: number
  chips: number
  petvetDone: number
  vaccinations: number
  visits: number
  appointments: number
  statusChanges: number
  kvkk: number
  errors: string[]
}

/* Basit tohumlu rastgele sayı üreteci (her çalıştırmada farklı ama yeniden üretilebilir) */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const FIRST_M = ['Ahmet', 'Mehmet', 'Mustafa', 'Ali', 'Hasan', 'Hüseyin', 'İbrahim', 'Murat', 'Emre', 'Burak', 'Can', 'Okan', 'Serkan', 'Kemal', 'Tuna', 'Barış', 'Oğuz', 'Cem', 'Kerem', 'Yusuf', 'Ömer', 'Selim', 'Hakan', 'Volkan']
export const FIRST_F = ['Ayşe', 'Fatma', 'Elif', 'Zeynep', 'Merve', 'Selin', 'Gizem', 'Deniz', 'Ece', 'Nur', 'Derya', 'Sevgi', 'Esra', 'Büşra', 'İrem', 'Gül', 'Şule', 'Özge', 'Pınar', 'Cansu', 'Ebru', 'Tuğba', 'Damla', 'Melis']
export const LAST = ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Yıldırım', 'Öztürk', 'Aydın', 'Özdemir', 'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek', 'Polat', 'Erdoğan', 'Akın', 'Tunç', 'Uçar', 'Sarı', 'Ak', 'Öz', 'Er', 'Güneş']
export const PLACES: [string, string][] = [
  ['İstanbul', 'Beyoğlu'], ['İstanbul', 'Kadıköy'], ['İstanbul', 'Beşiktaş'], ['İstanbul', 'Üsküdar'], ['İstanbul', 'Şişli'],
  ['Ankara', 'Çankaya'], ['Ankara', 'Yenimahalle'], ['İzmir', 'Karşıyaka'], ['İzmir', 'Bornova'], ['Bursa', 'Nilüfer'],
]
export const CAT_NAMES = ['Pamuk', 'Duman', 'Tarçın', 'Fıstık', 'Mia', 'Zeytin', 'Boncuk', 'Bulut', 'Minnoş', 'Paşa', 'Karamel', 'Şila', 'Ponçik', 'Kont', 'Lokum', 'Mırmır', 'Tekir', 'Gece', 'Biber', 'Limon']
export const DOG_NAMES = ['Karabaş', 'Çomar', 'Limon', 'Paşa', 'Reis', 'Maya', 'Bal', 'Zeus', 'Max', 'Luna', 'Toprak', 'Rocky', 'Leo', 'Fındık', 'Kömür', 'Badem', 'Sarı', 'Duman', 'Tarçın', 'Odin']
const OTHER = [
  { species: 'ferret', names: ['Gelo', 'Şimşek'], breeds: ['Standart'], colors: ['Sable'] },
  { species: 'rabbit', names: ['Havuç', 'Pofuduk'], breeds: ['Holland Lop', 'Melez'], colors: ['Beyaz', 'Gri'] },
  { species: 'bird', names: ['Maviş', 'Cıvıl'], breeds: ['Muhabbet kuşu', 'Sultan papağanı'], colors: ['Mavi', 'Sarı'] },
]
export const CAT_BREEDS = ['Tekir', 'British Shorthair', 'Scottish Fold', 'Van kedisi', 'Ankara kedisi', 'Persian', 'Siyam', 'Melez', 'Bengal']
export const DOG_BREEDS = ['Golden Retriever', 'Labrador Retriever', 'Kangal', 'Alman Çoban Köpeği', 'Maltese Terrier', 'Pomeranian', 'Beagle', 'Melez', 'Siberian Husky', 'Jack Russell Terrier', 'Pug']
export const CAT_COLORS = ['Gri tekir', 'Sarı tekir', 'Siyah', 'Beyaz', 'Siyah-beyaz', 'Üç renkli', 'Krem', 'Mavi-gri']
export const DOG_COLORS = ['Sarı', 'Siyah', 'Kahverengi', 'Beyaz', 'Açık kahve, maskeli', 'Üç renkli', 'Krem', 'Gri-beyaz']
export const COMPLAINTS = [
  'Genel kontrol, iştah ve dışkılama normal.',
  'İki gündür kusma ve iştahsızlık.',
  'Kulaklarını sık kaşıyor, baş sallıyor.',
  'Sol arka bacağını basmıyor.',
  'Öksürük ve hapşırık, burun akıntısı.',
  'Tüy dökülmesi ve kaşıntı.',
  'Kısırlaştırma sonrası kontrol.',
  'Aşı öncesi genel muayene.',
  'İshal, son 24 saatte 4–5 kez.',
  'Diş taşı ve ağız kokusu.',
]
export const DIAGNOSES = ['Otitis externa', 'Akut gastroenterit', 'Dermatit', 'Üst solunum yolu enfeksiyonu', 'Diş taşı', 'Yumuşak doku travması', 'Sağlıklı', 'Kulak akarı', 'Gıda intoleransı']
export const DRUGS = [
  { drug: 'Amoksisilin + Klavulanik asit', dose: 12.5, doseUnit: 'mg/kg', route: 'Oral', frequency: '2×1', duration: '7 gün' },
  { drug: 'Meloksikam', dose: 0.1, doseUnit: 'mg/kg', route: 'Oral', frequency: '1×1', duration: '3 gün' },
  { drug: 'Maropitant', dose: 1, doseUnit: 'mg/kg', route: 'SC', frequency: '1×1', duration: '1 gün' },
  { drug: 'Kulak damlası (gentamisin içeren)', dose: 4, doseUnit: 'damla', route: 'Kulak', frequency: '2×1', duration: '10 gün' },
  { drug: 'Probiyotik macun', dose: 1, doseUnit: 'g', route: 'Oral', frequency: '1×1', duration: '5 gün' },
]

/** Geçerli (algoritmaya uyan) ama uydurma TCKN */
export function fakeTckn(r: () => number): string {
  const d = [1 + Math.floor(r() * 9), ...Array.from({ length: 8 }, () => Math.floor(r() * 10))]
  const odd = d[0] + d[2] + d[4] + d[6] + d[8]
  const even = d[1] + d[3] + d[5] + d[7]
  d.push((((odd * 7 - even) % 10) + 10) % 10)
  d.push(d.reduce((a, b) => a + b, 0) % 10)
  return d.join('')
}

export async function seedDemoData(call: Call, opts: { today: string; log?: (m: string) => void; size?: number }): Promise<DemoSummary> {
  const r = rng(Date.now() % 1e9)
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const chance = (p: number) => r() < p
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
  const T = opts.today
  const log = opts.log ?? (() => undefined)
  const size = opts.size ?? 60
  const sum: DemoSummary = { users: 0, owners: 0, animals: 0, chips: 0, petvetDone: 0, vaccinations: 0, visits: 0, appointments: 0, statusChanges: 0, kvkk: 0, errors: [] }
  const err = (what: string, res: { status: number; data: unknown }) => {
    const msg = `${what}: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`
    if (sum.errors.length < 30) sum.errors.push(msg)
    log('[demo] ' + msg)
  }
  const usedChips = new Set<string>()
  const chipNo = () => {
    let c = ''
    do c = '792091' + String(int(0, 999_999_999)).padStart(9, '0')
    while (usedChips.has(c))
    usedChips.add(c)
    return c
  }
  const phone = () => `05${pick(['30', '32', '33', '35', '36', '41', '42', '43', '44', '52', '53', '54', '55'])}${String(int(0, 9_999_999)).padStart(7, '0')}`

  /* 1) Kullanıcılar (hekim, sekreter, teknisyen) */
  const usersBefore = await call<{ id: string; role: string; fullName: string }[]>('GET', '/api/users')
  const existingNames = new Set(usersBefore.data.map((u) => u.fullName))
  const newUsers = [
    { fullName: 'Dr. Can Ertürk', role: 'vet', chamberRegNo: '34-2211', username: 'can.erturk' },
    { fullName: 'Dr. Selin Aydın', role: 'vet', chamberRegNo: '34-3105', username: 'selin.aydin' },
    { fullName: 'Zehra Koç', role: 'secretary', username: 'zehra.koc' },
    { fullName: 'Emre Aksoy', role: 'tech', username: 'emre.aksoy' },
  ]
  for (const u of newUsers) {
    if (existingNames.has(u.fullName)) continue
    const res = await call('POST', '/api/admin/users', u)
    if (res.status === 200) sum.users++
    else if (res.status !== 409) err('kullanıcı', res)
  }
  const users = (await call<{ id: string; role: string; fullName: string }[]>('GET', '/api/users')).data
  const vets = users.filter((u) => u.role === 'vet' || u.role === 'admin')

  /* 2) Sahip + hayvan + çip (hızlı kayıt) — çip tarihleri son 75 güne yayılır */
  type A = { id: string; ownerId: string; species: string; name: string; birthDate: string; chip: boolean }
  const animals: A[] = []
  for (let i = 0; i < size; i++) {
    const female = chance(0.5)
    const first = pick(female ? FIRST_F : FIRST_M)
    const [city, district] = pick(PLACES)
    const isCat = chance(0.55)
    const species = isCat ? 'cat' : 'dog'
    const ageDays = int(200, 4500)
    const implantAgo = i < 6 ? int(0, 3) : int(0, 75)
    const implantDate = addDaysIso(T, -implantAgo)
    const birthDate = addDaysIso(T, -ageDays)
    const name = pick(isCat ? CAT_NAMES : DOG_NAMES)
    const res = await call<{ animalId: string; ownerId: string }>('POST', '/api/quick-register', {
      chipNo: chipNo(),
      owner: {
        firstName: first,
        lastName: pick(LAST),
        tckn: chance(0.8) ? fakeTckn(r) : undefined,
        phone: phone(),
        email: chance(0.4) ? `${first.toLocaleLowerCase('tr-TR').replace(/[^a-z]/g, '') || 'sahip'}${int(10, 99)}@ornek.test` : undefined,
        city,
        district,
        address: `${pick(['Atatürk', 'Cumhuriyet', 'İnönü', 'Gazi', 'Lale', 'Menekşe'])} Cad. No:${int(1, 120)}`,
        kvkkNotice: true,
        reminderConsent: chance(0.9),
      },
      animal: {
        name,
        species,
        breed: pick(isCat ? CAT_BREEDS : DOG_BREEDS),
        sex: chance(0.5) ? 'female' : 'male',
        neutered: chance(0.45),
        birthDate: birthDate > implantDate ? implantDate : birthDate,
        birthDateEstimated: chance(0.3),
        color: pick(isCat ? CAT_COLORS : DOG_COLORS),
      },
      implant: { date: implantDate, vetId: pick(vets).id, bodySite: chance(0.9) ? 'Boyun sol' : 'Sol arka bacak', verified: true, passportNo: chance(0.3) ? `TR${int(10_000_000, 99_999_999)}` : undefined },
    })
    if (res.status !== 200) {
      err('hızlı kayıt', res)
      continue
    }
    sum.owners++
    sum.animals++
    sum.chips++
    animals.push({ id: res.data.animalId, ownerId: res.data.ownerId, species, name, birthDate, chip: true })
  }
  log(`[demo] ${sum.animals} hayvan kaydedildi`)

  /* 3) Ek hayvanlar: aynı sahibin ikinci hayvanı (çipsiz) ve egzotik türler */
  for (let i = 0; i < Math.round(size / 4) && animals.length; i++) {
    const owner = pick(animals).ownerId
    const exotic = chance(0.35) ? pick(OTHER) : null
    const isCat = chance(0.5)
    const species = exotic?.species ?? (isCat ? 'cat' : 'dog')
    const name = exotic ? pick(exotic.names) : pick(isCat ? CAT_NAMES : DOG_NAMES)
    const birthDate = addDaysIso(T, -int(60, 2500))
    const res = await call<{ id: string }>('POST', '/api/animals', {
      ownerId: owner,
      name,
      species,
      breed: exotic ? pick(exotic.breeds) : pick(isCat ? CAT_BREEDS : DOG_BREEDS),
      sex: chance(0.5) ? 'female' : 'male',
      neutered: false,
      birthDate,
      birthDateEstimated: true,
      color: exotic ? pick(exotic.colors) : pick(isCat ? CAT_COLORS : DOG_COLORS),
      allergies: chance(0.15) ? ['Penisilin'] : [],
      behavior: chance(0.1) ? 'bites' : undefined,
      weightKg: species === 'cat' ? int(25, 60) / 10 : species === 'dog' ? int(40, 380) / 10 : undefined,
    })
    if (res.status !== 200) {
      err('ek hayvan', res)
      continue
    }
    sum.animals++
    animals.push({ id: res.data.id, ownerId: owner, species, name, birthDate, chip: false })
  }

  /* 4) PETVET: eski görevlerin çoğu "girildi", yenilerin bir kısmı; bir kısmı bilerek geciktirilir */
  const tasks = (await call<{ id: string; status: string; eventDate: string; daysLeft: number }[]>('GET', '/api/petvet/tasks?filter=open')).data
  for (const t of tasks) {
    if (t.status !== 'pending') continue
    const age = -Math.round((Date.parse(t.eventDate) - Date.parse(T)) / 86_400_000)
    const p = age > 20 ? 0.85 : age > 8 ? 0.55 : 0.15
    if (!chance(p)) continue
    const res = await call('POST', `/api/petvet/tasks/${t.id}/done`, { petvetRef: chance(0.6) ? `PV-${int(100000, 999999)}` : undefined })
    if (res.status === 200) sum.petvetDone++
    else err('PETVET girildi', res)
  }

  /* 5) Aşılar: karma ve kuduz, bazıları bir yıl önce (vadesi geçmiş/yaklaşan rapel) */
  const products = (await call<{ id: string; kind: string; species: string[]; active: boolean }[]>('GET', '/api/vaccine-products')).data
  const productFor = (kind: string, species: string) => products.find((p) => p.kind === kind && p.active && (p.species.length === 0 || p.species.includes(species)))
  for (const a of animals.filter((x) => x.species === 'cat' || x.species === 'dog')) {
    if (!chance(0.75)) continue
    for (const kind of ['combo', 'rabies'] as const) {
      if (kind === 'rabies' && !chance(0.7)) continue
      const prod = productFor(kind, a.species)
      if (!prod) continue
      // Vade dağılımı: geçen yılın aynı dönemi (rapeli yaklaşan/geciken) ya da son aylar
      let ago = chance(0.4) ? int(340, 395) : int(5, 200)
      let givenAt = addDaysIso(T, -ago)
      if (givenAt < a.birthDate) {
        ago = Math.max(0, Math.round((Date.parse(T) - Date.parse(a.birthDate)) / 86_400_000) - 10)
        givenAt = addDaysIso(T, -ago)
      }
      const res = await call('POST', '/api/vaccinations', {
        animalId: a.id,
        kind,
        productId: prod.id,
        lotNo: `L${int(1000, 9999)}${pick(['A', 'B', 'K'])}`,
        expiryDate: addDaysIso(givenAt, int(120, 600)),
        givenAt,
        givenBy: pick(vets).id,
        passportRecorded: kind === 'rabies' && chance(0.6),
      })
      if (res.status === 200) sum.vaccinations++
      else err(`aşı (${kind})`, res)
    }
  }
  log(`[demo] ${sum.vaccinations} aşı`)

  /* 6) Muayeneler: son 60 gün; çoğu imzalı, bazıları taslak */
  for (let i = 0; i < Math.round(size * 1.2) && animals.length; i++) {
    const a = pick(animals)
    const daysAgo = int(0, 60)
    const visitAt = new Date(`${addDaysIso(T, -daysAgo)}T${String(int(9, 17)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}:00+03:00`)
    if (visitAt.getTime() > Date.now()) visitAt.setTime(Date.now() - 3600_000)
    const isCat = a.species === 'cat'
    const weight = a.species === 'cat' ? int(30, 60) / 10 : a.species === 'dog' ? int(50, 350) / 10 : undefined
    const complaint = pick(COMPLAINTS)
    const healthy = complaint.startsWith('Genel') || complaint.startsWith('Aşı')
    const res = await call<{ id: string; rev: number }>('POST', '/api/visits', {
      animalId: a.id,
      vetId: pick(vets).id,
      visitAt: visitAt.toISOString(),
      type: pick(['exam', 'exam', 'control', 'vaccine', 'emergency']),
      subjective: complaint,
      findings: {
        vitals: { temp: int(375, 393) / 10, pulse: isCat ? int(140, 200) : int(70, 130), resp: int(18, 36), weight, bcs: int(4, 6) },
        systems: { genel: { status: 'normal' }, deri: { status: healthy || chance(0.7) ? 'normal' : 'abnormal', note: healthy ? undefined : 'Hafif eritem' } },
      },
      assessment: healthy ? 'Genel durum iyi.' : 'Klinik bulgular değerlendirildi.',
      diagnoses: healthy ? ['Sağlıklı'] : [pick(DIAGNOSES)],
      planText: healthy ? 'Rutin aşı takvimine devam.' : 'Tedavi başlandı, kontrol önerildi.',
      ownerAdvice: healthy ? undefined : 'İlaçları saatinde verin, iştah azalırsa arayın.',
      controlDate: !healthy && chance(0.4) ? addDaysIso(T, int(2, 14)) : undefined,
      treatments: healthy ? [] : [{ ...pick(DRUGS), kind: chance(0.5) ? 'prescribed' : 'administered' }],
    })
    if (res.status !== 200) {
      err('muayene', res)
      continue
    }
    sum.visits++
    if (chance(0.88)) {
      const s = await call('POST', `/api/visits/${res.data.id}/sign`, {})
      if (s.status !== 200) err('muayene imza', s)
    }
  }
  log(`[demo] ${sum.visits} muayene`)

  /* 7) Randevular: geçmiş 10 gün, bugün (bekleme salonu dolu) ve önümüzdeki 14 gün */
  const types = (await call<{ id: string; name: string; defaultMinutes: number; active: boolean }[]>('GET', '/api/appointment-types')).data.filter((t) => t.active)
  const realVets = vets.length ? vets : users
  const mk = async (dayOffset: number, hh: number, mm: number, status: string[]) => {
    const a = pick(animals)
    const type = pick(types)
    const day = addDaysIso(T, dayOffset)
    const res = await call<{ appointment?: { id: string; version: number }; id?: string; version?: number }>('POST', '/api/appointments', {
      animalId: a.id,
      startsAt: `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+03:00`,
      durationMinutes: type?.defaultMinutes ?? 30,
      vetId: pick(realVets).id,
      typeId: type.id,
      reason: pick(['Kontrol', 'Aşı', 'Kulak kaşıntısı', 'Kusma', 'Çip uygulama', 'Diş taşı', 'Topallık', 'Genel muayene']),
      reminder: dayOffset > 0,
    })
    if (res.status !== 200) {
      err('randevu', res)
      return
    }
    sum.appointments++
    const id = res.data.appointment?.id ?? res.data.id
    for (const st of status) {
      const s = await call('POST', `/api/appointments/${id}/status`, st === 'cancelled' ? { status: st, cancelledBySide: chance(0.7) ? 'owner' : 'clinic', cancelReason: 'Sahip gelemeyeceğini bildirdi' } : { status: st, room: st === 'in_exam' ? `Oda ${int(1, 2)}` : undefined })
      if (s.status !== 200) {
        err(`randevu durumu ${st}`, s)
        break
      }
    }
  }
  if (types.length && animals.length) {
    for (let d = -10; d <= -1; d++) {
      for (let k = 0; k < int(2, 4); k++) {
        const roll = r()
        await mk(d, int(9, 16), pick([0, 15, 30, 45]), roll < 0.75 ? ['arrived', 'in_exam', 'done'] : roll < 0.88 ? ['no_show'] : ['cancelled'])
      }
    }
    // Bugün: sabah bitenler, öğlen bekleyenler/muayenede, öğleden sonra planlı
    const todaySlots: [number, number, string[]][] = [
      [9, 0, ['arrived', 'in_exam', 'done']], [9, 30, ['arrived', 'in_exam', 'done']], [10, 15, ['arrived', 'in_exam', 'done']],
      [10, 45, ['arrived', 'in_exam']], [11, 0, ['arrived']], [11, 30, ['arrived']], [11, 45, []],
      [13, 30, []], [14, 0, []], [14, 45, []], [15, 15, []], [16, 0, ['cancelled']], [16, 30, []],
    ]
    for (const [h, m, st] of todaySlots) await mk(0, h, m, st)
    for (let d = 1; d <= 14; d++) {
      if (new Date(addDaysIso(T, d) + 'T12:00:00+03:00').getUTCDay() === 0) continue
      for (let k = 0; k < int(1, 4); k++) await mk(d, int(9, 16), pick([0, 15, 30, 45]), chance(0.2) ? ['confirmed'] : [])
    }
  }
  log(`[demo] ${sum.appointments} randevu`)

  /* 8) Durum değişiklikleri: ölüm, kayıp, bulundu, devir */
  const chipped = animals.filter((a) => a.chip)
  const take = (n: number) => chipped.splice(0, n)
  for (const a of take(2)) {
    const s = await call('POST', `/api/animals/${a.id}/death`, { date: addDaysIso(T, -int(1, 20)), cause: pick(['disease', 'accident', 'unknown']), confirm: true })
    if (s.status === 200) sum.statusChanges++
    else err('ölüm', s)
  }
  for (const [i, a] of take(3).entries()) {
    const s = await call('POST', `/api/animals/${a.id}/lost`, { date: addDaysIso(T, -int(2, 15)), openPetvet: true, location: 'Mahalle parkı' })
    if (s.status === 200) sum.statusChanges++
    else err('kayıp', s)
    if (i === 0) {
      const f = await call('POST', `/api/animals/${a.id}/found`, { date: T })
      if (f.status === 200) sum.statusChanges++
      else err('bulundu', f)
    }
  }
  for (const a of take(2)) {
    const to = animals.find((x) => x.ownerId !== a.ownerId)
    if (!to) break
    const s = await call('POST', `/api/animals/${a.id}/transfer`, { date: T, newOwnerId: to.ownerId, reason: 'Aile içi devir' })
    if (s.status === 200) sum.statusChanges++
    else err('devir', s)
  }

  /* 9) KVKK talepleri */
  for (const [i, a] of animals.slice(-2).entries()) {
    const s = await call('POST', '/api/kvkk/requests', {
      ownerId: a.ownerId,
      type: i === 0 ? 'copy' : 'info',
      receivedAt: addDaysIso(T, -int(1, 20)),
      channel: i === 0 ? 'email' : 'written',
      note: 'Örnek talep',
    })
    if (s.status === 200) sum.kvkk++
    else err('KVKK', s)
  }

  log(`[demo] bitti: ${JSON.stringify({ ...sum, errors: sum.errors.length })}`)
  return sum
}
