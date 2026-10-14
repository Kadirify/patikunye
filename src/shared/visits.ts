// Muayene ve tedavi modülü - API girdi/çıktı tipleri ve ortak kurallar
import type { Sex, Species } from './api-types'

export const VISIT_TYPES = ['exam', 'control', 'emergency', 'vaccine', 'surgery', 'home'] as const
export type VisitType = (typeof VISIT_TYPES)[number]
export const VISIT_TYPE_LABEL: Record<VisitType, string> = {
  exam: 'Muayene',
  control: 'Kontrol',
  emergency: 'Acil',
  vaccine: 'Aşı ziyareti',
  surgery: 'Operasyon',
  home: 'Ev ziyareti',
}

export type VisitStatus = 'draft' | 'signed'
/** Listede gösterilen durum: imzalı ve versiyon > 1 ise "düzeltilmiş" */
export type VisitDisplayStatus = 'draft' | 'signed' | 'amended'
export const VISIT_STATUS_LABEL: Record<VisitDisplayStatus, string> = { draft: 'Taslak', signed: 'İmzalı', amended: 'Düzeltilmiş' }

export const SYSTEM_KEYS = [
  'genel',
  'deri',
  'goz_kulak',
  'agiz',
  'lenf',
  'solunum',
  'dolasim',
  'sindirim',
  'urogenital',
  'kas_iskelet',
  'sinir',
] as const
export type SystemKey = (typeof SYSTEM_KEYS)[number]
export const SYSTEM_LABEL: Record<SystemKey, string> = {
  genel: 'Genel durum',
  deri: 'Deri / tüy',
  goz_kulak: 'Göz / kulak',
  agiz: 'Ağız / diş',
  lenf: 'Lenf yumrusu',
  solunum: 'Solunum',
  dolasim: 'Dolaşım',
  sindirim: 'Sindirim',
  urogenital: 'Ürogenital',
  kas_iskelet: 'Kas-iskelet',
  sinir: 'Sinir sistemi',
}

export interface Vitals {
  /** Ateş °C */
  temp?: number | null
  /** Nabız /dk */
  pulse?: number | null
  /** Solunum /dk */
  resp?: number | null
  /** Kilo kg */
  weight?: number | null
  /** Vücut kondisyon skoru 1-9 */
  bcs?: number | null
  /** Kapiller dolum zamanı (sn) */
  crt?: number | null
  /** Dehidrasyon % */
  dehydration?: number | null
  /** Mukoza (serbest metin: pembe, soluk, ikterik...) */
  mucosa?: string | null
}

export interface SystemFinding {
  status: 'normal' | 'abnormal'
  note?: string
}

export interface Findings {
  vitals: Vitals
  systems: Partial<Record<SystemKey, SystemFinding>>
}

/** Doğrulama sınırları. hard = engel, warn = uyarı */
export const VITAL_LIMITS = {
  temp: { hard: [30, 45], warn: [35, 43], label: 'Ateş' },
  pulse: { hard: [1, 400], label: 'Nabız' },
  resp: { hard: [1, 200], label: 'Solunum' },
  weight: { hard: [0.01, 150], label: 'Kilo' },
  bcs: { hard: [1, 9], label: 'VKS' },
  crt: { hard: [0, 10], label: 'KDZ' },
  dehydration: { hard: [0, 20], label: 'Dehidrasyon' },
} as const

/** Kilo önceki ölçümden ±%30 farklıysa "Emin misiniz?" */
export function weightJumpWarning(prev: number | null | undefined, next: number | null | undefined): boolean {
  if (!prev || !next) return false
  return Math.abs(next - prev) / prev > 0.3
}

export const DOSE_UNITS = ['mg', 'ml', 'g', 'IU', 'tablet', 'kapsül', 'damla', 'puf', 'mg/kg', 'ml/kg', 'IU/kg'] as const
export type DoseUnit = (typeof DOSE_UNITS)[number]
export const isPerKg = (u: string | null | undefined) => !!u && u.endsWith('/kg')

export const ROUTES = ['Oral', 'SC', 'IM', 'IV', 'Topikal', 'Göz', 'Kulak', 'Rektal', 'İnhalasyon', 'Diğer'] as const

export type TreatmentKind = 'administered' | 'prescribed'
export const TREATMENT_KIND_LABEL: Record<TreatmentKind, string> = { administered: 'Klinikte uygulandı', prescribed: 'Reçete edildi' }

export interface TreatmentInput {
  drug: string
  activeIngredient?: string | null
  dose?: number | null
  doseUnit?: DoseUnit | null
  route?: string | null
  frequency?: string | null
  duration?: string | null
  kind: TreatmentKind
  eReceteNo?: string | null
  note?: string | null
  /** Alerji uyarısına rağmen hekim onayladı */
  allergyAck?: boolean
}

export interface TreatmentDto extends Required<Omit<TreatmentInput, 'allergyAck'>> {
  id: string
  visitId: string
  perKg: boolean
  /** mg/kg dozda kiloya göre hesaplanan toplam (birim: doseUnit'in /kg'siz hali) */
  totalDose: number | null
  durationDays: number | null
  allergyAck: boolean
}

export interface AnimalTreatmentDto extends TreatmentDto {
  visitAt: string
  vetName: string | null
  visitStatus: VisitStatus
  /** Süre bitmediyse true */
  active: boolean
  endDate: string | null
}

/** Taslak oluştur/güncelle girdisi (hepsi isteğe bağlı; PATCH kısmi) */
export interface VisitInput {
  vetId?: string | null
  visitAt?: string
  type?: VisitType
  subjective?: string | null
  findings?: Findings
  assessment?: string | null
  diagnoses?: string[]
  differential?: string[]
  planText?: string | null
  tests?: string | null
  ownerAdvice?: string | null
  internalNote?: string | null
  controlDate?: string | null
  treatments?: TreatmentInput[]
}

