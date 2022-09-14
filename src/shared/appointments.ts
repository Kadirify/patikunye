// Randevu modülü (E) — sunucu ve arayüzün paylaştığı tipler ve yardımcılar.
// Saat dilimi: Europe/Istanbul (2016'dan beri sabit UTC+3, yaz saati yok).
import type { Species } from './api-types'
import type { ClinicSettings } from './settings'

export const APPOINTMENT_STATUSES = ['planned', 'confirmed', 'arrived', 'in_exam', 'done', 'cancelled', 'no_show'] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  planned: 'Planlandı',
  confirmed: 'Onaylandı',
  arrived: 'Geldi',
  in_exam: 'Muayenede',
  done: 'Tamamlandı',
  cancelled: 'İptal',
  no_show: 'Gelmedi',
}

/** Durum rozeti sınıfı (.st .s-*) */
export const APPOINTMENT_STATUS_CLASS: Record<AppointmentStatus, string> = {
  planned: 's-gry',
  confirmed: 's-gry',
  arrived: 's-amb',
  in_exam: 's-blu',
  done: 's-ok',
  cancelled: 's-red',
  no_show: 's-red',
}

/**
 * İzinli durum geçişleri (SAYFALAR §15.2):
 * Planlandı → Onaylandı (ops.) → Geldi → Muayenede → Tamamlandı; yan dallar İptal, Gelmedi.
 * Bekleme salonunda yanlış sürüklemeyi düzeltmek için bir adım geri almaya izin verilir.
 * İptal son durumdur (yeniden randevu yeni kayıt açar).
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  planned: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['planned', 'arrived', 'cancelled', 'no_show'],
  arrived: ['planned', 'in_exam', 'done', 'cancelled', 'no_show'],
  in_exam: ['arrived', 'done'],
  done: ['in_exam'],
  cancelled: [],
  no_show: ['planned', 'arrived'],
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from]?.includes(to) ?? false
}

/** Randevu saatinden kaç dakika sonra "Gelmedi" önerilir */
export const NO_SHOW_SUGGEST_MINUTES = 30
/** Bekleme süresi bu dakikayı geçince turuncu */
export const WAIT_WARN_MINUTES = 15

export type CancelSide = 'owner' | 'clinic'

export interface AppointmentTypeDto {
  id: string
  name: string
  /** Çerçeve rengi (#RRGGBB); zemin bundan açık ton olarak türetilir */
  color: string
  defaultMinutes: number
  active: boolean
  sort: number
}

export interface AppointmentTypeInput {
  name: string
  color: string
  defaultMinutes: number
  active?: boolean
  sort?: number
}

export interface HolidayDto {
  id: string
  date: string
  name: string
}

export interface AppointmentWarning {
  code: 'PAST' | 'OUTSIDE_HOURS' | 'BREAK' | 'CLOSED_DAY' | 'HOLIDAY' | 'OVERLAP'
  message: string
}

export interface AppointmentDto {
  id: string
  status: AppointmentStatus
  startsAt: string
  endsAt: string
  /** Istanbul yerel tarih/saat (gösterim ve gruplama için) */
  date: string
  time: string
  endTime: string
  durationMinutes: number
  reason: string | null
  room: string | null
  walkIn: boolean
  reminder: boolean
  version: number
  arrivedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  cancelReason: string | null
  cancelledBySide: CancelSide | null
  animalId: string | null
  animalName: string
  species: Species | null
  breed: string | null
  birthDate: string | null
  behavior: string | null
  allergies: string[]
  chipNo: string | null
  ownerId: string | null
  ownerName: string | null
  ownerPhone: string | null
  vetId: string | null
  vetName: string | null
  typeId: string | null
  typeName: string | null
  typeColor: string | null
  /** Aynı hekimde zaman çakışması var (çift kayıt) */
  overlap: boolean
  /** Bekleme ("Geldi") ya da muayene süresi, dakika */
  waitMinutes: number | null
  /** Randevu saatinden 30 dk geçti, hâlâ gelmedi → "Gelmedi" önerisi */
  suggestNoShow: boolean
  /** Yeni hasta mini kaydı (hayvan kaydı yok) */
  isNewPatient: boolean
}

