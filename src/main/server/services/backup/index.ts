// Yedekleme servisi : uygulama düzeyinde mantıksal yedek (.pkb), doğrulama, geri yükleme, saklama.
//
// Önemli: yedek, alındığı kurulumun veri anahtarlarından BAĞIMSIZDIR.
//  - "*_enc" sütunları (TCKN, pasaport no, SMS/SMTP sırları ...) dışa aktarılırken çözülür ve yedekte
//    (yedek parolasıyla şifreli bütünün içinde) düz tutulur. Geri yüklemede bu kurulumun anahtarıyla
//    yeniden şifrelenir; aynı önekli "*_hash" sütunu (ör. tckn_hash) yeniden hesaplanır.
//  - Ek dosyalar çözülmüş içerikle yedeğe girer; geri yüklemede bu kurulumun dosya anahtarıyla
//    yeniden yazılır ve attachments.storage_key güncellenir.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import type pg from 'pg'
import pkg from '../../../../../package.json'
import { AppError, type AppDeps } from '../../context'
import { writeAudit, type AuditEntry } from '../../audit'
import { getSettings } from '../../settings'
import { REC, corrupt, encodeRecord, json, readPkb, writePkb } from './format'
import {
  BACKUP_PASSWORD_MIN,
  type BackupReason,
  type BackupResultDto,
  type BackupStatusDto,
  type BackupTargetResult,
  type RestoreResultDto,
  type VerifyResultDto,
} from '../../../../shared/backup'

export const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0'

/** Yedeğe hiç girmeyen tablolar (kurulum-yerel) */
const SKIP_EXPORT = new Set(['backup_config', 'backups'])
/** Geri yüklemede dokunulmayan tablolar (migration durumu bu kurulumundur) */
const SKIP_RESTORE = new Set(['backup_config', 'backups', 'pk_migrations'])

const FILE_CHUNK = 256 * 1024
const MAX_FILE_IN_BACKUP = 64 * 1024 * 1024
const ROW_BATCH = 500
const ROW_BATCH_BYTES = 4 * 1024 * 1024

type Queryable = Pick<pg.PoolClient, 'query'>

// ---------------------------------------------------------------- kilit ve durum

let chain: Promise<unknown> = Promise.resolve()
let running = false
/** Aynı anda tek yedek/geri yükleme */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    running = true
    try {
      return await fn()
    } finally {
      running = false
    }
  })
  chain = next.catch(() => undefined)
  return next
}
export const isBackupRunning = () => running

const nowOf = (deps: AppDeps) => deps.now?.() ?? new Date()

/**
 * Denetim kaydı; kullanıcı artık yoksa (başka kurulumdan geri yüklemeden sonra eski oturum)
 * user_id boş yazılır - yabancı anahtar hatası yedeği/geri yüklemeyi bozmasın.
 */
export async function auditSafe(deps: AppDeps, e: AuditEntry) {
  let userId = e.userId
  if (userId && !(await deps.db.$client.query('select 1 from users where id = $1', [userId])).rowCount) userId = null
  await writeAudit(deps.db, { ...e, userId })
}

// ---------------------------------------------------------------- yedek parolası

const PW_KDF = { log2N: 15, r: 8, p: 1 }

function scryptAsync(pw: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** log2N
  return new Promise((res, rej) =>
    scryptCb(pw.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))),
  )
}

async function makeVerifier(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const h = await scryptAsync(pw, salt, PW_KDF.log2N, PW_KDF.r, PW_KDF.p)
  return ['scrypt', PW_KDF.log2N, PW_KDF.r, PW_KDF.p, salt.toString('base64'), h.toString('base64')].join('$')
}

