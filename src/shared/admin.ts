//  (ayarlar, kullanıcılar, KVKK, denetim) API tipleri
import type { Role, SessionDto } from './api-types'

export const DICT_KINDS = ['breed', 'color', 'owner_tag', 'cancel_reason'] as const
export type DictKind = (typeof DICT_KINDS)[number]
export const DICT_KIND_LABEL: Record<DictKind, string> = {
  breed: 'Irklar',
  color: 'Renkler',
  owner_tag: 'Sahip etiketleri',
  cancel_reason: 'İptal nedenleri',
}

export interface DictItem {
  id: string
  kind: DictKind
  species: string | null
  value: string
  sort: number
  active: boolean
}

export interface LoginUserCard {
  username: string
  fullName: string
  role: Role
  pinEnabled: boolean
  lastLoginAt: string | null
}

/** Giriş yanıtı: ya oturum ya da zorunlu parola değişikliği */
export type LoginResult = SessionDto | { mustChangePassword: true; changeToken: string; fullName: string }

export interface AdminUserDto {
  id: string
  username: string
  fullName: string
  role: Role
  chamberRegNo: string | null
  diplomaNo: string | null
  email: string | null
  phone: string | null
  active: boolean
  pinAllowed: boolean
  pinSet: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface AdminUserInput {
  fullName: string
  username: string
  role: Role
  chamberRegNo?: string | null
  diplomaNo?: string | null
  email?: string | null
  phone?: string | null
  pinAllowed?: boolean
}

export interface ProfileDto {
  id: string
  username: string
  fullName: string
  role: Role
  pinAllowed: boolean
  pinSet: boolean
  passwordChangedAt: string | null
  prefs: UserPrefs
}

export interface UserPrefs {
  notifyPetvet?: boolean
  notifyKvkk?: boolean
  notifyBackup?: boolean
}

export interface ClinicInfoDto {
  name: string
  city: string | null
  district: string | null
  phone: string | null
  address: string | null
}

/** clinic.settings içinde F'nin kullandığı, ortak tipte henüz olmayan ek alanlar */
export interface AdminSettingsExtra {
  petvet: { tarbilUrl?: string }
  reader: { sound?: boolean }
}
export const DEFAULT_TARBIL_URL = 'https://hbs.tarbil.gov.tr/'

export const KVKK_TEXT_KINDS = ['notice', 'consent', 'marketing'] as const
export type KvkkTextKind = (typeof KVKK_TEXT_KINDS)[number]
export const KVKK_TEXT_LABEL: Record<KvkkTextKind, string> = {
  notice: 'Aydınlatma metni',
  consent: 'Açık rıza metni',
  marketing: 'Ticari ileti izni',
}
export interface KvkkTextDto {
  id: string
  kind: KvkkTextKind
  version: number
  body: string
  publishedAt: string
  createdByName: string | null
}

export const KVKK_REQUEST_TYPES = ['info', 'copy', 'correct', 'erase', 'objection'] as const
export type KvkkRequestType = (typeof KVKK_REQUEST_TYPES)[number]
export const KVKK_REQUEST_TYPE_LABEL: Record<KvkkRequestType, string> = {
  info: 'Bilgi alma',
  copy: 'Veri kopyası',
  correct: 'Düzeltme',
  erase: 'Silme / anonimleştirme',
  objection: 'İtiraz (pazarlama izni geri alma)',
}
export const KVKK_CHANNELS = ['written', 'email', 'kep', 'in_person'] as const
export type KvkkChannel = (typeof KVKK_CHANNELS)[number]
export const KVKK_CHANNEL_LABEL: Record<KvkkChannel, string> = {
  written: 'Yazılı (dilekçe)',
  email: 'E-posta',
  kep: 'KEP',
  in_person: 'Elden',
}
export const KVKK_STATUSES = ['open', 'done', 'rejected'] as const
export type KvkkStatus = (typeof KVKK_STATUSES)[number]
export const KVKK_STATUS_LABEL: Record<KvkkStatus, string> = { open: 'Açık', done: 'Yanıtlandı', rejected: 'Reddedildi' }
/** Yasal yanıt süresi (KVKK m.13) */
export const KVKK_DUE_DAYS = 30

export interface KvkkRequestDto {
  id: string
  ownerId: string
  ownerName: string
  ownerAnonymized: boolean
  type: KvkkRequestType
  receivedAt: string
  channel: KvkkChannel
  status: KvkkStatus
  dueDate: string
  daysLeft: number
  note: string | null
  responseNote: string | null
  closedAt: string | null
  createdAt: string
}

export interface KvkkRequestInput {
  ownerId: string
  type: KvkkRequestType
  receivedAt: string
  channel: KvkkChannel
  note?: string
}

export interface AnonymizePreview {
  ownerId: string
  currentName: string
  anonymName: string
  alreadyAnonymized: boolean
  clearedFields: { field: string; label: string; hasValue: boolean }[]
  kept: { label: string; count: number; reason: string }[]
}

export const ANONYMIZE_CONFIRM = 'ANONİMLEŞTİR'

export interface AuditRowDto {
  id: number
  at: string
  userId: string | null
  userName: string | null
  action: string
  entity: string
  entityId: string | null
  summary: string | null
}
export interface AuditDetailDto extends AuditRowDto {
  diff: unknown
  prevHash: string | null
  hash: string
}
export interface AuditListDto {
  rows: AuditRowDto[]
  total: number
  page: number
  pageSize: number
}
export interface AuditVerifyDto {
  ok: boolean
  checked: number
  broken: { id: number; reason: string }[]
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  create: 'Oluştur',
  update: 'Güncelle',
  delete: 'Sil',
  view_sensitive: 'Görüntüle (hassas)',
  export: 'Dışa aktar',
  login: 'Giriş',
  login_failed: 'Başarısız giriş',
  setup: 'Kurulum',
  petvet_done: 'PETVET girildi',
}

/** Denetim ayrıntısında maskelenecek alan adları */
const SECRET_KEY = /(password|parola|pin|secret|token|hash|_enc$)/i
const PARTIAL_KEY = /(tckn|phone|telefon|email|e_?posta)/i

export function maskValue(key: string, v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (SECRET_KEY.test(key)) return '••••••'
  if (PARTIAL_KEY.test(key) && typeof v === 'string') return v.length <= 4 ? '••••' : '•'.repeat(Math.min(v.length - 4, 8)) + v.slice(-4)
  return v
}

/** Diff içindeki hassas alanları özyinelemeli maskeler */
export function maskDiff(d: unknown, parentKey = ''): unknown {
  if (Array.isArray(d)) return d.map((x) => maskDiff(x, parentKey))
  if (d && typeof d === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      // { tckn: { from, to } } biçiminde üst anahtar belirleyicidir
      const key = /^(from|to|old|new|before|after)$/.test(k) && parentKey ? parentKey : k
      out[k] = v && typeof v === 'object' ? maskDiff(v, key) : maskValue(key, v)
    }
    return out
  }
  return parentKey ? maskValue(parentKey, d) : d
}
