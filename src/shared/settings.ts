// Klinik ayarları (clinic.settings jsonb). Eksik alanlar varsayılanlarla tamamlanır.
import { DEFAULT_PETVET_DAYS, type PetvetTaskKind } from './petvet'

export interface ClinicSettings {
  petvet: {
    days: Record<PetvetTaskKind, number>
    /** Hangi aşı türleri PETVET görevi açsın (vaccine_products.kind) */
    vaccineKinds: string[]
    warnDaysBefore: number
    requireEvidence: boolean
    tarbilUrl: string
  }
  visits: {
    /** Sekreter muayene içeriğini görebilsin mi (varsayılan kapalı, ) */
    secretaryCanRead: boolean
  }
  messaging: {
    quietStart: string // "21:00"
    quietEnd: string // "09:00"
    vaccineOffsetsDays: number[] // vade tarihinden önce: [7, 1]; negatif = sonra (gecikme hatırlatması)
    appointmentOffsetHours: number // randevudan kaç saat önce
    sms: { provider: 'none' | 'netgsm' | 'iletimerkezi' | 'log'; username?: string; header?: string; secretRef?: string }
    email: { enabled: boolean; host?: string; port?: number; secure?: boolean; user?: string; from?: string; secretRef?: string }
  }
  reader: { mode: 'keyboard' | 'serial'; maxGapMs: number; serialPath?: string; baudRate?: number; sound: boolean }
  security: { lockMinutes: number; showUserCards: boolean }
  workHours: { day: number; open: string; close: string; breakStart?: string; breakEnd?: string; closed?: boolean }[]
  appointmentSlotMinutes: number
  backup: { targets: string[]; time: string; keepDaily: number; keepMonthly: number }
}

export const DEFAULT_SETTINGS: ClinicSettings = {
  petvet: { days: DEFAULT_PETVET_DAYS, vaccineKinds: ['rabies'], warnDaysBefore: 3, requireEvidence: false, tarbilUrl: 'https://hbs.tarbil.gov.tr/' },
  visits: { secretaryCanRead: false },
  messaging: {
    quietStart: '21:00',
    quietEnd: '09:00',
    vaccineOffsetsDays: [7, 1, -3],
    appointmentOffsetHours: 24,
    sms: { provider: 'none' },
    email: { enabled: false },
  },
  reader: { mode: 'keyboard', maxGapMs: 35, sound: true },
  security: { lockMinutes: 10, showUserCards: true },
  // day: 0 = pazar ... 6 = cumartesi
  workHours: [
    { day: 0, open: '09:00', close: '14:00', closed: true },
    ...[1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00', breakStart: '12:30', breakEnd: '13:30' })),
    { day: 6, open: '09:00', close: '14:00' },
  ],
  appointmentSlotMinutes: 15,
  backup: { targets: [], time: '03:00', keepDaily: 14, keepMonthly: 12 },
}

/** Derin birleştirme: kayıtlı ayarlar + varsayılanlar */
export function mergeSettings(stored: unknown): ClinicSettings {
  const merge = (def: unknown, val: unknown): unknown => {
    if (Array.isArray(def)) return Array.isArray(val) ? val : def
    if (def && typeof def === 'object') {
      const out: Record<string, unknown> = { ...(def as object) }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        for (const [k, v] of Object.entries(val)) out[k] = k in (def as object) ? merge((def as Record<string, unknown>)[k], v) : v
      }
      return out
    }
    return val === undefined ? def : val
  }
  return merge(DEFAULT_SETTINGS, stored) as ClinicSettings
}
