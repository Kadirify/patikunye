// Raporlar ve yazdırma modülü - sunucu ve arayüzün paylaştığı tipler + saf yardımcılar
// (Code 128 B barkod kodlaması, CSV üretimi).
import type { Role } from './api-types'

// ---------------------------------------------------------------- raporlar

export const REPORT_KEYS = [
  'identification',
  'petvet',
  'chipless',
  'vaccines',
  'vaccine-compliance',
  'visits',
  'patients',
  'messages',
  'appointments',
] as const
export type ReportKey = (typeof REPORT_KEYS)[number]

export interface ReportDef {
  key: ReportKey
  title: string
  description: string
  /** Tarih aralığı filtresi anlamlı mı (çipsiz hayvanlar anlık durumdur) */
  usesRange: boolean
  /** Hekim filtresi var mı */
  usesVet: boolean
  /** Bu raporu görebilen roller (hepsinde ayrıca reports.view izni gerekir) */
  roles: Role[]
}

const ALL_REPORT_ROLES: Role[] = ['admin', 'vet', 'secretary']

export const REPORTS: ReportDef[] = [
  { key: 'identification', title: 'Kimliklendirme', description: 'Dönemde uygulanan çipler, PETVET durumu ve gecikme.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'petvet', title: 'PETVET uyum', description: 'Tür bazında görev sayısı, zamanında giriş oranı, ortalama giriş süresi, gecikenler.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'chipless', title: 'Çipsiz hayvanlar', description: '6 aydan büyük, aktif, çipsiz kedi/köpek/gelincik - arama listesi.', usesRange: false, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'vaccines', title: 'Aşı raporu', description: 'Uygulanan aşılar (tür, ürün, lot). Lot geri çağırma araması.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'vaccine-compliance', title: 'Aşı uyum oranı', description: 'Vadesi gelen aşılardan zamanında yapılanların oranı ve gecikenler.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'visits', title: 'Muayene istatistiği', description: 'Hekim, tür ve gün bazında muayene sayısı; en sık tanılar.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  { key: 'patients', title: 'Hasta tabanı', description: 'Aktif hayvanlar (tür, ırk, yaş), yeni hasta, 12 aydır gelmeyen.', usesRange: true, usesVet: true, roles: ['admin', 'vet'] },
  // Mesajların hekim boyutu yok; hekim rolüne kapalı (: S yalnızca randevu/mesaj)
  { key: 'messages', title: 'Mesaj raporu', description: 'Gönderilen / başarısız mesajlar, kanal ve tür bazında, birim (maliyet tahmini).', usesRange: true, usesVet: false, roles: ['admin', 'secretary'] },
  { key: 'appointments', title: 'Randevu raporu', description: 'Gelme / gelmeme oranı, iptaller, ortalama bekleme süresi.', usesRange: true, usesVet: true, roles: ALL_REPORT_ROLES },
]

export function reportDef(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key)
}

export type CellValue = string | number | null

export interface ReportColumn {
  key: string
  label: string
  /** Sayısal sütunlar sağa yaslanır; CSV'de ondalık virgülle yazılır */
  num?: boolean
  /** Arayüzde/baskıda eşit genişlikli yazı (çip no, telefon) */
  mono?: boolean
}

export interface ReportTable {
  title: string
  columns: ReportColumn[]
  rows: Record<string, CellValue>[]
  /** Satırlar sınırdan kesildiyse toplam satır sayısı */
  total?: number
  empty?: string
}

export interface ReportChart {
  title: string
  /** Değer biçimi: sayı ya da yüzde */
  unit?: '%'
  bars: { label: string; value: number }[]
}

export interface ReportResult {
  key: ReportKey
  title: string
  from: string
  to: string
  vetId: string | null
  vetName: string | null
  generatedAt: string
  summary: { label: string; value: string }[]
  chart: ReportChart | null
  tables: ReportTable[]
  notes?: string[]
}