export interface VisitCreateInput extends VisitInput {
  animalId: string
  appointmentId?: string | null
}

export interface VisitPatchInput extends VisitInput {
  /** İyimser kilit: istemcinin bildiği revizyon */
  rev: number
}

export interface VisitVersionRef {
  id: string
  version: number
  status: VisitStatus
  signedAt: string | null
  signedByName: string | null
  amendReason: string | null
}

export interface VisitAnimalDto {
  id: string
  name: string
  species: Species
  breed: string | null
  sex: Sex
  neutered: boolean
  birthDate: string | null
  allergies: string[]
  behavior: string | null
  chipNo: string | null
  status: string
}

export interface VisitOwnerDto {
  id: string
  fullName: string
  phone: string | null
  address: string | null
  city: string | null
  district: string | null
}

/** GET /api/visits/:id - yazdırma modülü de kullanır */
export interface VisitDetail {
  id: string
  /** true ise kullanıcının içerik izni yok (sekreter): yalnızca tarih/hekim/tür dolu */
  restricted: boolean
  animalId: string
  vetId: string | null
  vetName: string | null
  vetChamberRegNo: string | null
  visitAt: string
  type: VisitType
  appointmentId: string | null
  status: VisitStatus
  displayStatus: VisitDisplayStatus
  signedAt: string | null
  signedBy: string | null
  signedByName: string | null
  version: number
  supersedesId: string | null
  /** Bu versiyonun yerini alan (imzalı ya da taslak) sonraki versiyon */
  supersededById: string | null
  amendReason: string | null
  rev: number
  subjective: string | null
  findings: Findings
  assessment: string | null
  diagnoses: string[]
  differential: string[]
  planText: string | null
  tests: string | null
  ownerAdvice: string | null
  internalNote: string | null
  controlDate: string | null
  treatments: TreatmentDto[]
  animal: VisitAnimalDto
  owner: VisitOwnerDto | null
  versions: VisitVersionRef[]
  createdAt: string
  createdByName: string | null
  updatedAt: string
  updatedByName: string | null
}

export interface VisitListItem {
  id: string
  visitAt: string
  type: VisitType
  status: VisitStatus
  displayStatus: VisitDisplayStatus
  version: number
  /** 24 saatten eski taslak */
  stale: boolean
  animalId: string
  animalName: string
  species: Species
  ownerName: string | null
  vetId: string | null
  vetName: string | null
  /** Sekreterde null */
  diagnosisSummary: string | null
  controlDate: string | null
}

export interface VisitListResult {
  rows: VisitListItem[]
  total: number
}

export type VisitStatusFilter = 'all' | 'draft' | 'signed' | 'amended' | 'stale'

/** Muayene ekranının sol paneli */
export interface VisitAnimalContext {
  animal: VisitAnimalDto
  owner: VisitOwnerDto | null
  lastWeight: { kg: number; measuredAt: string } | null
  /** Son imzalı muayenenin vitalleri (karşılaştırma için gri gösterilir) */
  previousVitals: { visitId: string; visitAt: string; vitals: Vitals } | null
  /** Son 3 muayene özeti (içerik izni yoksa boş) */
  recentVisits: { id: string; visitAt: string; vetName: string | null; type: VisitType; summary: string; status: VisitStatus }[]
  activeTreatments: AnimalTreatmentDto[]
}

export interface DiagnosisSuggestion {
  name: string
  category: string | null
  /** Bu klinikte kaç kez kullanıldı */
  uses: number
}

export interface VisitPhrase {
  id: string
  shortcut: string
  text: string
  field: 'subjective' | 'assessment' | 'plan' | 'advice' | 'any'
}

export interface DrugSuggestion {
  drug: string
  activeIngredient: string | null
  dose: number | null
  doseUnit: DoseUnit | null
  route: string | null
  frequency: string | null
  duration: string | null
  uses: number
}

/** Türkçe metin karşılaştırması için sadeleştirme (alerji eşleşmesi) */
export function trNorm(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/** Tedavi satırı hayvanın alerji listesinden biriyle eşleşiyor mu? Eşleşen alerjiyi döner. */
export function allergyMatch(allergies: string[], t: { drug?: string | null; activeIngredient?: string | null }): string | null {
  const hay = [t.activeIngredient, t.drug].filter(Boolean).map((x) => trNorm(x!))
  if (!hay.length) return null
  for (const a of allergies) {
    const n = trNorm(a)
    if (n.length < 3) continue
    if (hay.some((h) => h.includes(n) || (h.length >= 3 && n.includes(h)))) return a
  }
  return null
}

/** "7 gün", "2 hafta", "1 ay" -> gün sayısı (anlaşılmazsa null) */
export function parseDurationDays(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /(\d+)\s*(gün|gun|g|hafta|hf|ay)?/i.exec(s)
  if (!m) return null
  const n = Number(m[1])
  const u = (m[2] ?? 'gün').toLocaleLowerCase('tr-TR')
  if (u.startsWith('hafta') || u === 'hf') return n * 7
  if (u === 'ay') return n * 30
  return n
}

/** mg/kg doz -> toplam doz (3 ondalığa yuvarlanır) */
export function totalDose(dose: number | null | undefined, unit: string | null | undefined, weightKg: number | null | undefined): number | null {
  if (!isPerKg(unit) || dose == null || !weightKg) return null
  return Math.round(dose * weightKg * 1000) / 1000
}