export interface AppointmentInput {
  animalId?: string | null
  /** Hızlı yeni hasta (animalId yoksa) */
  newPatient?: { ownerName: string; phone: string; animalName: string; species: Species }
  /** ISO 8601 (ör. 2026-10-27T10:00:00+03:00) */
  startsAt: string
  durationMinutes: number
  vetId: string
  typeId: string
  reason?: string
  reminder: boolean
  /** Kaydedince onay mesajı gönderilsin mi */
  sendConfirmation?: boolean
}

export interface AppointmentUpdateInput extends AppointmentInput {
  version: number
  /** Saat değiştiyse sahibe değişiklik mesajı */
  notifyOwner?: boolean
}

export interface AppointmentMoveInput {
  startsAt: string
  endsAt: string
  vetId: string
  version: number
  notifyOwner?: boolean
}

export interface AppointmentStatusInput {
  status: AppointmentStatus
  version?: number
  room?: string
  cancelReason?: string
  cancelledBySide?: CancelSide
  /** İptalde sahibe iptal mesajı */
  notifyOwner?: boolean
}

export interface WalkInInput {
  animalId?: string | null
  newPatient?: { ownerName: string; phone: string; animalName: string; species: Species }
  vetId?: string | null
  typeId?: string | null
  reason?: string
}

export interface AppointmentSaveResult {
  id: string
  version: number
  overlap: boolean
  warnings: AppointmentWarning[]
}

export interface WaitingRoomDto {
  today: string
  now: string
  items: AppointmentDto[]
}

export interface AppointmentConfigDto {
  workHours: ClinicSettings['workHours']
  slotMinutes: number
  types: AppointmentTypeDto[]
  holidays: HolidayDto[]
  vets: { id: string; fullName: string; role: string }[]
}

/* ---------- Saat yardımcıları (Europe/Istanbul) ---------- */

export const TZ = 'Europe/Istanbul'

/** Yerel tarih + saat → ISO (Istanbul sabit +03:00) */
export function istanbulIso(date: string, time: string): string {
  return `${date}T${time.length === 5 ? time + ':00' : time}+03:00`
}

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
})
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Bir anın Istanbul'daki tarih, saat (HH:MM), haftanın günü (0 = pazar) */
export function istanbulParts(d: Date | string): { date: string; time: string; weekday: number; minutes: number } {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(d)).map((x) => [x.type, x.value]))
  const time = `${p.hour}:${p.minute}`
  return { date: `${p.year}-${p.month}-${p.day}`, time, weekday: WD[p.weekday as string] ?? 0, minutes: toMinutes(time) }
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
export function fromMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Haftanın günü (0 = pazar) — yerel tarih metninden */
export function weekdayOf(date: string): number {
  return new Date(date + 'T12:00:00Z').getUTCDay()
}

/**
 * Çalışma saati / tatil uyarıları (engellemez). Hem sunucu hem arayüz kullanır.
 * start/end: yerel dakika (00:00'dan itibaren), aynı gün varsayılır.
 */
export function scheduleWarnings(
  date: string,
  startMin: number,
  endMin: number,
  workHours: ClinicSettings['workHours'],
  holidays: { date: string; name: string }[],
): AppointmentWarning[] {
  const out: AppointmentWarning[] = []
  const h = holidays.find((x) => x.date === date)
  if (h) out.push({ code: 'HOLIDAY', message: `Seçilen gün tatil: ${h.name}.` })
  const wh = workHours.find((w) => w.day === weekdayOf(date))
  if (!wh || wh.closed) {
    out.push({ code: 'CLOSED_DAY', message: 'Klinik bu gün kapalı.' })
    return out
  }
  if (startMin < toMinutes(wh.open) || endMin > toMinutes(wh.close)) {
    out.push({ code: 'OUTSIDE_HOURS', message: `Çalışma saatleri dışında (${wh.open}–${wh.close}).` })
  }
  if (wh.breakStart && wh.breakEnd && startMin < toMinutes(wh.breakEnd) && endMin > toMinutes(wh.breakStart)) {
    out.push({ code: 'BREAK', message: `Öğle arasına denk geliyor (${wh.breakStart}–${wh.breakEnd}).` })
  }
  return out
}