async function checkVerifier(verifier: string, pw: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = verifier.split('$')
  if (alg !== 'scrypt') return false
  const h = await scryptAsync(pw, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  const want = Buffer.from(hash, 'base64')
  return want.length === h.length && timingSafeEqual(want, h)
}

export async function getBackupConfig(deps: AppDeps): Promise<{ passwordSet: boolean; passwordSetAt: string | null }> {
  const r = await deps.db.$client.query('select password_verifier, password_set_at from backup_config where id = 1')
  const row = r.rows[0]
  return { passwordSet: !!row?.password_verifier, passwordSetAt: row?.password_set_at ? new Date(row.password_set_at).toISOString() : null }
}

/** Otomatik yedek için saklanan parola (bu kurulumun anahtarıyla şifreli) */
async function storedPassword(deps: AppDeps): Promise<string | null> {
  const r = await deps.db.$client.query('select password_enc from backup_config where id = 1')
  const enc = r.rows[0]?.password_enc as string | undefined
  if (!enc) return null
  try {
    return deps.crypto.decrypt(enc)
  } catch {
    return null
  }
}

/** Doğrulama için: parola girilmediyse saklanan yedek parolası */
export const storedPasswordForVerify = (deps: AppDeps) => storedPassword(deps)

export async function checkBackupPassword(deps: AppDeps, pw: string): Promise<boolean> {
  const r = await deps.db.$client.query('select password_verifier from backup_config where id = 1')
  const v = r.rows[0]?.password_verifier as string | undefined
  return !!v && checkVerifier(v, pw)
}

/**
 * Yedek parolasını belirler/değiştirir. Kurulum sihirbazı (adım 7) kurtarma koduyla çağırır.
 * Parola daha önce belirlendiyse mevcut parola gerekir (force: kurulum/geri yükleme içi kullanım).
 */
export async function setBackupPassword(
  deps: AppDeps,
  newPassword: string,
  opts: { currentPassword?: string; userId?: string | null; force?: boolean } = {},
): Promise<void> {
  if (newPassword.length < BACKUP_PASSWORD_MIN) throw new AppError(400, `Yedek parolası en az ${BACKUP_PASSWORD_MIN} karakter olmalı.`, 'VALIDATION')
  const cfg = await getBackupConfig(deps)
  if (cfg.passwordSet && !opts.force) {
    if (!opts.currentPassword || !(await checkBackupPassword(deps, opts.currentPassword)))
      throw new AppError(400, 'Mevcut yedek parolası yanlış.', 'BACKUP_WRONG_PASSWORD')
  }
  const verifier = await makeVerifier(newPassword)
  await deps.db.$client.query(
    `insert into backup_config (id, password_verifier, password_enc, password_set_at, password_set_by, updated_at)
     values (1, $1, $2, $3, $4, now())
     on conflict (id) do update set password_verifier = excluded.password_verifier, password_enc = excluded.password_enc,
       password_set_at = excluded.password_set_at, password_set_by = excluded.password_set_by, updated_at = now()`,
    [verifier, deps.crypto.encrypt(newPassword), nowOf(deps), opts.userId ?? null],
  )
  await auditSafe(deps, {
    userId: opts.userId ?? null,
    action: 'update',
    entity: 'backup_config',
    summary: cfg.passwordSet ? 'Yedek parolası değiştirildi' : 'Yedek parolası belirlendi',
  })
}

// ---------------------------------------------------------------- hedefler

export const defaultTarget = (deps: AppDeps) => join(deps.dataRoot, 'backups')

export async function resolveTargets(deps: AppDeps): Promise<string[]> {
  const s = await getSettings(deps.db)
  return s.backup.targets.length ? s.backup.targets : [defaultTarget(deps)]
}

const driveOf = (p: string) => /^([a-zA-Z]):/.exec(resolve(p))?.[1]?.toUpperCase() ?? null
const isUnc = (p: string) => /^\\\\|^\/\//.test(p)

async function existingAncestor(p: string): Promise<string> {
  let cur = resolve(p)
  for (;;) {
    if (existsSync(cur)) return cur
    const up = dirname(cur)
    if (up === cur) return cur
    cur = up
  }
}

/** Hedef sistem diskiyle ya da veri klasörüyle aynı diskte mi (Windows: sürücü harfi) */
export async function isSameDisk(deps: AppDeps, target: string): Promise<boolean> {
  if (process.platform === 'win32') {
    if (isUnc(target)) return false
    const d = driveOf(target)
    const sys = (process.env.SystemDrive ?? 'C:').slice(0, 1).toUpperCase()
    return d === sys || d === driveOf(deps.dataRoot)
  }
  try {
    const a = await stat(await existingAncestor(target))
    const b = await stat(await existingAncestor(deps.dataRoot))
    const root = await stat(parsePath(resolve(target)).root)
    return a.dev === b.dev || a.dev === root.dev
  } catch {
    return false
  }
}

export function targetKind(deps: AppDeps, target: string): string {
  if (resolve(target) === resolve(defaultTarget(deps))) return 'Veri klasörü (varsayılan)'
  if (isUnc(target)) return 'Ağ klasörü'
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive ?? 'C:').slice(0, 1).toUpperCase()
    return driveOf(target) === sys ? 'Sistem diski' : 'Diğer disk / USB'
  }
  return 'Klasör'
}

export async function freeBytes(target: string): Promise<number | null> {
  try {
    const s = await statfs(await existingAncestor(target))
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export function fsErrorText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ENOSPC':
      return 'Diskte yer yok'
    case 'EACCES':
    case 'EPERM':
      return 'Yazma izni yok'
    case 'ENOENT':
    case 'ENOTDIR':
      return 'Klasör ya da sürücü bulunamadı (USB disk takılı mı?)'
    case 'EROFS':
      return 'Disk salt okunur'
    case 'EBUSY':
      return 'Dosya kullanımda'
    default:
      return e instanceof Error ? e.message : String(e)
  }
}

/** Klasöre yazılabiliyor mu: oluştur, deneme dosyası yaz/oku/sil */
export async function testTarget(target: string): Promise<{ writable: boolean; error?: string }> {
  if (!isAbsolute(target)) return { writable: false, error: 'Tam klasör yolu girin (ör. E:\\PatiKunye Yedek).' }
  const probe = join(target, `.patikunye-deneme-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(target, { recursive: true })
    await writeFile(probe, 'patikunye')
    const back = await readFile(probe, 'utf8')
    await unlink(probe)
    if (back !== 'patikunye') return { writable: false, error: 'Yazılan deneme dosyası geri okunamadı' }
    return { writable: true }
  } catch (e) {
    await unlink(probe).catch(() => undefined)
    return { writable: false, error: fsErrorText(e) }
  }
}

// ---------------------------------------------------------------- şema bilgisi

interface TableMeta {
  name: string
  columns: string[]
  /** INSERT'e yazılabilen sütunlar (üretilmiş sütunlar hariç) */
  insertable: Set<string>
  identityAlways: boolean
}

async function readSchema(q: Queryable) {
  const t = await q.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition order by c.relname`,
  )
  const cols = await q.query<{ table_name: string; column_name: string; is_generated: string; identity_generation: string | null }>(
    `select table_name, column_name, is_generated, identity_generation from information_schema.columns
      where table_schema = 'public' order by table_name, ordinal_position`,
  )
  const tables = new Map<string, TableMeta>()
  for (const r of t.rows) tables.set(r.relname, { name: r.relname, columns: [], insertable: new Set(), identityAlways: false })
  for (const c of cols.rows) {
    const tm = tables.get(c.table_name)
    if (!tm) continue
    tm.columns.push(c.column_name)
    if (c.is_generated !== 'ALWAYS') tm.insertable.add(c.column_name)
    if (c.identity_generation === 'ALWAYS') tm.identityAlways = true
  }
  const fks = await q.query<{ conname: string; child: string; parent: string; condeferrable: boolean; condeferred: boolean }>(
    `select con.conname, ch.relname as child, pa.relname as parent, con.condeferrable, con.condeferred
       from pg_constraint con
       join pg_class ch on ch.oid = con.conrelid
       join pg_class pa on pa.oid = con.confrelid
       join pg_namespace n on n.oid = ch.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`,
  )
  return { tables, fks: fks.rows }
}

