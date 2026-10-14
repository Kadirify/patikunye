// PETVET görev kuralları. Süreler ayarlardan değiştirilebilir (mevzuat değişebilir).

export const PETVET_TASK_KINDS = ['CHIP_NEW', 'VACCINE', 'TRANSFER', 'DEATH', 'LOST', 'FOUND', 'UPDATE'] as const
export type PetvetTaskKind = (typeof PETVET_TASK_KINDS)[number]

export const PETVET_STATUSES = ['pending', 'missing_info', 'done', 'cancelled'] as const
export type PetvetStatus = (typeof PETVET_STATUSES)[number]

export const PETVET_STATUS_LABEL: Record<PetvetStatus, string> = {
  pending: 'Bekliyor',
  missing_info: 'Eksik bilgi',
  done: 'Tamamlandı',
  cancelled: 'İptal edildi',
}

export const PETVET_KIND_LABEL: Record<PetvetTaskKind, string> = {
  CHIP_NEW: 'Yeni çip',
  VACCINE: 'Aşı',
  TRANSFER: 'Sahip devri',
  DEATH: 'Ölüm bildirimi',
  LOST: 'Kayıp bildirimi',
  FOUND: 'Bulundu bildirimi',
  UPDATE: 'Bilgi düzeltme',
}

export const PETVET_KIND_DESCRIPTION: Record<PetvetTaskKind, string> = {
  CHIP_NEW: 'Yeni uygulanan mikrocip TARBIL\'e bildirilir.',
  VACCINE: 'Kuduz asisi uygulamasi TARBIL\'e bildirilir.',
  TRANSFER: 'Hayvan sahip degisikligi TARBIL\'e guncellenir.',
  DEATH: 'Hayvan olumu TARBIL\'e bildirilir.',
  LOST: 'Kayip hayvan bilgisi TARBIL\'e bildirilir.',
  FOUND: 'Bulunan hayvan bilgisi TARBIL\'de guncellenir.',
  UPDATE: 'Hayvan veya sahip bilgisi duzeltmesi TARBIL\'e iletilir.',
}

/**
 * Varsayılan süreler (gün).
 * CHIP_NEW/VACCINE/TRANSFER/UPDATE = 15 gün (10.03.2026 tarihli Bakanlık genelgesi, PETVET kılavuzu md. 4).
 * DEATH = 30 gün, LOST/FOUND = 7 gün.
 */
export const DEFAULT_PETVET_DAYS: Record<PetvetTaskKind, number> = {
  CHIP_NEW: 15,
  VACCINE: 15,
  TRANSFER: 15,
  DEATH: 30,
  LOST: 7,
  FOUND: 7,
  UPDATE: 15,
}

/** YYYY-MM-DD tarihine gün ekler (saat dilimi kaymasız). */
export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

/** İki YYYY-MM-DD arasındaki gün farkı (b - a). */
export function diffDaysIso(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

export function petvetDueDate(kind: PetvetTaskKind, eventDateIso: string, days = DEFAULT_PETVET_DAYS): string {
  return addDaysIso(eventDateIso, days[kind])
}

export type Urgency = 'overdue' | 'today' | 'soon' | 'normal'

export function petvetUrgency(dueIso: string, todayIso: string): { urgency: Urgency; daysLeft: number } {
  const daysLeft = diffDaysIso(todayIso, dueIso)
  if (daysLeft < 0) return { urgency: 'overdue', daysLeft }
  if (daysLeft === 0) return { urgency: 'today', daysLeft }
  if (daysLeft <= 3) return { urgency: 'soon', daysLeft }
  return { urgency: 'normal', daysLeft }
}

/** Europe/Istanbul'a göre bugünün tarihi (YYYY-MM-DD) */
export function todayIstanbul(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now)
}

/** 2026-10-27 -> 27.10.2026 */
export function formatDateTr(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/** 27.10.2026 -> 2026-10-27 (geçersizse null) */
export function parseDateTr(s: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim())
  if (!m) return null
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const dt = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso
}
