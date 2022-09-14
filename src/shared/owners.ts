// Modül B (sahipler + hayvan işlemleri): API girdi/çıktı tipleri ve sabitler
import type { AnimalDetail, AnimalListItem, OwnerInput, OwnerListItem, Sex, Species } from './api-types'
import type { PetvetStatus, PetvetTaskKind } from './petvet'

/** Aydınlatma metni sürümü. ⚠️ doğrulanacak: metin değişince Ayarlar'dan yönetilmeli. */
export const KVKK_TEXT_VERSION = '2026-1'

export const CONSENT_TYPES = ['kvkk_notice', 'reminder', 'marketing'] as const
export type ConsentType = (typeof CONSENT_TYPES)[number]
export const CONSENT_LABEL: Record<ConsentType, string> = {
  kvkk_notice: 'Aydınlatma metni',
  reminder: 'Hatırlatma mesajı izni',
  marketing: 'Ticari ileti izni',
}

export const KVKK_METHODS = ['printed', 'verbal'] as const
export type KvkkMethod = (typeof KVKK_METHODS)[number]
export const KVKK_METHOD_LABEL: Record<string, string> = { printed: 'Basılı imza', verbal: 'Sözlü', sms: 'SMS onay', system: 'Sistem' }

export const CHANNELS = ['sms', 'email', 'none'] as const
export type Channel = (typeof CHANNELS)[number]
export const CHANNEL_LABEL: Record<Channel, string> = { sms: 'SMS', email: 'E-posta', none: 'Hiçbiri' }

/** Ayarlar'daki sözlük gelene kadar varsayılan etiketler */
export const DEFAULT_OWNER_TAGS = ['VIP', 'Barınak', 'Kötü ödeme']

export const ANIMAL_SOURCES = ['purchase', 'adoption', 'street', 'home_birth', 'unknown'] as const
export type AnimalSource = (typeof ANIMAL_SOURCES)[number]
export const SOURCE_LABEL: Record<AnimalSource, string> = {
  purchase: 'Satın alma',
  adoption: 'Sahiplenme (barınak)',
  street: 'Sokaktan',
  home_birth: 'Doğum (evde)',
  unknown: 'Bilinmiyor',
}

export const BEHAVIORS = ['shy', 'aggressive', 'bites'] as const
export type Behavior = (typeof BEHAVIORS)[number]
export const BEHAVIOR_LABEL: Record<Behavior, string> = { shy: 'Çekingen', aggressive: 'Agresif', bites: 'Isırır' }

export const BLOOD_GROUPS: Record<string, string[]> = {
  cat: ['A', 'B', 'AB'],
  dog: ['DEA 1.1+', 'DEA 1.1-', 'DEA 1.2+', 'DEA 4+', 'DEA 7+'],
}

export const ANIMAL_STATUS_LABEL: Record<string, string> = { active: 'Aktif', lost: 'Kayıp', dead: 'Öldü' }

export const DEATH_CAUSES = ['disease', 'euthanasia', 'accident', 'unknown'] as const
export type DeathCause = (typeof DEATH_CAUSES)[number]
export const DEATH_CAUSE_LABEL: Record<DeathCause, string> = { disease: 'Hastalık', euthanasia: 'Ötanazi', accident: 'Kaza', unknown: 'Bilinmiyor' }

export const CITIES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin', 'Aydın', 'Balıkesir',
  'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli',
  'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari',
  'Hatay', 'Isparta', 'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla', 'Muş', 'Nevşehir',
  'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Tekirdağ', 'Tokat',
  'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van', 'Yozgat', 'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman',
  'Kırıkkale', 'Batman', 'Şırnak', 'Bartın', 'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye', 'Düzce',
].sort((a, b) => a.localeCompare(b, 'tr'))

/* ---------- Sahipler ---------- */

export interface OwnerFormInput extends OwnerInput {
  isForeign?: boolean
  /** Yabancı uyruklu: pasaport no (TCKN/YKN yoksa) */
  foreignDocNo?: string
  phone2?: string
  preferredChannel?: Channel
  tags?: string[]
  notes?: string
  kvkkMethod?: KvkkMethod
  marketingConsent?: boolean
}

export interface OwnerUpdateInput extends OwnerFormInput {
  version: number
  /** true ise kayıtlı TCKN silinir (tckn boş gönderilirse değişmez) */
  clearTckn?: boolean
}

export interface OwnerListRow extends OwnerListItem {
  email: string | null
  tags: string[]
  reminderConsent: boolean
  marketingConsent: boolean
  lastVisit: string | null
}

export interface OwnerListResult {
  items: OwnerListRow[]
  total: number
}

export interface OwnerAnimalRow {
  id: string
  name: string
  species: Species
  breed: string | null
  sex: Sex
  neutered: boolean
  birthDate: string | null
  status: string
  chipNo: string | null
  /** Bu sahiplik kapandıysa bitiş tarihi (devredilmiş) */
  toDate: string | null
  isPrimary: boolean
  allergies: string[]
  behavior: string | null
}

export interface ConsentRow {
  id: string
  type: ConsentType
  granted: boolean
  textVersion: string | null
  channel: string | null
  at: string
  userName: string | null
}

