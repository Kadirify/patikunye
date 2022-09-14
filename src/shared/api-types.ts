// API ile arayüz arasında paylaşılan veri tipleri
import type { ChipResult } from './chip'
import type { PetvetStatus, PetvetTaskKind, Urgency } from './petvet'

export type Role = 'admin' | 'vet' | 'tech' | 'secretary'
export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Klinik Yöneticisi',
  vet: 'Hekim',
  tech: 'Teknisyen',
  secretary: 'Sekreter',
}

export type Species = 'cat' | 'dog' | 'ferret' | 'bird' | 'rabbit' | 'rodent' | 'reptile' | 'other'
export const SPECIES_LABEL: Record<Species, string> = {
  cat: 'Kedi',
  dog: 'Köpek',
  ferret: 'Gelincik',
  bird: 'Kuş',
  rabbit: 'Tavşan',
  rodent: 'Kemirgen',
  reptile: 'Sürüngen',
  other: 'Diğer',
}
/** PETVET kapsamındaki türler */
export const PETVET_SPECIES: Species[] = ['cat', 'dog', 'ferret']

export type Sex = 'male' | 'female' | 'unknown'
export const SEX_LABEL: Record<Sex, string> = { male: 'Erkek', female: 'Dişi', unknown: 'Bilinmiyor' }

export const BODY_SITES = ['Boyun sol', 'Boyun sağ', 'Sol arka bacak', 'Sağ arka bacak', 'Göğüs', 'Diğer'] as const

export interface UserDto {
  id: string
  username: string
  fullName: string
  role: Role
  chamberRegNo: string | null
}

export interface SessionDto {
  token: string
  user: UserDto
  clinicName: string
}

export interface OwnerListItem {
  id: string
  fullName: string
  phone: string | null
  city: string | null
  district: string | null
  tcknLast4: string | null
  animalCount: number
  kvkkNoticeAt: string | null
}

export interface OwnerInput {
  firstName: string
  lastName: string
  tckn?: string
  birthDate?: string
  phone: string
  email?: string
  city?: string
  district?: string
  address?: string
  emergencyName?: string
  emergencyPhone?: string
  kvkkNotice: boolean
  reminderConsent?: boolean
}

export interface AnimalListItem {
  id: string
  name: string
  species: Species
  breed: string | null
  sex: Sex
  birthDate: string | null
  status: string
  chipNo: string | null
  ownerId: string | null
  ownerName: string | null
  ownerPhone: string | null
  petvet: { status: PetvetStatus; dueDate: string; urgency: Urgency; daysLeft: number } | null
}

export interface AnimalInput {
  name: string
  species: Species
  breed?: string
  sex: Sex
  neutered: boolean
  birthDate: string
  birthDateEstimated: boolean
  color?: string
}

export interface ChipDto {
  id: string
  chipNo: string
  format: string
  implantedAt: string | null
  implantedByName: string | null
  bodySite: string | null
  status: string
}

export interface PetvetTaskListItem {
  id: string
  kind: PetvetTaskKind
  status: PetvetStatus
  eventDate: string
  dueDate: string
  urgency: Urgency
  daysLeft: number
  animalId: string
  animalName: string
  species: Species
  chipNo: string | null
  ownerName: string | null
  vetName: string | null
  missingFields: string[]
  doneAt: string | null
  petvetRef: string | null
}

export interface AnimalDetail {
  id: string
  name: string
  species: Species
  breed: string | null
  sex: Sex
  neutered: boolean
  birthDate: string | null
  birthDateEstimated: boolean
  color: string | null
  passportNo: string | null
  status: string
  allergies: string[]
  behavior: string | null
  notes: string | null
  createdAt: string
  owners: { id: string; fullName: string; phone: string | null; isPrimary: boolean; tcknLast4: string | null }[]
  chips: ChipDto[]
  petvetTasks: PetvetTaskListItem[]
}

export interface ChipLookupDto {
  validation: ChipResult
  match: null | {
    animal: AnimalListItem
    chip: ChipDto
  }
}

export interface QuickRegisterInput {
  chipNo: string
  ownerId?: string
  owner?: OwnerInput
  animal: AnimalInput
  implant: {
    date: string
    vetId: string
    bodySite: string
    passportNo?: string
    lotNo?: string
    verified: boolean
  }
}

export interface QuickRegisterResult {
  animalId: string
  ownerId: string
  petvetTaskId: string | null
  petvetStatus: PetvetStatus | null
  dueDate: string | null
}

export interface PetvetTaskDetail extends PetvetTaskListItem {
  /** TARBİL'e kopyalanacak alanlar (PETVET biçiminde) */
  copyFields: { group: 'owner' | 'animal'; key: string; label: string; value: string }[]
  note: string | null
  vetId: string | null
  ownerId: string | null
}

export interface PetvetSummary {
  overdue: number
  today: number
  week: number
  open: number
  missing: number
  doneThisMonth: number
}

export interface DashboardDto {
  today: string
  petvet: PetvetSummary
  urgentTasks: PetvetTaskListItem[]
  recentAnimals: AnimalListItem[]
  chipsThisMonth: number
}

export interface ApiError {
  error: string
  code?: string
  details?: unknown
}
