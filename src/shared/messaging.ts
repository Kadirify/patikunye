// Mesajlar ve hatırlatmalar (Modül M) — sunucu ve arayüzün ortak tipleri + saf yardımcılar.

export const REMINDER_STATUSES = [
  'planned',
  'queued',
  'sent',
  'delivered',
  'failed',
  'permanent_failed',
  'cancelled',
  'no_consent',
  'expired',
] as const
export type ReminderStatus = (typeof REMINDER_STATUSES)[number]

export const REMINDER_STATUS_LABEL: Record<ReminderStatus, string> = {
  planned: 'Planlandı',
  queued: 'Kuyrukta',
  sent: 'Gönderildi',
  delivered: 'Teslim edildi',
  failed: 'Başarısız (tekrar denenecek)',
  permanent_failed: 'Kalıcı başarısız',
  cancelled: 'İptal',
  no_consent: 'İzin yok',
  expired: 'Süresi geçti',
}

/** Bekleyen (henüz sonuçlanmamış) durumlar: iptal edilebilir */
export const PENDING_STATUSES: ReminderStatus[] = ['planned', 'queued', 'failed']

export type MessageChannel = 'sms' | 'email'
export const CHANNEL_LABEL: Record<MessageChannel, string> = { sms: 'SMS', email: 'E-posta' }

export const REMINDER_KIND_LABEL: Record<string, string> = {
  vaccine: 'Aşı',
  appointment: 'Randevu',
  appointment_confirm: 'Randevu onayı',
  appointment_cancel: 'Randevu iptali',
  control: 'Kontrol',
  custom: 'Özel',
}

/** S-80 sekmeleri */
export const QUEUE_TABS = ['planned', 'today', 'sent', 'failed', 'cancelled'] as const
export type QueueTab = (typeof QUEUE_TABS)[number]
export const QUEUE_TAB_LABEL: Record<QueueTab, string> = {
  planned: 'Planlanan',
  today: 'Bugün gönderilecek',
  sent: 'Gönderildi',
  failed: 'Başarısız',
  cancelled: 'İptal / izin yok',
}

/** Uygulamayla gelen şablon anahtarları (S-106) */
export const TEMPLATE_KEYS = [
  'vaccine_reminder',
  'appointment_confirm',
  'appointment_reminder',
  'appointment_cancel',
  'control_reminder',
  'vaccine_overdue',
] as const
export type BuiltinTemplateKey = (typeof TEMPLATE_KEYS)[number]
export const TEMPLATE_LABEL: Record<string, string> = {
  vaccine_reminder: 'Aşı hatırlatma',
  appointment_confirm: 'Randevu onayı',
  appointment_reminder: 'Randevu hatırlatma',
  appointment_cancel: 'Randevu iptal',
  control_reminder: 'Kontrol hatırlatma',
  vaccine_overdue: 'Geçmiş aşı',
}

/** Şablon değişkenleri */
export const TEMPLATE_VARIABLES = [
  { key: 'sahip_ad', label: 'Sahip adı', sample: 'Ayşe Yılmaz' },
  { key: 'hayvan_ad', label: 'Hayvan adı', sample: 'Pamuk' },
  { key: 'asi_ad', label: 'Aşı adı', sample: 'Karma (DHPPi)' },
  { key: 'tarih', label: 'Tarih', sample: '03.11.2026' },
  { key: 'saat', label: 'Saat', sample: '14:30' },
  { key: 'klinik_ad', label: 'Klinik adı', sample: 'Pati Veteriner Kliniği' },
  { key: 'klinik_tel', label: 'Klinik telefonu', sample: '0312 123 45 67' },
  { key: 'hekim_ad', label: 'Hekim adı', sample: 'Vet. Hek. Ali Demir' },
] as const
export const SAMPLE_VARS: Record<string, string> = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]))

/** {degisken} yer tutucularını doldurur. Bilinmeyen/boş değişken boş metne döner, fazla boşluk toplanır. */
export function fillTemplate(body: string, vars: Record<string, string | null | undefined>): string {
  return body
    .replace(/\{([a-z_]+)\}/g, (_m, k: string) => (vars[k] ?? '').toString())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim()
}

/** Şablondaki bilinmeyen değişken adları (kaydetmeden önce uyarı için) */
export function unknownVariables(body: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES.map((v) => v.key))
  const out = new Set<string>()
  for (const m of body.matchAll(/\{([a-z_]+)\}/g)) if (!known.has(m[1])) out.add(m[1])
  return [...out]
}

// GSM 03.38 temel karakter kümesi (7 bit). Genişletme tablosundaki karakterler 2 karakter sayılır.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXT = '^{}\\[~]|€\f'
/** Türkçe karakterler: biri varsa mesaj Türkçe/Unicode kodlamayla gider (70/67).
 *  ⚠️ Sağlayıcıya göre değişir: bazı sağlayıcılar Türkçe tek kaydırma (single shift) tablosuyla
 *  155/149 karakter uygular, bazıları Türkçe karakterleri Latin'e çevirir. Netgsm'de `encoding: 'TR'`
 *  seçildiğinde fiyatlandırma ve boy hesabı değişir. Pilot sağlayıcının tarifesiyle doğrulanacak. */