export interface OwnerDetail {
  id: string
  firstName: string
  lastName: string
  fullName: string
  tcknLast4: string | null
  hasTckn: boolean
  isForeign: boolean
  foreignDocLast4: string | null
  birthDate: string | null
  phone: string | null
  phone2: string | null
  email: string | null
  city: string | null
  district: string | null
  address: string | null
  emergencyName: string | null
  emergencyPhone: string | null
  preferredChannel: Channel
  tags: string[]
  notes: string | null
  kvkkNoticeAt: string | null
  kvkkMethod: string | null
  reminderConsent: boolean
  marketingConsentAt: string | null
  version: number
  createdAt: string
  createdByName: string | null
  updatedAt: string
  updatedByName: string | null
  animals: OwnerAnimalRow[]
  consents: ConsentRow[]
}

export interface MergeInput {
  /** Silinecek (taşınacak) kayıt */
  otherId: string
  /** Alan alan: 'other' seçilenler diğer kayıttan alınır */
  pick: Partial<Record<MergeField, 'keep' | 'other'>>
}
export const MERGE_FIELDS = [
  'firstName', 'lastName', 'tckn', 'birthDate', 'phone', 'phone2', 'email', 'city', 'district', 'address', 'emergency', 'notes',
] as const
export type MergeField = (typeof MERGE_FIELDS)[number]
export const MERGE_FIELD_LABEL: Record<MergeField, string> = {
  firstName: 'Ad',
  lastName: 'Soyad',
  tckn: 'TCKN',
  birthDate: 'Doğum tarihi',
  phone: 'Cep telefonu',
  phone2: 'İkinci telefon',
  email: 'E-posta',
  city: 'İl',
  district: 'İlçe',
  address: 'Adres',
  emergency: 'Acil durum kişisi',
  notes: 'Not',
}

export interface HistoryRow {
  id: number
  at: string
  action: string
  entity: string
  summary: string | null
  userName: string | null
}

/* ---------- Hayvanlar ---------- */

export interface AnimalListRow extends AnimalListItem {
  neutered: boolean
  passportNo: string | null
  lastVisit: string | null
  allergies: string[]
  behavior: string | null
}

export interface AnimalFormInput {
  name: string
  species: Species
  breed?: string
  sex: Sex
  neutered: boolean
  neuteredAt?: string
  birthDate: string
  birthDateEstimated: boolean
  color?: string
  marks?: string
  passportNo?: string
  bloodGroup?: string
  allergies?: string[]
  chronicDiseases?: string[]
  behavior?: Behavior | ''
  diet?: string
  source?: AnimalSource | ''
  sourceDetail?: string
  notes?: string
}

export interface AnimalCreateInput extends AnimalFormInput {
  ownerId: string
  /** İlk kilo ölçümü (kg) */
  weightKg?: number
}

export interface AnimalUpdateInput extends AnimalFormInput {
  version: number
}

export interface ChipFullDto {
  id: string
  chipNo: string
  format: string
  implantedAt: string | null
  implantedByName: string | null
  bodySite: string | null
  lotNo: string | null
  status: string
  createdAt: string
}

export interface ChipEventRow {
  id: string
  chipNo: string
  kind: string
  data: Record<string, unknown>
  at: string
  userName: string | null
}

export interface AnimalDetailFull extends AnimalDetail {
  neuteredAt: string | null
  marks: string | null
  chronicDiseases: string[]
  bloodGroup: string | null
  diet: string | null
  source: string | null
  sourceDetail: string | null
  statusDate: string | null
  version: number
  updatedAt: string
  createdByName: string | null
  updatedByName: string | null
  lastWeight: { kg: number; measuredAt: string } | null
  chipsFull: ChipFullDto[]
  chipEvents: ChipEventRow[]
}

export interface TimelineRow {
  at: string
  kind: 'chip' | 'status' | 'petvet' | 'weight' | 'create'
  title: string
  detail: string
  userName: string | null
  petvetStatus?: PetvetStatus
}

export interface WeightRow {
  id: string
  kg: number
  measuredAt: string
  source: string
  userName: string | null
}

export interface OwnershipRow {
  ownerId: string
  ownerName: string
  phone: string | null
  isPrimary: boolean
  fromDate: string
  toDate: string | null
  endReason: string | null
}

export interface StatusResult {
  ok: true
  petvetTaskId: string | null
  petvetKind: PetvetTaskKind | null
  petvetStatus: PetvetStatus | null
  dueDate: string | null
  warnings?: string[]
}

export interface DeathInput {
  date: string
  cause: DeathCause
  note?: string
  confirm: boolean
}
export interface LostInput {
  date: string
  city?: string
  district?: string
  place?: string
  note?: string
  /** Klinik PETVET'e kayıp bildirimi girecek mi */
  openPetvet?: boolean
}
export interface FoundInput {
  date: string
  note?: string
}
export interface TransferInput {
  date: string
  newOwnerId: string
  reason?: string
  /** Eski sahip(ler) tamamen çıkarılsın mı (varsayılan evet) */
  removeOldOwners?: boolean
}

export interface ImplantInput {
  chipNo: string
  date: string
  vetId: string
  bodySite: string
  bodySiteReason?: string
  lotNo?: string
  passportNo?: string
  verified: boolean
  /** İkinci çip: mevcut aktif çip "pasif" olur */
  second?: boolean
}

export interface CorrectChipInput {
  newChipNo: string
  reason: string
}

export interface ChipActionResult extends StatusResult {
  chipId: string
}
