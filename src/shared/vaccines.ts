// Aşı modülü (D) ortak tipleri ve saf hesaplamalar (sunucu + arayüz)
import { addDaysIso, diffDaysIso } from './petvet'
import type { Species } from './api-types'

export const VACCINE_KINDS = ['rabies', 'combo', 'felv', 'kc', 'lyme', 'internal_parasite', 'external_parasite', 'other'] as const
export type VaccineKind = (typeof VACCINE_KINDS)[number]

export const VACCINE_KIND_LABEL: Record<VaccineKind, string> = {
  rabies: 'Kuduz',
  combo: 'Karma',
  felv: 'Lösemi (FeLV)',
  kc: 'Bronşin (KC)',
  lyme: 'Lyme',
  internal_parasite: 'İç parazit',
  external_parasite: 'Dış parazit',
  other: 'Diğer',
}

export const PLAN_STATUSES = ['planned', 'done', 'postponed', 'cancelled', 'external'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  planned: 'Planlı',
  done: 'Uygulandı',
  postponed: 'Ertelendi',
  cancelled: 'İptal',
  external: 'Başka klinikte',
}

export interface ProtocolStep {
  label: string
  /** İlk doz için en küçük yaş (hafta) — vade doğum tarihinden hesaplanır, altındaysa uyarı */
  minAgeWeeks?: number
  /** Bir önceki dozdan sonra kaç hafta */
  afterPrevWeeks?: number
  /** Son adımda: bu adım her N günde bir tekrarlanır (rapel) */
  thenEveryDays?: number
}

export interface VaccineProduct {
  id: string
  name: string
  manufacturer: string | null
  kind: VaccineKind
  species: Species[]
  immunityDays: number | null
  active: boolean
  notes: string | null
}

export interface VaccineProtocol {
  id: string
  species: Species
  kind: VaccineKind
  name: string
  steps: ProtocolStep[]
  active: boolean
}

/** Hatırlatma durumu (M modülünün reminders tablosundan; tablo yoksa null) */
export type ReminderState = 'planned' | 'sent' | 'failed' | 'no_consent' | 'cancelled' | null

export interface ReminderInfo {
  state: ReminderState
  /** Son gönderim/deneme zamanı (ISO) */
  at: string | null
  channel: string | null
  error: string | null
}

export interface VaccinationDto {
  id: string
  kind: VaccineKind
  productId: string | null
  productName: string | null
  manufacturer: string | null
  lotNo: string | null
  expiryDate: string | null
  givenAt: string
  givenById: string | null
  givenByName: string | null
  doseLabel: string | null
  visitId: string | null
  passportRecorded: boolean
  sideEffects: string | null
  external: boolean
  externalClinic: string | null
  petvetStatus: string | null
  petvetTaskId: string | null
}

export interface VaccinationPlanDto {
  id: string
  kind: VaccineKind
  doseLabel: string | null
  dueDate: string
  status: PlanStatus
  reason: string | null
  vaccinationId: string | null
  protocolId: string | null
  daysLeft: number
  reminder: ReminderInfo | null
}

export interface AnimalVaccinesDto {
  animalId: string
  species: Species
  animalStatus: string
  vaccinations: VaccinationDto[]
  plans: VaccinationPlanDto[]
  /** kind → seçili protokol id (özel seçim ya da varsayılan) */
  protocols: Partial<Record<VaccineKind, { protocolId: string; name: string; custom: boolean }>>
}

export const CALENDAR_FILTERS = ['week', 'month', 'overdue', 'overdue30', 'failed', 'all'] as const
export type CalendarFilter = (typeof CALENDAR_FILTERS)[number]
export const CALENDAR_FILTER_LABEL: Record<CalendarFilter, string> = {
  week: 'Bu hafta',
  month: 'Bu ay',
  overdue: 'Gecikmiş 0–30 g',
  overdue30: '30+ g',
  failed: 'Hatırlatma başarısız',
  all: 'Tüm açık',
}

