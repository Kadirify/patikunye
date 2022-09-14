// Yedekleme modülü (G) API tipleri — sunucu ve arayüz ortak kullanır.

export type BackupReason = 'daily' | 'manual' | 'pre_update' | 'pre_restore'

export const BACKUP_REASON_LABEL: Record<BackupReason, string> = {
  daily: 'Günlük',
  manual: 'Elle',
  pre_update: 'Güncelleme öncesi',
  pre_restore: 'Geri yükleme öncesi',
}

/** Geri yükleme onayında yazılması gereken metin */
export const RESTORE_CONFIRM_TEXT = 'GERİ YÜKLE'

/** Yedek parolası en az uzunluğu */
export const BACKUP_PASSWORD_MIN = 8

export type BackupState = 'ok' | 'warn' | 'err'

/** GET /api/backup/status — kenar çubuğu, durum çubuğu ve Bugün ekranı */
export interface BackupStatusDto {
  lastSuccessAt: string | null
  /** Son başarılı yedekten bu yana geçen saat (yoksa null) */
  hoursAgo: number | null
  /** ok < 24 saat, warn < 72 saat, err ≥ 72 saat ya da hiç yedek yok / parola yok */
  state: BackupState
  passwordSet: boolean
  lastError: string | null
  lastErrorAt: string | null
  running: boolean
}

export interface BackupTargetResult {
  path: string
  ok: boolean
  error?: string
  /** Hedef sistem diskiyle (ya da veri klasörüyle) aynı diskte */
  sameDisk?: boolean
}

export interface BackupListItem {
  id: string
  startedAt: string
  finishedAt: string | null
  reason: BackupReason
  fileName: string | null
  size: number | null
  targets: BackupTargetResult[]
  rowsTotal: number | null
  filesTotal: number | null
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyResult: string | null
  error: string | null
}

export interface BackupResultDto {
  id: string
  fileName: string
  size: number
  rowsTotal: number
  filesTotal: number
  targets: BackupTargetResult[]
  verified: boolean
  warnings: string[]
}

export interface VerifyResultDto {
  ok: true
  createdAt: string
  appVersion: string
  reason: BackupReason | string
  tables: number
  rowsTotal: number
  files: number
  fileBytes: number
  summary: string
}

export interface RestoreResultDto {
  ok: true
  preRestoreBackupId: string | null
  tables: number
  rowsTotal: number
  files: number
  warnings: string[]
}

export interface BackupTargetInfo {
  path: string
  /** Sistem diski | Diğer disk | Ağ klasörü | Varsayılan (veri klasörü) */
  kind: string
  freeBytes: number | null
  exists: boolean
  sameDisk: boolean
  lastOkAt: string | null
  lastError: string | null
  isDefault: boolean
}

export interface BackupSettingsDto {
  time: string
  keepDaily: number
  keepMonthly: number
  targets: string[]
  /** Hedef tanımlı değilse kullanılan klasör */
  defaultTarget: string
  passwordSet: boolean
  passwordSetAt: string | null
}

export interface TargetTestDto {
  path: string
  writable: boolean
  error?: string
  freeBytes: number | null
  sameDisk: boolean
  kind: string
}

// ---- Veritabanı (S-111) ----

export interface DbTableInfo {
  name: string
  rows: number
  totalBytes: number
  lastVacuum: string | null
  lastAnalyze: string | null
}

export interface DbMigrationInfo {
  name: string
  appliedAt: string | null
  kind: 'drizzle' | 'module'
}

export interface DbStatusDto {
  running: true
  version: string
  port: number | null
  dataDir: string
  sizeBytes: number
  tables: DbTableInfo[]
  migrations: DbMigrationInfo[]
  lastMaintenanceAt: string | null
}

export interface DiagnosticsDto {
  generatedAt: string
  appVersion: string
  platform: string
  node: string
  postgres: string
  dbSizeBytes: number
  tables: { name: string; rows: number }[]
  migrations: string[]
  backup: { lastSuccessAt: string | null; state: BackupState }
  postgresLog: string[]
}