export interface ReportsMetaDto {
  reports: ReportDef[]
  vets: { id: string; fullName: string }[]
  /** Hekim rolünde filtre kendisine sabitlenir */
  fixedVetId: string | null
  canExport: boolean
  canAuditPack: boolean
  today: string
}

/** Türkçe sayı biçimi (1.234,5) */
export function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Yüzde: 0,833 -> "83,3" (paydası 0 ise null) */
export function pct(part: number, whole: number): number | null {
  if (!whole) return null
  return Math.round((part / whole) * 1000) / 10
}

// ---------------------------------------------------------------- CSV (Türkçe Excel)

export const CSV_BOM = '﻿'
export const CSV_SEP = ';'

function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (typeof v === 'number') {
    s = Number.isInteger(v) ? String(v) : String(v).replace('.', ',')
  } else {
    s = v
    // Formül enjeksiyonuna karşı (=, +, -, @ ile başlayan metin hücreleri)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  }
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Rapor tablolarını CSV'ye çevirir: UTF-8 BOM, ';' ayraç, CRLF satır sonu.
 * Birden çok tablo varsa her biri başlık satırıyla, aralarında boş satır.
 */
export function reportToCsv(r: Pick<ReportResult, 'tables'>): string {
  const lines: string[] = []
  const many = r.tables.length > 1
  r.tables.forEach((t, i) => {
    if (many) {
      if (i > 0) lines.push('')
      lines.push(csvCell(t.title))
    }
    lines.push(t.columns.map((c) => csvCell(c.label)).join(CSV_SEP))
    for (const row of t.rows) lines.push(t.columns.map((c) => csvCell(row[c.key] ?? null)).join(CSV_SEP))
  })
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------- Code 128 (B kod kümesi)

/**
 * Code 128 desen tablosu: her değer için çubuk/boşluk genişlikleri (modül cinsinden)
 * çubukla başlar, dönüşümlü. 0-102 veri, 103/104/105 Start A/B/C, 106 Stop (7 eleman, 13 modül).
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
export const CODE128_START_B = 104
export const CODE128_STOP = 106

export interface Code128Encoding {
  /** Start B, veri değerleri, kontrol değeri, Stop */
  codes: number[]
  checksum: number
  /** Tüm desenlerin birleşimi (genişlik dizisi), ör. "211214...2331112" */
  pattern: string
  /** Sessiz bölge hariç toplam modül sayısı */
  modules: number
}

/** Metni Code 128 B ile kodlar (ASCII 32-126). Geçersiz karakterde hata fırlatır. */
export function encodeCode128B(text: string): Code128Encoding {
  if (!text) throw new Error('Barkod metni boş olamaz.')
  const data: number[] = []
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    if (ch.length !== 1 || c < 32 || c > 126) throw new Error(`Code 128 B ile kodlanamayan karakter: "${ch}"`)
    data.push(c - 32)
  }
  let sum = CODE128_START_B
  data.forEach((v, i) => (sum += v * (i + 1)))
  const checksum = sum % 103
  const codes = [CODE128_START_B, ...data, checksum, CODE128_STOP]
  const pattern = codes.map((c) => CODE128_PATTERNS[c]).join('')
  const modules = pattern.split('').reduce((a, d) => a + Number(d), 0)
  return { codes, checksum, pattern, modules }
}

/** Çubukların (siyah) konum ve genişlikleri - modül cinsinden, sessiz bölge `quiet` modül */
export function code128Bars(text: string, quiet = 10): { bars: { x: number; w: number }[]; width: number } {
  const enc = encodeCode128B(text)
  const bars: { x: number; w: number }[] = []
  let x = quiet
  enc.pattern.split('').forEach((d, i) => {
    const w = Number(d)
    if (i % 2 === 0) bars.push({ x, w })
    x += w
  })
  // Her desen çift sayıda eleman içerir (stop hariç 6, stop 7) -> çubuk/boşluk dönüşümü desenler arasında korunur
  return { bars, width: x + quiet }
}

// ---------------------------------------------------------------- yazdirma

export interface PrintClinic {
  name: string
  address: string | null
  city: string | null
  district: string | null
  phone: string | null
}