export interface CalendarItem {
  planId: string
  dueDate: string
  daysLeft: number
  status: PlanStatus
  kind: VaccineKind
  doseLabel: string | null
  animalId: string
  animalName: string
  species: Species
  ownerId: string | null
  ownerName: string | null
  ownerPhone: string | null
  reminder: ReminderInfo | null
  /** Sonraki randevu (E modülü; tablo yoksa null) */
  appointmentAt: string | null
}

export interface CalendarDto {
  items: CalendarItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<CalendarFilter, number>
  /** reminders tablosu henüz yoksa false — hatırlatma sütunu boş gösterilir */
  remindersAvailable: boolean
}

export interface VaccinePreviewDto {
  doseLabel: string
  doseNo: number
  protocolId: string | null
  protocolName: string | null
  nextDueDate: string | null
  nextDoseLabel: string | null
  warnings: string[]
  lastLotNo: string | null
  lastExpiryDate: string | null
  petvetTask: boolean
  animalInactive: boolean
}

export interface VaccinateInput {
  animalId: string
  kind: VaccineKind
  productId?: string
  productName?: string
  lotNo?: string
  expiryDate?: string
  givenAt: string
  givenBy?: string
  doseLabel?: string
  /** undefined = protokolden hesapla; null = sonraki doz planlama */
  nextDueDate?: string | null
  passportRecorded?: boolean
  sideEffects?: string
  visitId?: string
  planId?: string
  external?: boolean
  externalClinic?: string
}

export interface VaccinateResult {
  id: string
  nextPlanId: string | null
  nextDueDate: string | null
  petvetTaskId: string | null
  petvetStatus: 'pending' | 'missing_info' | null
  warnings: string[]
}

// ---------------------------------------------------------------- hesaplamalar

/** Doğum tarihinden belirli tarihe kadar geçen tam hafta */
export function ageWeeks(birthDate: string | null | undefined, atIso: string): number | null {
  if (!birthDate) return null
  return Math.floor(diffDaysIso(birthDate, atIso) / 7)
}

/** Yapılmış doz sayısına göre sıradaki adımın indeksi (null = protokol bitti) */
export function stepIndexFor(steps: ProtocolStep[], doneCount: number): number | null {
  if (!steps.length) return null
  if (doneCount < steps.length) return doneCount
  return steps[steps.length - 1].thenEveryDays ? steps.length - 1 : null
}

/** stepIndex numaralı doz givenAt tarihinde yapıldıysa sonraki dozun indeksi ve vadesi */
export function nextAfter(steps: ProtocolStep[], stepIndex: number, givenAt: string): { index: number; dueDate: string } | null {
  const cur = steps[stepIndex]
  const nextIdx = stepIndex + 1
  if (nextIdx < steps.length) {
    const nx = steps[nextIdx]
    const days = nx.afterPrevWeeks != null ? nx.afterPrevWeeks * 7 : nx.thenEveryDays
    if (!days) return null
    return { index: nextIdx, dueDate: addDaysIso(givenAt, days) }
  }
  if (cur?.thenEveryDays) return { index: stepIndex, dueDate: addDaysIso(givenAt, cur.thenEveryDays) }
  return null
}

/** Hiç doz yapılmamışsa ilk dozun vadesi: doğum + minimum yaş (bilinmiyorsa bugün) */
export function firstDueDate(steps: ProtocolStep[], birthDate: string | null, today: string): string {
  const s = steps[0]
  if (birthDate && s?.minAgeWeeks != null) {
    const d = addDaysIso(birthDate, s.minAgeWeeks * 7)
    return d
  }
  return today
}

/** 0532 *** ** 18 */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return ''
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(e164)
  return m ? `0${m[1]} *** ** ${m[4]}` : e164.replace(/\d(?=\d{2})/g, '*')
}

export function validateSteps(steps: ProtocolStep[]): string | null {
  if (!steps.length) return 'Protokolde en az bir adım olmalı.'
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (!s.label?.trim()) return `${i + 1}. adımın adı boş.`
    if (i > 0 && s.afterPrevWeeks == null && s.thenEveryDays == null) return `${i + 1}. adım için önceki dozdan sonraki süreyi girin.`
    if (s.thenEveryDays != null && i !== steps.length - 1) return 'Tekrar (rapel) yalnızca son adımda olabilir.'
  }
  return null
}