const TR_CHARS = /[şŞğĞıİçÇöÖüÜ]/

export interface SmsCount {
  chars: number
  segments: number
  /** Tek mesaja sığan karakter (70 / 160) */
  single: number
  /** Birleşik (çok parçalı) mesajda parça başı (67 / 153) */
  perSegment: number
  /** Türkçe / Unicode kodlama mı */
  unicode: boolean
  /** Bu parçada kalan karakter */
  remaining: number
}

/** SMS karakter ve parça sayacı. Türkçe karakter varsa 70/67, yoksa 160/153 (GSM 7 bit). */
export function smsSegments(text: string): SmsCount {
  const unicode = TR_CHARS.test(text) || [...text].some((c) => !GSM_BASIC.includes(c) && !GSM_EXT.includes(c))
  const chars = unicode ? [...text].length : [...text].reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0)
  const single = unicode ? 70 : 160
  const perSegment = unicode ? 67 : 153
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / perSegment)
  const cap = segments <= 1 ? single : segments * perSegment
  return { chars, segments, single, perSegment, unicode, remaining: cap - chars }
}

/** +905321234567 → 0532 *** ** 67 (listelerde maskeli gösterim) */
export function maskAddress(addr: string | null | undefined): string {
  if (!addr) return ''
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(addr)
  if (m) return `0${m[1]} *** ** ${m[4]}`
  const at = addr.indexOf('@')
  if (at > 0) return `${addr.slice(0, Math.min(2, at))}***${addr.slice(at)}`
  return addr.length > 4 ? `${'*'.repeat(addr.length - 4)}${addr.slice(-4)}` : addr
}

/** "21:00" → 1260 */
export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** Europe/Istanbul saatine göre sessiz saatte mi? (başlangıç > bitiş ise gece yarısını aşar) */
export function isQuietTime(now: Date, quietStart: string, quietEnd: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const cur = h * 60 + m
  const s = hhmmToMinutes(quietStart)
  const e = hhmmToMinutes(quietEnd)
  if (s === e) return false
  return s < e ? cur >= s && cur < e : cur >= s || cur < e
}

/* ---------- API tipleri ---------- */

export interface ReminderListItem {
  id: string
  kind: string
  channel: MessageChannel
  toMasked: string
  ownerId: string
  ownerName: string
  animalId: string | null
  animalName: string | null
  templateKey: string
  status: ReminderStatus
  sendAt: string
  eventAt: string | null
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  cancelledReason: string | null
  sentAt: string | null
  hasOverride: boolean
}

export interface ReminderListResult {
  items: ReminderListItem[]
  total: number
  page: number
  pageSize: number
}

export interface MessagingSummary {
  tabs: Record<QueueTab, number>
  sentThisMonth: number
  smsUnitsThisMonth: number
  provider: string
  emailEnabled: boolean
}

export interface ReminderPreview {
  id: string
  channel: MessageChannel
  subject: string | null
  body: string
  /** Şablondan (override yoksa) üretilmiş metin */
  templateBody: string
  hasOverride: boolean
  count: SmsCount
}

export interface MessageHistoryItem {
  id: string
  reminderId: string | null
  ownerId: string | null
  ownerName: string | null
  channel: MessageChannel
  to: string
  body: string
  status: string
  provider: string
  providerMsgId: string | null
  error: string | null
  sentAt: string
  costUnits: number
  isTest: boolean
}

export interface MessageHistoryResult {
  items: MessageHistoryItem[]
  total: number
  page: number
  pageSize: number
}

export interface MessageTemplateDto {
  key: string
  channel: MessageChannel
  subject: string | null
  body: string
  builtin: boolean
  updatedAt: string
}

export type SmsProviderName = 'none' | 'netgsm' | 'iletimerkezi' | 'log'
export const SMS_PROVIDER_LABEL: Record<SmsProviderName, string> = {
  none: 'Kapalı',
  netgsm: 'Netgsm',
  iletimerkezi: 'İletimerkezi',
  log: 'Deneme (gönderme, yalnızca kaydet)',
}

/** Mesajlaşma ayarları (sırlar hariç; yalnızca "ayarlı mı" bilgisi) */
export interface MessagingSettingsDto {
  quietStart: string
  quietEnd: string
  vaccineOffsetsDays: number[]
  appointmentOffsetHours: number
  sms: { provider: SmsProviderName; username: string; header: string; secretSet: boolean }
  email: { enabled: boolean; host: string; port: number | null; secure: boolean; user: string; from: string; secretSet: boolean }
}

export interface BalanceDto {
  supported: boolean
  provider: string
  /** TL bakiye (varsa) */
  amount: string | null
  /** SMS kredisi (varsa) */
  credits: string | null
  error: string | null
}

export interface ProcessResult {
  sent: number
  failed: number
  expired: number
  skipped: number
  quiet: boolean
}