export interface PrintEnvelope<T = unknown> {
  kind: string
  clinic: PrintClinic
  generatedAt: string
  today: string
  data: T
}

export interface PrintAnimal {
  id: string
  name: string
  species: string
  speciesLabel: string
  breed: string | null
  sex: string
  sexLabel: string
  color: string | null
  birthDate: string | null
  birthDateEstimated: boolean
  neutered: boolean
  passportNo: string | null
  status: string
  chipNo: string | null
  chipImplantedAt: string | null
  chipBodySite: string | null
  chipVetName: string | null
}

export interface PrintOwner {
  id: string
  fullName: string
  /** Yalnızca maskeli: *******1234 */
  tcknMasked: string
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  district: string | null
}

export interface PrintVaccineCard {
  animal: PrintAnimal
  owner: PrintOwner | null
  vaccinations: { givenAt: string; kindLabel: string; product: string; lotNo: string | null; doseLabel: string | null; vetName: string | null; external: boolean; externalClinic: string | null }[]
  upcoming: { dueDate: string; kindLabel: string; doseLabel: string | null }[]
}

export interface PrintChipCard {
  animal: PrintAnimal
  owner: PrintOwner | null
  /** Sahip telefonu yalnızca istenirse (?owner=1) */
  showOwner: boolean
}

export interface PrintVisit {
  full: boolean
  animal: PrintAnimal
  owner: PrintOwner | null
  visit: {
    id: string
    visitAt: string
    typeLabel: string
    status: string
    version: number
    vetName: string | null
    vetRegNo: string | null
    signedAt: string | null
    subjective: string | null
    vitals: { label: string; value: string }[]
    systems: { label: string; status: string; note: string | null }[]
    assessment: string | null
    diagnoses: string[]
    differential: string[]
    planText: string | null
    tests: string | null
    ownerAdvice: string | null
    internalNote: string | null
    controlDate: string | null
    amendReason: string | null
  }
  treatments: {
    drug: string
    activeIngredient: string | null
    dose: string | null
    route: string | null
    frequency: string | null
    duration: string | null
    kind: 'administered' | 'prescribed'
    eReceteNo: string | null
    note: string | null
  }[]
}

export interface PrintKvkkConsent {
  owner: PrintOwner
  animal: PrintAnimal | null
  notice: { version: number; body: string } | null
  consent: { version: number; body: string } | null
}

export interface AuditPackRow {
  kind: string
  kindLabel: string
  chipNo: string | null
  animalName: string
  speciesLabel: string
  ownerName: string | null
  tcknMasked: string
  eventDate: string
  dueDate: string
  status: string
  statusLabel: string
  doneDate: string | null
  /** PETVET giriş tarihi - olay tarihi */
  daysToEntry: number | null
  /** Girişin son tarihe göre gecikmesi (+) ya da erken (-/0) */
  lateDays: number | null
  petvetRef: string | null
  vetName: string | null
  attachments: string[]
}

export interface PrintAuditPack {
  from: string
  to: string
  vetName: string | null
  kinds: string[]
  doneOnly: boolean
  summary: { kindLabel: string; total: number; done: number; onTime: number; late: number; open: number }[]
  rows: AuditPackRow[]
  attachments: { taskLabel: string; fileName: string; size: number; createdAt: string }[]
  fileName: string
}

export interface PrintKvkkResponse {
  owner: PrintOwner
  request: {
    id: string
    typeLabel: string
    type: string
    channelLabel: string
    receivedAt: string
    dueDate: string
    status: string
    statusLabel: string
    note: string | null
    responseNote: string | null
    closedAt: string | null
    closedByName: string | null
  }
}

export interface PrintAppointmentCard {
  startsAt: string
  endsAt: string
  vetName: string | null
  typeName: string | null
  reason: string | null
  animalName: string | null
  ownerName: string | null
  statusLabel: string
}

export interface PrintWorklist {
  list: 'petvet' | 'vaccine-calls'
  title: string
  columns: ReportColumn[]
  rows: Record<string, CellValue>[]
}