/** Yabancı anahtar sırası: önce başvurulan tablolar (döngüler sona, ada göre) */
function topoOrder(names: string[], fks: { child: string; parent: string }[]): string[] {
  const set = new Set(names)
  const deps = new Map(names.map((n) => [n, new Set<string>()]))
  for (const f of fks) if (set.has(f.child) && set.has(f.parent) && f.child !== f.parent) deps.get(f.child)!.add(f.parent)
  const out: string[] = []
  const done = new Set<string>()
  let progress = true
  while (progress) {
    progress = false
    for (const n of [...names].sort()) {
      if (done.has(n)) continue
      if ([...deps.get(n)!].every((p) => done.has(p))) {
        out.push(n)
        done.add(n)
        progress = true
      }
    }
  }
  for (const n of [...names].sort()) if (!done.has(n)) out.push(n)
  return out
}

const qi = (s: string) => '"' + s.replace(/"/g, '""') + '"'

async function migrationState(q: Queryable): Promise<{ module: string[]; drizzle: string[] }> {
  let module: string[] = []
  let drizzle: string[] = []
  try {
    module = (await q.query<{ name: string }>('select name from pk_migrations order by name')).rows.map((r) => r.name)
  } catch {
    /* tablo yok */
  }
  try {
    drizzle = (await q.query<{ hash: string }>('select hash from drizzle.__drizzle_migrations order by id')).rows.map((r) => r.hash)
  } catch {
    /* tablo yok */
  }
  return { module, drizzle }
}

// ---------------------------------------------------------------- dosya anahtarı (files.ts ile aynı)

const fileKeyOf = (deps: AppDeps) => Buffer.from(deps.crypto.hash('file-key'), 'base64url').subarray(0, 32)

function decryptStoredFile(deps: AppDeps, raw: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', fileKeyOf(deps), raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()])
}

async function writeStoredFile(deps: AppDeps, data: Buffer): Promise<string> {
  await mkdir(deps.filesDir, { recursive: true })
  const key = randomUUID() + '.bin'
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', fileKeyOf(deps), iv)
  const enc = Buffer.concat([c.update(data), c.final()])
  await writeFile(join(deps.filesDir, key), Buffer.concat([iv, c.getAuthTag(), enc]))
  return key
}

// ---------------------------------------------------------------- yedek içeriği

export interface BackupMeta {
  format: 1
  app: string
  createdAt: string
  reason: string
  clinicName: string | null
  migrations: { module: string[]; drizzle: string[] }
  tables: { name: string; columns: string[] }[]
  /** *_enc sütunları düz metin olarak saklandı */
  encPlain: true
}

export interface BackupTrailer {
  tables: Record<string, { rows: number; sha256: string }>
  rowsTotal: number
  files: { count: number; bytes: number; items: Record<string, string> }
  warnings: string[]
}

async function* exportRecords(
  deps: AppDeps,
  client: Queryable,
  ctx: { reason: string; createdAt: Date; warnings: string[]; trailer?: BackupTrailer },
): AsyncGenerator<Buffer> {
  const { tables, fks } = await readSchema(client)
  const names = topoOrder([...tables.keys()].filter((n) => !SKIP_EXPORT.has(n)), fks)
  let clinicName: string | null = null
  try {
    clinicName = (await client.query('select name from clinic limit 1')).rows[0]?.name ?? null
  } catch {
    /* yok */
  }
  const meta: BackupMeta = {
    format: 1,
    app: APP_VERSION,
    createdAt: ctx.createdAt.toISOString(),
    reason: ctx.reason,
    clinicName,
    migrations: await migrationState(client),
    tables: names.map((n) => ({ name: n, columns: tables.get(n)!.columns })),
    encPlain: true,
  }
  yield encodeRecord(REC.META, JSON.stringify(meta))

  const trailer: BackupTrailer = { tables: {}, rowsTotal: 0, files: { count: 0, bytes: 0, items: {} }, warnings: ctx.warnings }
  for (const name of names) {
    const tm = tables.get(name)!
    const encCols = tm.columns.filter((c) => c.endsWith('_enc'))
    yield encodeRecord(REC.TABLE, JSON.stringify({ name, columns: tm.columns }))
    const hash = createHash('sha256')
    let rows = 0
    await client.query(`declare pk_cur no scroll cursor for select to_jsonb(t)::text as r from public.${qi(name)} t`)
    for (;;) {
      const batch = await client.query<{ r: string }>('fetch 500 from pk_cur')
      if (!batch.rowCount) break
      for (const { r } of batch.rows) {
        let text = r
        if (encCols.length) {
          const obj = JSON.parse(r) as Record<string, unknown>
          for (const c of encCols) {
            const v = obj[c]
            if (typeof v === 'string' && v) {
              try {
                obj[c] = deps.crypto.decrypt(v)
              } catch {
                obj[c] = null
                ctx.warnings.push(`${name}.${c}: bir değer çözülemedi, yedeğe boş yazıldı`)
              }
            }
          }
          text = JSON.stringify(obj)
        }
        hash.update(text).update('\n')
        rows++
        yield encodeRecord(REC.ROW, text)
      }
    }
    await client.query('close pk_cur')
    const sha256 = hash.digest('hex')
    trailer.tables[name] = { rows, sha256 }
    trailer.rowsTotal += rows
    yield encodeRecord(REC.TABLE_END, JSON.stringify({ name, rows, sha256 }))
  }

  // Ek dosyalar (çözülmüş içerik)
  if (tables.has('attachments')) {
    const att = await client.query<{ id: string; storage_key: string }>('select id, storage_key from attachments order by created_at, id')
    for (const a of att.rows) {
      let data: Buffer
      try {
        data = decryptStoredFile(deps, await readFile(join(deps.filesDir, a.storage_key)))
      } catch {
        ctx.warnings.push(`Ek dosya okunamadı (${a.id}); yedeğe alınmadı`)
        continue
      }
      const sha = createHash('sha256').update(data).digest('hex')
      yield encodeRecord(REC.FILE, JSON.stringify({ attachmentId: a.id, size: data.length, sha256: sha }))
      for (let i = 0; i < data.length; i += FILE_CHUNK) yield encodeRecord(REC.FILE_DATA, data.subarray(i, i + FILE_CHUNK))
      yield encodeRecord(REC.FILE_END, '')
      trailer.files.count++
      trailer.files.bytes += data.length
      trailer.files.items[a.id] = sha
    }
  }
  ctx.trailer = trailer
  yield encodeRecord(REC.TRAILER, JSON.stringify(trailer))
}

// ---------------------------------------------------------------- okuma / doğrulama

interface WalkHandlers {
  onMeta?(m: BackupMeta): Promise<void> | void
  onTable?(name: string, columns: string[]): Promise<void> | void
  onRow?(table: string, text: string): Promise<void> | void
  onTableEnd?(name: string, rows: number): Promise<void> | void
  onFile?(attachmentId: string, data: Buffer): Promise<void> | void
}

interface WalkResult {
  meta: BackupMeta
  trailer: BackupTrailer
  tables: number
  rowsTotal: number
  files: number
  fileBytes: number
}

/** Yedeği baştan sona okur; her tablo/dosya için sayım ve sha256'yı manifestle karşılaştırır. */
async function walk(path: string, password: string, h: WalkHandlers = {}): Promise<WalkResult> {
  let meta: BackupMeta | null = null
  let trailer: BackupTrailer | null = null
  let cur: { name: string; rows: number; hash: ReturnType<typeof createHash> } | null = null
  let file: { id: string; size: number; sha256: string; chunks: Buffer[]; got: number } | null = null
  const tables = new Map<string, { rows: number; sha256: string }>()
  const files = new Map<string, string>()
  let fileBytes = 0

  for await (const r of readPkb(path, password)) {
    if (!meta && r.type !== REC.META) throw corrupt('başlık kaydı yok')
    if (trailer) throw corrupt('manifestten sonra veri var')
    switch (r.type) {
      case REC.META: {
        if (meta) throw corrupt('çift başlık')
        meta = json<BackupMeta>(r)
        if (meta.format !== 1 || !Array.isArray(meta.tables)) throw corrupt('başlık')
        await h.onMeta?.(meta)
        break
      }
      case REC.TABLE: {
        if (cur || file) throw corrupt('sıra')
        const t = json<{ name: string; columns: string[] }>(r)
        cur = { name: t.name, rows: 0, hash: createHash('sha256') }
        await h.onTable?.(t.name, t.columns)
        break
      }
      case REC.ROW: {
        if (!cur) throw corrupt('tablo dışı satır')
        const text = r.payload.toString('utf8')
        cur.hash.update(text).update('\n')
        cur.rows++
        await h.onRow?.(cur.name, text)
        break
      }
      case REC.TABLE_END: {
        if (!cur) throw corrupt('sıra')
        const e = json<{ name: string; rows: number; sha256: string }>(r)
        const sha256 = cur.hash.digest('hex')
        if (e.name !== cur.name || e.rows !== cur.rows || e.sha256 !== sha256) throw corrupt(`${cur.name} tablosu tutmuyor`)
        tables.set(cur.name, { rows: cur.rows, sha256 })
        await h.onTableEnd?.(cur.name, cur.rows)
        cur = null
        break
      }
      case REC.FILE: {
        if (cur || file) throw corrupt('sıra')
        const f = json<{ attachmentId: string; size: number; sha256: string }>(r)
        if (f.size > MAX_FILE_IN_BACKUP) throw corrupt('ek dosya boyutu')
        file = { id: f.attachmentId, size: f.size, sha256: f.sha256, chunks: [], got: 0 }
        break
      }
      case REC.FILE_DATA: {
        if (!file) throw corrupt('sıra')
        file.got += r.payload.length
        if (file.got > file.size) throw corrupt('ek dosya boyutu')
        file.chunks.push(Buffer.from(r.payload))
        break
      }
      case REC.FILE_END: {
        if (!file) throw corrupt('sıra')
        const data = Buffer.concat(file.chunks)
        const sha = createHash('sha256').update(data).digest('hex')
        if (data.length !== file.size || sha !== file.sha256) throw corrupt('ek dosya özeti tutmuyor')
        files.set(file.id, sha)
        fileBytes += data.length
        await h.onFile?.(file.id, data)
        file = null
        break
      }
      case REC.TRAILER: {
        if (cur || file) throw corrupt('sıra')
        trailer = json<BackupTrailer>(r)
        break
      }
      default:
        throw corrupt('bilinmeyen kayıt')
    }
  }
  if (!meta || !trailer) throw corrupt('manifest yok')
  // Manifest karşılaştırması
  const tKeys = Object.keys(trailer.tables)
  if (tKeys.length !== tables.size) throw corrupt('tablo sayısı tutmuyor')
  let rowsTotal = 0
  for (const k of tKeys) {
    const a = trailer.tables[k]
    const b = tables.get(k)
    if (!b || a.rows !== b.rows || a.sha256 !== b.sha256) throw corrupt(`${k} sayımı tutmuyor`)
    rowsTotal += b.rows
  }
  if (rowsTotal !== trailer.rowsTotal) throw corrupt('toplam satır tutmuyor')
  if (trailer.files.count !== files.size || trailer.files.bytes !== fileBytes) throw corrupt('ek dosya sayısı tutmuyor')
  for (const [id, sha] of files) if (trailer.files.items[id] !== sha) throw corrupt('ek dosya özeti tutmuyor')
  return { meta, trailer, tables: tables.size, rowsTotal, files: files.size, fileBytes }
}

/** Yalnızca başlığı okur (sürüm denetimi için). Parolayı da denetler. */
export async function readBackupMeta(path: string, password: string): Promise<BackupMeta> {
  for await (const r of readPkb(path, password)) {
    if (r.type !== REC.META) throw corrupt('başlık kaydı yok')
    return json<BackupMeta>(r)
  }
  throw corrupt('boş yedek')
}

/** Yedeği geri yüklemeden doğrular: şifre çöz + aç + tüm satırları say + sha256 karşılaştır. */
export async function verifyBackup(path: string, password: string): Promise<VerifyResultDto> {
  const w = await walk(path, password)
  return {
    ok: true,
    createdAt: w.meta.createdAt,
    appVersion: w.meta.app,
    reason: w.meta.reason,
    tables: w.tables,
    rowsTotal: w.rowsTotal,
    files: w.files,
    fileBytes: w.fileBytes,
    summary: `Açıldı, ${w.tables} tablo, ${w.rowsTotal} satır, ${w.files} dosya; sayımlar tutuyor`,
  }
}

// ---------------------------------------------------------------- yedek alma

/** Dosya adı Türkiye saatiyle (Türkiye 2016'dan beri sabit UTC+3) */
export function backupFileName(at: Date, reason: string): string {
  const s = new Date(at.getTime() + 3 * 3600_000).toISOString() // YYYY-MM-DDTHH:MM:SS
  const d = s.slice(0, 10).replace(/-/g, '')
  const t = s.slice(11, 19).replace(/:/g, '')
  return `patikunye-${d}-${t}-${reason}-${randomBytes(2).toString('hex')}.pkb`
}
const NAME_RE = /^patikunye-(\d{8})-(\d{6})-([a-z_]+)-[0-9a-f]{4}\.pkb$/

/**
 * Yedek alır ve tüm hedeflere yazar (biri başarısızsa diğerleri devam eder).
 * Güncelleme öncesi: createBackup(deps, 'pre_update'). Parola verilmezse saklanan yedek parolası kullanılır.
 */
export function createBackup(
  deps: AppDeps,
  reason: BackupReason,
  opts: { password?: string; userId?: string | null; verify?: boolean } = {},
): Promise<BackupResultDto> {
  return withLock(() => createBackupUnlocked(deps, reason, opts))
}

async function createBackupUnlocked(
  deps: AppDeps,
  reason: BackupReason,
  opts: { password?: string; userId?: string | null; verify?: boolean },
): Promise<BackupResultDto> {
  const db = deps.db.$client
  const startedAt = nowOf(deps)
  const id = (await db.query('insert into backups (started_at, reason, created_by) values ($1,$2,$3) returning id', [startedAt, reason, opts.userId ?? null]))
    .rows[0].id as string
  const fileName = backupFileName(startedAt, reason)
  const tmpDir = join(deps.dataRoot, 'tmp')
  const tmp = join(tmpDir, fileName + '.part')
  try {
    const password = opts.password ?? (await storedPassword(deps))
    if (!password) throw new AppError(409, 'Yedek parolası belirlenmemiş. Ayarlar -> Yedekleme bölümünden parola belirleyin.', 'BACKUP_NO_PASSWORD')
    await mkdir(tmpDir, { recursive: true })

    const ctx: { reason: string; createdAt: Date; warnings: string[]; trailer?: BackupTrailer } = { reason, createdAt: startedAt, warnings: [] }
    const client = await db.connect()
    let written: { size: number; sha256: string }
    try {
      await client.query('begin isolation level repeatable read read only')
      written = await writePkb(tmp, password, exportRecords(deps, client, ctx))
      await client.query('commit')
    } catch (e) {
      await client.query('rollback').catch(() => undefined)
      throw e
    } finally {
      client.release()
    }
    const trailer = ctx.trailer!

    let verifyText: string | null = null
    if (opts.verify !== false) verifyText = (await verifyBackup(tmp, password)).summary

    const results: BackupTargetResult[] = []
    for (const t of await resolveTargets(deps)) {
      const r: BackupTargetResult = { path: t, ok: false, sameDisk: await isSameDisk(deps, t) }
      try {
        await mkdir(t, { recursive: true })
        const part = join(t, fileName + '.part')
        await copyFile(tmp, part)
        if ((await stat(part)).size !== written.size) throw new Error('Kopya boyutu tutmuyor')
        await rename(part, join(t, fileName))
        r.ok = true
      } catch (e) {
        r.error = fsErrorText(e)
        await unlink(join(t, fileName + '.part')).catch(() => undefined)
      }
      results.push(r)
    }
    if (!results.some((r) => r.ok))
      throw new AppError(500, 'Yedek hiçbir hedefe yazılamadı: ' + results.map((r) => `${r.path}: ${r.error}`).join('; '), 'BACKUP_NO_TARGET')

    const finishedAt = nowOf(deps)
    await db.query(
      `update backups set finished_at = $2, file_name = $3, size = $4, sha256 = $5, targets = $6, rows_total = $7, files_total = $8,
         verified_at = $9, verify_ok = $10, verify_result = $11, error = null where id = $1`,
      [id, finishedAt, fileName, written.size, written.sha256, JSON.stringify(results), trailer.rowsTotal, trailer.files.count,
        verifyText ? finishedAt : null, verifyText ? true : null, verifyText],
    )
    await auditSafe(deps, {
      userId: opts.userId ?? null,
      action: 'export',
      entity: 'backup',
      entityId: id,
      summary: `Yedek alındı (${reason}): ${fileName}, ${trailer.rowsTotal} satır, ${results.filter((r) => r.ok).length}/${results.length} hedef`,
    })

    // Saklama politikası (yalnızca başarılı hedeflerde)
    const s = await getSettings(deps.db)
    const deleted = new Set<string>()
    for (const r of results.filter((x) => x.ok)) {
      for (const f of await applyRetention(r.path, s.backup.keepDaily, s.backup.keepMonthly, fileName).catch(() => [] as string[])) deleted.add(f)
    }
    if (deleted.size) await markPruned(deps, [...deleted])

    return {
      id,
      fileName,
      size: written.size,
      rowsTotal: trailer.rowsTotal,
      filesTotal: trailer.files.count,
      targets: results,
      verified: !!verifyText,
      warnings: trailer.warnings,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.query('update backups set finished_at = $2, error = $3 where id = $1', [id, nowOf(deps), msg]).catch(() => undefined)
    throw e instanceof AppError ? e : new AppError(500, 'Yedek alınamadı: ' + msg, 'BACKUP_FAILED')
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------- saklama politikası

/**
 * Klasördeki PatiKünye yedeklerinden saklanacakları belirler, diğerlerini siler:
 *  - yedek bulunan en yeni `keepDaily` gündeki tüm yedekler
 *  - en yeni `keepMonthly` ayın her birinin en yeni yedeği
 *  - `protect` (az önce alınan yedek) asla silinmez
 * Dönen: silinen dosya adları.
 */
export async function applyRetention(dir: string, keepDaily: number, keepMonthly: number, protect?: string): Promise<string[]> {
  const files = (await readdir(dir))
    .map((f) => ({ f, m: NAME_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .map((x) => ({ f: x.f, day: x.m[1], stamp: x.m[1] + x.m[2] }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.f < b.f ? 1 : -1))
  const keep = new Set<string>()
  if (protect) keep.add(protect)
  const days: string[] = []
  for (const x of files) if (!days.includes(x.day)) days.push(x.day)
  const keepDays = new Set(days.slice(0, Math.max(1, keepDaily)))
  for (const x of files) if (keepDays.has(x.day)) keep.add(x.f)
  const months = new Map<string, string>()
  for (const x of files) {
    const m = x.day.slice(0, 6)
    if (!months.has(m)) months.set(m, x.f) // sıralı: ilk görülen en yenisi
  }
  for (const f of [...months.values()].slice(0, Math.max(0, keepMonthly))) keep.add(f)
  const deleted: string[] = []
  for (const x of files) {
    if (keep.has(x.f)) continue
    try {
      await unlink(join(dir, x.f))
      deleted.push(x.f)
    } catch {
      /* silinemedi: sonraki sefere */
    }
  }
  return deleted
}

/** Hiçbir hedefte kalmayan yedek kayıtlarını "silindi" işaretler */
async function markPruned(deps: AppDeps, names: string[]) {
  const r = await deps.db.$client.query<{ id: string; file_name: string; targets: BackupTargetResult[] }>(
    'select id, file_name, targets from backups where file_name = any($1) and pruned_at is null',
    [names],
  )
  for (const row of r.rows) {
    const still = (row.targets ?? []).some((t) => t.ok && existsSync(join(t.path, row.file_name)))
    if (!still) await deps.db.$client.query('update backups set pruned_at = $2 where id = $1', [row.id, nowOf(deps)])
  }
}

// ---------------------------------------------------------------- durum

export async function getBackupStatus(deps: AppDeps): Promise<BackupStatusDto> {
  const db = deps.db.$client
  const ok = await db.query('select max(finished_at) as at from backups where error is null and finished_at is not null')
  const err = await db.query(
    `select error, finished_at from backups where error is not null order by started_at desc limit 1`,
  )
  const cfg = await getBackupConfig(deps)
  const last: Date | null = ok.rows[0]?.at ? new Date(ok.rows[0].at) : null
  const hoursAgo = last ? Math.max(0, (nowOf(deps).getTime() - last.getTime()) / 3600_000) : null
  let state: BackupStatusDto['state'] = 'err'
  if (hoursAgo !== null) state = hoursAgo < 24 ? 'ok' : hoursAgo < 72 ? 'warn' : 'err'
  if (!cfg.passwordSet && state === 'ok') state = 'warn'
  const lastErr = err.rows[0]
  const errAfterOk = lastErr && (!last || new Date(lastErr.finished_at) > last)
  return {
    lastSuccessAt: last ? last.toISOString() : null,
    hoursAgo: hoursAgo === null ? null : Math.round(hoursAgo * 10) / 10,
    state,
    passwordSet: cfg.passwordSet,
    lastError: errAfterOk ? lastErr.error : null,
    lastErrorAt: errAfterOk && lastErr.finished_at ? new Date(lastErr.finished_at).toISOString() : null,
    running,
  }
}

/** Yedek kaydının dosyasını hedeflerde arar */
export async function findBackupFile(deps: AppDeps, backupId: string): Promise<string> {
  const r = await deps.db.$client.query<{ file_name: string | null; targets: BackupTargetResult[] }>(
    'select file_name, targets from backups where id = $1',
    [backupId],
  )
  const row = r.rows[0]
  if (!row) throw new AppError(404, 'Yedek kaydı bulunamadı.', 'NOT_FOUND')
  if (!row.file_name) throw new AppError(400, 'Bu yedek tamamlanmamış.', 'BACKUP_INCOMPLETE')
  for (const t of row.targets ?? []) {
    const p = join(t.path, row.file_name)
    if (t.ok && existsSync(p)) return p
  }
  throw new AppError(404, 'Yedek dosyası hiçbir hedefte bulunamadı (USB disk takılı mı?).', 'BACKUP_NOT_FOUND')
}

// ---------------------------------------------------------------- geri yükleme

/**
 * Yedekten geri yükler. Sıra: parola/sürüm denetimi -> "geri yükleme öncesi" yedek -> tek transaction:
 * TRUNCATE ... CASCADE -> satırlar (FK denetimi sona ertelenir) -> ek dosyalar yeniden şifrelenir ->
 * sequence'ler -> sayım denetimi -> commit.
 */
export function restoreBackup(
  deps: AppDeps,
  path: string,
  password: string,
  opts: { userId?: string | null; skipPreBackup?: boolean } = {},
): Promise<RestoreResultDto> {
  return withLock(() => restoreUnlocked(deps, path, password, opts))
}

async function restoreUnlocked(
  deps: AppDeps,
  path: string,
  password: string,
  opts: { userId?: string | null; skipPreBackup?: boolean },
): Promise<RestoreResultDto> {
  const pool = deps.db.$client
  // 1) Parola ve sürüm denetimi (veriye dokunmadan)
  const meta = await readBackupMeta(path, password)
  const cur = await migrationState(pool)
  const newerModule = meta.migrations.module.filter((m) => !cur.module.includes(m))
  const newerDrizzle = meta.migrations.drizzle.filter((m) => !cur.drizzle.includes(m))
  if (newerModule.length || newerDrizzle.length)
    throw new AppError(
      409,
      `Bu yedek daha yeni bir uygulama sürümünden (${meta.app}). Önce uygulamayı güncelleyin, sonra geri yükleyin.`,
      'BACKUP_NEWER',
      { missing: [...newerModule, ...newerDrizzle] },
    )

  // 2) Mevcut verinin yedeği
  let preId: string | null = null
  if (!opts.skipPreBackup) {
    try {
      const pw = (await storedPassword(deps)) ?? password
      preId = (await createBackupUnlocked(deps, 'pre_restore', { password: pw, userId: opts.userId ?? null, verify: true })).id
    } catch (e) {
      throw new AppError(500, 'Mevcut verinin yedeği alınamadığı için geri yükleme yapılmadı: ' + (e as Error).message, 'PRE_RESTORE_FAILED')
    }
  }

  // 3) Tek transaction içinde yükle
  const client = await pool.connect()
  const newFiles: string[] = []
  const warnings: string[] = []
  let result: WalkResult
  try {
    await client.query('begin')
    const { tables, fks } = await readSchema(client)
    const backupTables = new Set(meta.tables.map((t) => t.name))
    const restoreTables = [...tables.keys()].filter((n) => backupTables.has(n) && !SKIP_RESTORE.has(n))
    const restoreSet = new Set(restoreTables)
    for (const t of meta.tables) if (!tables.has(t.name)) warnings.push(`${t.name} tablosu bu sürümde yok; atlandı`)

    if (restoreTables.length) await client.query(`truncate ${restoreTables.map((n) => 'public.' + qi(n)).join(', ')} restart identity cascade`)

    // Yabancı anahtarlar (öz-başvurulu olanlar dahil) commit öncesine ertelensin
    const altered = fks.filter((f) => !f.condeferrable)
    for (const f of altered) await client.query(`alter table public.${qi(f.child)} alter constraint ${qi(f.conname)} deferrable initially deferred`)
    await client.query('set constraints all deferred')

    let ins: { name: string; cols: string[]; enc: { col: string; hash: string | null }[]; overriding: boolean } | null = null
    let batch: string[] = []
    let batchBytes = 0
    const counts = new Map<string, number>()
    const flush = async () => {
      if (!ins || !batch.length) return
      const cols = ins.cols.map(qi).join(', ')
      await client.query(
        `insert into public.${qi(ins.name)} (${cols}) ${ins.overriding ? 'overriding system value' : ''}
         select ${cols} from jsonb_populate_recordset(null::public.${qi(ins.name)}, $1::jsonb)`,
        ['[' + batch.join(',') + ']'],
      )
      batch = []
      batchBytes = 0
    }

    result = await walk(path, password, {
      onTable(name, columns) {
        if (!restoreSet.has(name)) {
          ins = null
          return
        }
        const tm = tables.get(name)!
        const cols = columns.filter((c) => tm.insertable.has(c))
        const enc = cols
          .filter((c) => c.endsWith('_enc'))
          .map((c) => {
            const h = c.slice(0, -4) + '_hash'
            return { col: c, hash: tm.insertable.has(h) ? h : null }
          })
        for (const e of enc) if (e.hash && !cols.includes(e.hash)) cols.push(e.hash)
        const dropped = columns.filter((c) => !tm.columns.includes(c))
        if (dropped.length) warnings.push(`${name}: bu sürümde olmayan sütunlar atlandı (${dropped.join(', ')})`)
        ins = { name, cols, enc, overriding: tm.identityAlways }
      },
      async onRow(_table, text) {
        if (!ins) return
        let t = text
        if (ins.enc.length) {
          const obj = JSON.parse(text) as Record<string, unknown>
          for (const e of ins.enc) {
            const v = obj[e.col]
            if (typeof v === 'string' && v) {
              obj[e.col] = deps.crypto.encrypt(v)
              if (e.hash) obj[e.hash] = deps.crypto.hash(v)
            } else {
              obj[e.col] = null
              if (e.hash) obj[e.hash] = null
            }
          }
          t = JSON.stringify(obj)
        }
        batch.push(t)
        batchBytes += t.length
        if (batch.length >= ROW_BATCH || batchBytes >= ROW_BATCH_BYTES) await flush()
      },
      async onTableEnd(name, rows) {
        await flush()
        if (restoreSet.has(name)) counts.set(name, rows)
        ins = null
      },
      async onFile(attachmentId, data) {
        if (!restoreSet.has('attachments')) return
        const key = await writeStoredFile(deps, data)
        newFiles.push(key)
        await client.query('update attachments set storage_key = $1 where id = $2', [key, attachmentId])
      },
    })

    // Sequence'ler (ör. audit_logs.id bigserial)
    const seqs = await client.query<{ seq: string; tbl: string; col: string }>(
      `select s.relname as seq, t.relname as tbl, a.attname as col
         from pg_class s
         join pg_namespace n on n.oid = s.relnamespace
         join pg_depend d on d.objid = s.oid and d.deptype in ('a','i')
         join pg_class t on t.oid = d.refobjid
         join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
        where s.relkind = 'S' and n.nspname = 'public'`,
    )
    for (const s of seqs.rows) {
      if (!restoreSet.has(s.tbl)) continue
      await client.query(
        `select setval('public.${qi(s.seq).replace(/'/g, "''")}', coalesce((select max(${qi(s.col)}) from public.${qi(s.tbl)}), 0) + 1, false)`,
      )
    }

    // FK denetimini şimdi yap, kısıtları eski hâline getir
    await client.query('set constraints all immediate')
    for (const f of altered) await client.query(`alter table public.${qi(f.child)} alter constraint ${qi(f.conname)} not deferrable`)

    // Manifest sayımları veritabanında da tutuyor mu
    for (const [name, rows] of counts) {
      const c = await client.query(`select count(*)::int as n from public.${qi(name)}`)
      if (c.rows[0].n !== rows) throw new AppError(500, `${name} tablosunda sayım tutmuyor (${c.rows[0].n} ≠ ${rows}).`, 'RESTORE_COUNT')
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => undefined)
    for (const k of newFiles) await unlink(join(deps.filesDir, k)).catch(() => undefined)
    if (e instanceof AppError) throw e
    throw new AppError(500, 'Geri yükleme başarısız, veriler değiştirilmedi: ' + (e as Error).message, 'RESTORE_FAILED')
  } finally {
    client.release()
  }

  // 4) Artık kullanılmayan eski şifreli dosyaları temizle (geri yükleme öncesi yedekte duruyorlar)
  try {
    const used = new Set((await pool.query<{ k: string }>('select storage_key as k from attachments')).rows.map((r) => r.k))
    for (const f of await readdir(deps.filesDir).catch(() => [] as string[]))
      if (f.endsWith('.bin') && !used.has(f)) await unlink(join(deps.filesDir, f)).catch(() => undefined)
  } catch {
    /* attachments yoksa */
  }

  // 5) Bu kurulumda yedek parolası yoksa (yeni bilgisayara taşıma) geri yüklenen yedeğin parolası olsun
  if (!(await getBackupConfig(deps)).passwordSet) await setBackupPassword(deps, password, { force: true }).catch(() => undefined)

  await auditSafe(deps, {
    userId: opts.userId ?? null,
    action: 'update',
    entity: 'backup',
    entityId: preId,
    summary: `Yedekten geri yüklendi: ${basename(path)} (${meta.createdAt}, ${result.rowsTotal} satır, ${result.files} dosya)`,
  })

  return { ok: true, preRestoreBackupId: preId, tables: result.tables, rowsTotal: result.rowsTotal, files: result.files, warnings: [...warnings, ...result.trailer.warnings] }
}
