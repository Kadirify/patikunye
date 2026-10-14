// ayarlar, kullanıcılar, sözlükler, KVKK talepleri ve denetim kaydı
import type { FastifyInstance } from 'fastify'
import { hash, verify } from '@node-rs/argon2'
import { randomInt } from 'node:crypto'
import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { clinic, users } from '../../db/schema'
import { AppError, parse, requirePerm, requireUser, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { getSettings, updateSettings } from '../settings'
import { sha256 } from '../../crypto'
import { sessionsFor, username as usernameSchema } from './auth'
import type { Db } from '../../db/client'
import type { ClinicSettings } from '../../../shared/settings'
import { PETVET_TASK_KINDS, addDaysIso, todayIstanbul } from '../../../shared/petvet'
import { normalizeTrMobile, trTitleCase } from '../../../shared/identity'

import {
  ANONYMIZE_CONFIRM,
  DICT_KINDS,
  KVKK_CHANNELS,
  KVKK_DUE_DAYS,
  KVKK_REQUEST_TYPES,
  KVKK_STATUSES,
  KVKK_TEXT_KINDS,
  maskDiff,
  type AdminUserDto,
  type AnonymizePreview,
  type AuditDetailDto,
  type AuditListDto,
  type AuditRowDto,
  type AuditVerifyDto,
  type ClinicInfoDto,
  type DictItem,
  type DictKind,
  type KvkkRequestDto,
  type KvkkTextDto,
} from '../../../shared/admin'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Row = Record<string, any>

const ROLES = ['admin', 'vet', 'tech', 'secretary'] as const
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalı.')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Saat SS:dd biçiminde olmalı.')
const uuidSchema = z.string().uuid('Geçersiz kimlik.')
const optText = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .transform((v) => (v ? v : null))

async function rows<T = Row>(tx: Tx | Db, q: SQL): Promise<T[]> {
  const r = await tx.execute(q)
  return r.rows as T[]
}

/**
 * Denetim kaydı diff'i jsonb olarak saklanır; jsonb anahtarları (uzunluk, sonra bayt sırasına göre) yeniden sıralar.
 * Hash zinciri yazılan JSON metni üzerinden hesaplandığı için, F'nin yazdığı diff'ler jsonb sırasıyla verilir
 * ki geri okunduğunda doğrulama tutarlı olsun.
 */
export function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const keys = Object.keys(v as object).sort((a, b) => {
      const ba = Buffer.from(a)
      const bb = Buffer.from(b)
      return ba.length - bb.length || Buffer.compare(ba, bb)
    })
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = jsonbOrder(x)
    }
    return out
  }
  return v
}

/** Alfabetik anahtar sırası (ileride audit.ts kanonik JSON'a geçerse doğrulama bunu da dener) */
function sortedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = sortedKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** Okunaklı geçici parola (karışan karakterler yok) */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 12; i++) s += alphabet[randomInt(alphabet.length)]
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8)
}

// ---------- Şemalar ----------

const workHourSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    open: hhmm,
    close: hhmm,
    breakStart: hhmm.optional().or(z.literal('').transform(() => undefined)),
    breakEnd: hhmm.optional().or(z.literal('').transform(() => undefined)),
    closed: z.boolean().optional(),
  })
  .refine((w) => w.closed || w.open < w.close, 'Kapanış saati açılıştan sonra olmalı.')
  .refine((w) => !w.breakStart === !w.breakEnd, 'Öğle arası için başlangıç ve bitiş birlikte girilmeli.')
  .refine((w) => !w.breakStart || !w.breakEnd || (w.breakStart < w.breakEnd && w.breakStart >= w.open && w.breakEnd <= w.close), 'Öğle arası çalışma saatleri içinde olmalı.')

const settingsPatchSchema = z
  .object({
    workHours: z
      .array(workHourSchema)
      .length(7, 'Haftanın 7 günü girilmeli.')
      .refine((a) => new Set(a.map((w) => w.day)).size === 7, 'Her gün bir kez girilmeli.')
      .optional(),
    appointmentSlotMinutes: z.number().int().min(5, 'En az 5 dk.').max(120, 'En fazla 120 dk.').optional(),
    reader: z
      .object({
        mode: z.enum(['keyboard', 'serial']),
        maxGapMs: z.number().int().min(5, 'Hız eşiği en az 5 ms.').max(300, 'Hız eşiği en fazla 300 ms.'),
        serialPath: z.string().trim().max(60).optional(),
        baudRate: z.number().int().min(1200).max(921600).optional(),
        sound: z.boolean().optional(),
      })
      .optional(),
    security: z
      .object({
        lockMinutes: z.number().int().min(1, 'En az 1 dk.').max(240, 'En fazla 240 dk.'),
        showUserCards: z.boolean(),
      })
      .optional(),
    petvet: z
      .object({
        days: z.object(Object.fromEntries(PETVET_TASK_KINDS.map((k) => [k, z.number().int().min(1, 'Süre en az 1 gün.').max(365)])) as Record<
          (typeof PETVET_TASK_KINDS)[number],
          z.ZodNumber
        >),
        vaccineKinds: z.array(z.string().trim().min(1).max(40)).max(30),
        warnDaysBefore: z.number().int().min(0).max(60),
        requireEvidence: z.boolean(),
        tarbilUrl: z.string().trim().url('Geçerli bir adres girin (https://...).').refine((u) => u.startsWith('https://'), 'Adres https:// ile başlamalı.').optional(),
      })
      .optional(),
  })
  .strict()

const clinicSchema = z.object({
  name: z.string().trim().min(2, 'Klinik adı gerekli.').max(120),
  city: z.string().trim().min(2, 'İl gerekli.').max(60),
  district: z.string().trim().min(2, 'İlçe gerekli.').max(60),
  phone: optText,
  address: z
    .string()
    .trim()
    .max(400)
    .nullish()
    .transform((v) => (v ? v : null)),
})

const phoneOpt = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null
    const n = normalizeTrMobile(v)
    if (!n) ctx.addIssue({ code: 'custom', message: 'Telefon geçersiz (5XX XXX XX XX).' })
    return n
  })
const emailOpt = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'E-posta geçersiz.')

const userBase = {
  fullName: z.string().trim().min(3, 'Ad soyad gerekli.').max(80),
  role: z.enum(ROLES, 'Rol seçin.'),
  chamberRegNo: optText,
  diplomaNo: optText,
  email: emailOpt,
  phone: phoneOpt,
  pinAllowed: z.boolean().optional(),
}
const vetNeedsReg = (u: { role?: string; chamberRegNo?: string | null }) => u.role !== 'vet' || !!u.chamberRegNo
const createUserSchema = z.object({ ...userBase, username: usernameSchema }).refine(vetNeedsReg, { message: 'Hekim için oda sicil no gerekli.', path: ['chamberRegNo'] })
const updateUserSchema = z.object({ ...userBase, active: z.boolean().optional() }).partial()

const dictKindSchema = z.enum(DICT_KINDS, 'Bilinmeyen sözlük türü.')
const dictItemSchema = z.object({
  species: z.string().trim().max(20).nullish(),
  value: z.string().trim().min(1, 'Değer gerekli.').max(80, 'En fazla 80 karakter.'),
  sort: z.number().int().min(0).max(100000).optional(),
})
const dictPatchSchema = z.object({
  value: z.string().trim().min(1, 'Değer gerekli.').max(80).optional(),
  sort: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
})

const kvkkTextSchema = z.object({ kind: z.enum(KVKK_TEXT_KINDS), body: z.string().trim().min(20, 'Metin çok kısa.').max(50000) })
const kvkkRequestSchema = z.object({
  ownerId: uuidSchema,
  type: z.enum(KVKK_REQUEST_TYPES, 'Talep türü seçin.'),
  receivedAt: isoDate,
  channel: z.enum(KVKK_CHANNELS, 'Başvuru yolu seçin.'),
  note: z.string().trim().max(2000).optional(),
})
const kvkkPatchSchema = z.object({
  status: z.enum(KVKK_STATUSES).optional(),
  responseNote: z.string().trim().max(4000).nullish(),
})
const anonymizeSchema = z.object({
  confirm: z.string(),
  password: z.string().min(1, 'Yönetici parolası gerekli.').max(200),
  requestId: uuidSchema.optional(),
})

// ---------- Yardımcılar ----------

const toAdminUser = (r: Row): AdminUserDto => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  role: r.role,
  chamberRegNo: r.chamber_reg_no,
  diplomaNo: r.diploma_no,
  email: r.email,
  phone: r.phone,
  active: r.active,
  pinAllowed: r.pin_allowed,
  pinSet: !!r.pin_set,
  mustChangePassword: r.must_change_password,
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
})
const USER_COLS = sql.raw(
  `id, username, full_name, role, chamber_reg_no, diploma_no, email, phone, active, pin_allowed, (pin_hash is not null) as pin_set,
   must_change_password, last_login_at, created_at`,
)

const toDict = (r: Row): DictItem => ({ id: r.id, kind: r.kind, species: r.species, value: r.value, sort: r.sort, active: r.active })

/** Basit CSV ayrıştırıcı (tırnaklı alanlar, virgül veya noktalı virgül) */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((x) => x.trim() !== '')) out.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim() !== '')) out.push(row)
  return out
}
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function tableColumns(tx: Tx | Db, table: string): Promise<Set<string>> {
  const r = await rows<{ column_name: string }>(tx, sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`)
  return new Set(r.map((x) => x.column_name))
}

/** Sahibe/hayvanlara bağlı diğer modül tabloları (owner_id / animal_id sütunu olanlar) */
async function linkedTables(tx: Tx | Db, column: 'owner_id' | 'animal_id'): Promise<string[]> {
  const r = await rows<{ table_name: string }>(
    tx,
    sql`select c.table_name from information_schema.columns c join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.column_name = ${column} order by c.table_name`,
  )
  return r.map((x) => x.table_name)
}

const SECRET_COL = /(_enc|_hash|password|pin_hash|secret|token|storage_key)$/

function stripSecrets(r: Row): Row {
  const o: Row = {}
  for (const [k, v] of Object.entries(r)) if (!SECRET_COL.test(k)) o[k] = v
  return o
}

/** Anonimleştirmede temizlenen sahip alanları (yalnızca tabloda bulunanlar uygulanır) */
const ANON_CLEAR: { col: string; label: string; value: string }[] = [
  { col: 'tckn_enc', label: 'TCKN', value: 'null' },
  { col: 'tckn_hash', label: 'TCKN (arama özeti)', value: 'null' },
  { col: 'tckn_last4', label: 'TCKN son 4 hane', value: 'null' },
  { col: 'foreign_doc_enc', label: 'Pasaport / yabancı kimlik no', value: 'null' },
  { col: 'foreign_doc_last4', label: 'Pasaport son 4 hane', value: 'null' },
  { col: 'birth_date', label: 'Doğum tarihi', value: 'null' },
  { col: 'phone', label: 'Cep telefonu', value: 'null' },
  { col: 'phone2', label: 'İkinci telefon', value: 'null' },
  { col: 'email', label: 'E-posta', value: 'null' },
  { col: 'address', label: 'Adres', value: 'null' },
  { col: 'emergency_name', label: 'Acil durum kişisi', value: 'null' },
  { col: 'emergency_phone', label: 'Acil durum telefonu', value: 'null' },
  { col: 'notes', label: 'Notlar', value: 'null' },
  { col: 'tags', label: 'Etiketler', value: `'{}'::text[]` },
  { col: 'marketing_consent_at', label: 'Ticari ileti izni', value: 'null' },
  { col: 'reminder_consent', label: 'Hatırlatma izni', value: 'false' },
]

function anonName(ownerId: string) {
  return { first: 'Anonim', last: `Sahip #${ownerId.replace(/-/g, '').slice(0, 4).toUpperCase()}` }
}

// ---------- Rotalar ----------

export function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const today = () => deps.today?.() ?? todayIstanbul()

  // ===== Klinik ve genel ayarlar =====

  app.get('/api/admin/settings', async (req) => {
    requireUser(req)
    return getSettings(db)
  })

  app.patch('/api/admin/settings', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const body = parse(settingsPatchSchema, req.body)
    return db.transaction(async (tx) => {
      const before = await getSettings(tx)
      const patch: Partial<ClinicSettings> = {}
      const diff: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue
        const key = k as keyof ClinicSettings
        const merged = Array.isArray(v) || typeof v !== 'object' ? v : { ...(before[key] as object), ...(v as object) }
        ;(patch as Record<string, unknown>)[key] = merged
        diff[key] = { from: before[key], to: merged }
      }
      if (Object.keys(patch).length === 0) throw new AppError(400, 'Değişiklik yok.', 'NO_CHANGE')
      const next = await updateSettings(tx, patch)
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'settings',
        summary: `Ayar değişikliği: ${Object.keys(patch).join(', ')}`,
        diff: jsonbOrder(diff),
      })
      return next
    })
  })

  app.get('/api/admin/clinic', async (req) => {
    requireUser(req)
    const [c] = await db.select().from(clinic).limit(1)
    if (!c) throw new AppError(404, 'Klinik kaydı yok.', 'NOT_FOUND')
    return { name: c.name, city: c.city, district: c.district, phone: c.phone, address: c.address } satisfies ClinicInfoDto
  })

  app.put('/api/admin/clinic', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const body = parse(clinicSchema, req.body)
    return db.transaction(async (tx) => {
      const [c] = await tx.select().from(clinic).limit(1)
      if (!c) throw new AppError(404, 'Klinik kaydı yok.', 'NOT_FOUND')
      await tx.update(clinic).set(body).where(eq(clinic.id, c.id))
      const diff: Record<string, unknown> = {}
      for (const k of Object.keys(body) as (keyof typeof body)[]) if ((c as Row)[k] !== body[k]) diff[k] = { from: (c as Row)[k], to: body[k] }
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'clinic', entityId: c.id, summary: 'Klinik bilgileri', diff: jsonbOrder(diff) })
      return body satisfies ClinicInfoDto
    })
  })

  // ===== Kullanıcılar =====

  app.get('/api/admin/users', async (req) => {
    requirePerm(req, 'users.manage')
    const r = await rows(db, sql`select ${USER_COLS} from users order by active desc, full_name`)
    return r.map(toAdminUser)
  })

  app.post('/api/admin/users', async (req) => {
    const u = requirePerm(req, 'users.manage')
    const body = parse(createUserSchema, req.body)
    const temp = tempPassword()
    const pwHash = await hash(temp)
    const created = await db.transaction(async (tx) => {
      const [dup] = await rows(tx, sql`select id from users where username = ${body.username}`)
      if (dup) throw new AppError(409, 'Bu kullanıcı adı kullanılıyor.', 'DUPLICATE_USERNAME', [{ path: ['username'], message: 'Bu kullanıcı adı kullanılıyor.' }])
      const [r] = await rows(
        tx,
        sql`insert into users (username, full_name, role, password_hash, chamber_reg_no, diploma_no, email, phone, pin_allowed, must_change_password)
            values (${body.username}, ${trTitleCase(body.fullName)}, ${body.role}, ${pwHash}, ${body.chamberRegNo}, ${body.diplomaNo},
                    ${body.email}, ${body.phone}, ${body.pinAllowed ?? false}, true)
            returning ${USER_COLS}`,
      )
      await writeAudit(tx, {
        userId: u.id,
        action: 'create',
        entity: 'user',
        entityId: r.id,
        summary: `Kullanıcı: ${r.full_name} (${body.role})`,
      })
      return r
    })
    return { user: toAdminUser(created), tempPassword: temp }
  })

  /** Son etkin yöneticiyi kaybetmemek için kontrol (çağıran işlem içinde kilitli) */
  async function assertNotLastAdmin(tx: Tx, userId: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(7240070)`)
    const [r] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from users where role = 'admin' and active and id <> ${userId}`)
    if (r.n === 0) throw new AppError(409, 'Son klinik yöneticisi devre dışı bırakılamaz ya da rolü değiştirilemez. Önce başka bir yönetici ekleyin.', 'LAST_ADMIN')
  }

  app.patch('/api/admin/users/:id', async (req) => {
    const u = requirePerm(req, 'users.manage')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const body = parse(updateUserSchema, req.body)
    const result = await db.transaction(async (tx) => {
      const [cur] = await rows(tx, sql`select ${USER_COLS} from users where id = ${id} for update`)
      if (!cur) throw new AppError(404, 'Kullanıcı bulunamadı.', 'NOT_FOUND')
      const next = {
        full_name: body.fullName !== undefined ? trTitleCase(body.fullName) : cur.full_name,
        role: body.role ?? cur.role,
        chamber_reg_no: body.chamberRegNo !== undefined ? body.chamberRegNo : cur.chamber_reg_no,
        diploma_no: body.diplomaNo !== undefined ? body.diplomaNo : cur.diploma_no,
        email: body.email !== undefined ? body.email : cur.email,
        phone: body.phone !== undefined ? body.phone : cur.phone,
        pin_allowed: body.pinAllowed ?? cur.pin_allowed,
        active: body.active ?? cur.active,
      }
      if (next.role === 'vet' && !next.chamber_reg_no) {
        throw new AppError(400, 'Hekim için oda sicil no gerekli.', 'VALIDATION', [{ path: ['chamberRegNo'], message: 'Hekim için oda sicil no gerekli.' }])
      }
      if (id === u.id && !next.active) throw new AppError(409, 'Kendi hesabınızı devre dışı bırakamazsınız.', 'SELF_DISABLE')
      const losesAdmin = cur.role === 'admin' && cur.active && (next.role !== 'admin' || !next.active)
      if (losesAdmin) await assertNotLastAdmin(tx, id)
      await tx.execute(sql`update users set full_name = ${next.full_name}, role = ${next.role}, chamber_reg_no = ${next.chamber_reg_no},
          diploma_no = ${next.diploma_no}, email = ${next.email}, phone = ${next.phone}, pin_allowed = ${next.pin_allowed}, active = ${next.active}
          where id = ${id}`)
      const diff: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(next)) if (cur[k] !== v) diff[k] = { from: cur[k], to: v }
      const summary = !next.active && cur.active ? `Devre dışı: ${cur.full_name}` : next.active && !cur.active ? `Yeniden etkin: ${cur.full_name}` : `Kullanıcı güncellendi: ${next.full_name}`
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'user', entityId: id, summary, diff: jsonbOrder(diff) })
      const [after] = await rows(tx, sql`select ${USER_COLS} from users where id = ${id}`)
      return { after, roleChanged: cur.role !== next.role, deactivated: cur.active && !next.active, nameChanged: cur.full_name !== next.full_name }
    })
    // Oturum rolü/adı önbellekte tutulduğu için değişiklikte oturumlar kapatılır
    if (result.roleChanged || result.deactivated || result.nameChanged) sessionsFor(app)?.revokeUser(id)
    return toAdminUser(result.after)
  })

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const u = requirePerm(req, 'users.manage')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const temp = tempPassword()
    const pwHash = await hash(temp)
    await db.transaction(async (tx) => {
      const [cur] = await rows(tx, sql`select id, full_name from users where id = ${id}`)
      if (!cur) throw new AppError(404, 'Kullanıcı bulunamadı.', 'NOT_FOUND')
      await tx.execute(sql`update users set password_hash = ${pwHash}, must_change_password = true, pin_hash = null where id = ${id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'user', entityId: id, summary: `Parola sıfırlandı (geçici parola): ${cur.full_name}` })
    })
    sessionsFor(app)?.revokeUser(id)
    return { tempPassword: temp }
  })

  app.post('/api/admin/users/:id/revoke-sessions', async (req) => {
    const u = requirePerm(req, 'users.manage')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    const n = sessionsFor(app)?.revokeUser(id, id === u.id ? token : undefined) ?? 0
    await writeAudit(db, { userId: u.id, action: 'update', entity: 'user', entityId: id, summary: `Oturumlar kapatıldı (${n})` })
    return { closed: n }
  })

  // ===== Sözlükler =====

  app.get('/api/dictionaries/:kind', async (req) => {
    requireUser(req)
    const kind = parse(dictKindSchema, (req.params as { kind: string }).kind)
    const q = req.query as { species?: string; all?: string }
    const all = q.all === '1' || q.all === 'true'
    const species = q.species?.trim() || null
    const r = await rows(
      db,
      sql`select id, kind, species, value, sort, active from dictionaries
          where kind = ${kind}
            and (${species}::text is null or species = ${species} or species is null)
            and (${all} or active)
          order by species nulls first, sort, value`,
    )
    return r.map(toDict)
  })

  app.post('/api/dictionaries/:kind', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const kind = parse(dictKindSchema, (req.params as { kind: string }).kind)
    const body = parse(dictItemSchema, req.body)
    const species = kind === 'breed' ? body.species || null : null
    if (kind === 'breed' && !species) throw new AppError(400, 'Irk için tür seçin.', 'VALIDATION', [{ path: ['species'], message: 'Tür seçin.' }])
    return db.transaction(async (tx) => {
      const [dup] = await rows(tx, sql`select id from dictionaries where kind = ${kind} and coalesce(species,'') = ${species ?? ''} and lower(value) = lower(${body.value})`)
      if (dup) throw new AppError(409, 'Bu değer zaten listede.', 'DUPLICATE', [{ path: ['value'], message: 'Bu değer zaten listede.' }])
      const [r] = await rows(
        tx,
        sql`insert into dictionaries (kind, species, value, sort)
            values (${kind}, ${species}, ${body.value},
              coalesce(${body.sort ?? null}::int, (select coalesce(max(sort),0)+1 from dictionaries where kind = ${kind} and coalesce(species,'') = ${species ?? ''})))
            returning id, kind, species, value, sort, active`,
      )
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'dictionary', entityId: r.id, summary: `${kind}: ${body.value}` })
      return toDict(r)
    })
  })

  app.patch('/api/dictionaries/item/:id', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const body = parse(dictPatchSchema, req.body)
    return db.transaction(async (tx) => {
      const [cur] = await rows(tx, sql`select id, kind, species, value, sort, active from dictionaries where id = ${id}`)
      if (!cur) throw new AppError(404, 'Kayıt bulunamadı.', 'NOT_FOUND')
      if (body.value && body.value.toLowerCase() !== String(cur.value).toLowerCase()) {
        const [dup] = await rows(
          tx,
          sql`select id from dictionaries where kind = ${cur.kind} and coalesce(species,'') = ${cur.species ?? ''} and lower(value) = lower(${body.value}) and id <> ${id}`,
        )
        if (dup) throw new AppError(409, 'Bu değer zaten listede.', 'DUPLICATE')
      }
      const [r] = await rows(
        tx,
        sql`update dictionaries set value = ${body.value ?? cur.value}, sort = ${body.sort ?? cur.sort}, active = ${body.active ?? cur.active}
            where id = ${id} returning id, kind, species, value, sort, active`,
      )
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'dictionary', entityId: id, summary: `${cur.kind}: ${r.value}${r.active ? '' : ' (pasif)'}` })
      return toDict(r)
    })
  })

  app.get('/api/dictionaries/:kind/csv', async (req, reply) => {
    requirePerm(req, 'settings.manage')
    const kind = parse(dictKindSchema, (req.params as { kind: string }).kind)
    const r = await rows(db, sql`select species, value, sort, active from dictionaries where kind = ${kind} order by species nulls first, sort, value`)
    const lines = ['tur,deger,sira,aktif', ...r.map((x) => [x.species ?? '', x.value, x.sort, x.active ? '1' : '0'].map(csvCell).join(','))]
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="sozluk-${kind}.csv"`)
    return '﻿' + lines.join('\r\n') + '\r\n'
  })

  app.post('/api/dictionaries/:kind/import', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const kind = parse(dictKindSchema, (req.params as { kind: string }).kind) as DictKind
    const body = parse(z.object({ csv: z.string().min(1, 'Dosya boş.').max(500_000, 'Dosya çok büyük.') }), req.body)
    const table = parseCsv(body.csv)
    if (table.length && /^(tur|tür|species)$/i.test(table[0][0]?.trim() ?? '')) table.shift()
    const errors: { line: number; message: string }[] = []
    const items: { species: string | null; value: string; sort: number | null; active: boolean }[] = []
    table.forEach((cols, i) => {
      const line = i + 2
      // Tek sütunlu dosya: yalnızca değer
      const [a, b, c, d] = cols.length === 1 ? ['', cols[0], '', ''] : cols
      const species = kind === 'breed' ? (a ?? '').trim() || null : null
      const value = (b ?? '').trim()
      if (!value) return errors.push({ line, message: 'Değer boş.' })
      if (value.length > 80) return errors.push({ line, message: 'Değer 80 karakterden uzun.' })
      if (kind === 'breed' && !species) return errors.push({ line, message: 'Irk için tür (cat, dog...) gerekli.' })
      const sort = c?.trim() ? Number(c) : null
      if (sort !== null && !Number.isInteger(sort)) return errors.push({ line, message: 'Sıra sayı olmalı.' })
      items.push({ species, value, sort, active: !/^(0|hayır|hayir|false|pasif)$/i.test((d ?? '').trim()) })
    })
    if (errors.length) throw new AppError(400, `CSV'de ${errors.length} hatalı satır var. İlk hata: satır ${errors[0].line} - ${errors[0].message}`, 'CSV_INVALID', errors)
    return db.transaction(async (tx) => {
      let added = 0
      let updated = 0
      for (const it of items) {
        const [r] = await rows<{ inserted: boolean }>(
          tx,
          sql`insert into dictionaries (kind, species, value, sort, active) values (${kind}, ${it.species}, ${it.value}, coalesce(${it.sort}::int, 0), ${it.active})
              on conflict (kind, coalesce(species, ''), lower(value))
              do update set sort = coalesce(${it.sort}::int, dictionaries.sort), active = excluded.active
              returning (xmax = 0) as inserted`,
        )
        if (r.inserted) added++
        else updated++
      }
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'dictionary', summary: `${kind} CSV içe aktarma: ${added} yeni, ${updated} güncellendi` })
      return { added, updated }
    })
  })

  // ===== KVKK metinleri =====

  app.get('/api/kvkk/texts', async (req) => {
    requireUser(req)
    const q = req.query as { history?: string }
    const history = q.history === '1'
    const r = await rows(
      db,
      history
        ? sql`select t.*, u.full_name as created_by_name from kvkk_texts t left join users u on u.id = t.created_by order by t.kind, t.version desc`
        : sql`select distinct on (t.kind) t.*, u.full_name as created_by_name from kvkk_texts t left join users u on u.id = t.created_by order by t.kind, t.version desc`,
    )
    return r.map(
      (x): KvkkTextDto => ({
        id: x.id,
        kind: x.kind,
        version: x.version,
        body: x.body,
        publishedAt: new Date(x.published_at).toISOString(),
        createdByName: x.created_by_name,
      }),
    )
  })

  app.post('/api/kvkk/texts', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const body = parse(kvkkTextSchema, req.body)
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7240071)`)
      const [last] = await rows(tx, sql`select version, body from kvkk_texts where kind = ${body.kind} order by version desc limit 1`)
      if (last && last.body === body.body) throw new AppError(400, 'Metin değişmedi.', 'NO_CHANGE')
      const version = (last?.version ?? 0) + 1
      const [r] = await rows(tx, sql`insert into kvkk_texts (kind, version, body, created_by) values (${body.kind}, ${version}, ${body.body}, ${u.id}) returning id`)
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'kvkk_text', entityId: r.id, summary: `${body.kind} sürüm ${version} yayımlandı` })
      return { id: r.id, version }
    })
  })

  // ===== KVKK talepleri =====

  const REQ_SELECT = sql`select r.*, o.first_name || ' ' || o.last_name as owner_name, (o.anonymized_at is not null) as owner_anonymized
                         from kvkk_requests r join owners o on o.id = r.owner_id`
  const toReq = (x: Row): KvkkRequestDto => {
    const t = today()
    const [y1, m1, d1] = t.split('-').map(Number)
    const [y2, m2, d2] = String(x.due_date).split('-').map(Number)
    return {
      id: x.id,
      ownerId: x.owner_id,
      ownerName: x.owner_name,
      ownerAnonymized: x.owner_anonymized,
      type: x.type,
      receivedAt: x.received_at,
      channel: x.channel,
      status: x.status,
      dueDate: x.due_date,
      daysLeft: Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000),
      note: x.note,
      responseNote: x.response_note,
      closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null,
      createdAt: new Date(x.created_at).toISOString(),
    }
  }

  app.get('/api/kvkk/requests', async (req) => {
    requirePerm(req, 'kvkk.requests')
    const q = req.query as { status?: string; ownerId?: string }
    const status = q.status && (KVKK_STATUSES as readonly string[]).includes(q.status) ? q.status : null
    const ownerId = q.ownerId && z.string().uuid().safeParse(q.ownerId).success ? q.ownerId : null
    const r = await rows(
      db,
      sql`${REQ_SELECT} where (${status}::text is null or r.status = ${status}) and (${ownerId}::uuid is null or r.owner_id = ${ownerId}::uuid)
          order by (r.status = 'open') desc, r.due_date, r.created_at desc limit 500`,
    )
    return r.map(toReq)
  })

  app.get('/api/kvkk/requests/:id', async (req) => {
    requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const [r] = await rows(db, sql`${REQ_SELECT} where r.id = ${id}`)
    if (!r) throw new AppError(404, 'Talep bulunamadı.', 'NOT_FOUND')
    return toReq(r)
  })

  app.post('/api/kvkk/requests', async (req) => {
    const u = requirePerm(req, 'kvkk.requests')
    const body = parse(kvkkRequestSchema, req.body)
    if (body.receivedAt > today()) throw new AppError(400, 'Başvuru tarihi gelecekte olamaz.', 'VALIDATION', [{ path: ['receivedAt'], message: 'Başvuru tarihi gelecekte olamaz.' }])
    return db.transaction(async (tx) => {
      const [o] = await rows(tx, sql`select id from owners where id = ${body.ownerId} and deleted_at is null`)
      if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
      const due = addDaysIso(body.receivedAt, KVKK_DUE_DAYS)
      const [r] = await rows(
        tx,
        sql`insert into kvkk_requests (owner_id, type, received_at, channel, due_date, note, created_by)
            values (${body.ownerId}, ${body.type}, ${body.receivedAt}, ${body.channel}, ${due}, ${body.note || null}, ${u.id}) returning id`,
      )
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'kvkk_request', entityId: r.id, summary: `KVKK talebi (${body.type}), son gün ${due}` })
      const [full] = await rows(tx, sql`${REQ_SELECT} where r.id = ${r.id}`)
      return toReq(full)
    })
  })

  app.patch('/api/kvkk/requests/:id', async (req) => {
    const u = requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const body = parse(kvkkPatchSchema, req.body)
    return db.transaction(async (tx) => {
      const [cur] = await rows(tx, sql`select * from kvkk_requests where id = ${id} for update`)
      if (!cur) throw new AppError(404, 'Talep bulunamadı.', 'NOT_FOUND')
      const status = body.status ?? cur.status
      const note = body.responseNote !== undefined ? body.responseNote || null : cur.response_note
      if (status !== 'open' && !note) throw new AppError(400, 'Talebi kapatmak için yanıt notu yazın.', 'VALIDATION', [{ path: ['responseNote'], message: 'Yanıt notu gerekli.' }])
      const closing = status !== 'open' && cur.status === 'open'
      const reopening = status === 'open' && cur.status !== 'open'
      await tx.execute(sql`update kvkk_requests set status = ${status}, response_note = ${note},
          closed_at = case when ${closing} then now() when ${reopening} then null else closed_at end,
          closed_by = case when ${closing} then ${u.id}::uuid when ${reopening} then null else closed_by end
          where id = ${id}`)
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'kvkk_request',
        entityId: id,
        summary: closing ? `Talep kapatıldı (${status})` : reopening ? 'Talep yeniden açıldı' : 'Talep güncellendi',
      })
      const [full] = await rows(tx, sql`${REQ_SELECT} where r.id = ${id}`)
      return toReq(full)
    })
  })

  app.get('/api/kvkk/owners', async (req) => {
    requirePerm(req, 'kvkk.requests')
    const q = String((req.query as { q?: string }).q ?? '').trim()
    if (q.length < 2) return []
    const digits = q.replace(/\D/g, '')
    const r = await rows(
      db,
      sql`select id, first_name || ' ' || last_name as name, phone, tckn_last4, (anonymized_at is not null) as anonymized from owners
          where deleted_at is null and (pk_norm(first_name || ' ' || last_name) like '%' || pk_norm(${q}) || '%'
            or (${digits.length >= 4} and (phone like '%' || ${digits} || '%' or tckn_last4 = ${digits.slice(-4)})))
          order by first_name, last_name limit 20`,
    )
    return r.map((x) => ({ id: x.id, name: x.name, phoneLast4: x.phone ? String(x.phone).slice(-4) : null, tcknLast4: x.tckn_last4, anonymized: x.anonymized }))
  })

  app.get('/api/kvkk/owners/:id', async (req) => {
    requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const [o] = await rows(db, sql`select id, first_name || ' ' || last_name as name, (anonymized_at is not null) as anonymized from owners where id = ${id}`)
    if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
    return o
  })

  /** Veri kopyası: sahibe ait kişisel veriler + hayvan kayıtları (JSON) */
  app.get('/api/kvkk/owners/:id/export', async (req) => {
    const u = requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const requestId = (req.query as { requestId?: string }).requestId
    const [o] = await rows(db, sql`select * from owners where id = ${id}`)
    if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
    const owner = stripSecrets(o)
    if (o.tckn_enc) owner.tckn = deps.crypto.decrypt(o.tckn_enc)
    if (o.foreign_doc_enc) owner.foreignDocNo = deps.crypto.decrypt(o.foreign_doc_enc)

    const animalIds = (await rows<{ animal_id: string }>(db, sql`select distinct animal_id from animal_owners where owner_id = ${id}`)).map((x) => x.animal_id)
    const animals = animalIds.length
      ? (await rows(db, sql`select a.*, ao.is_primary, ao.from_date, ao.to_date from animals a join animal_owners ao on ao.animal_id = a.id and ao.owner_id = ${id}
                             order by a.created_at`)).map(stripSecrets)
      : []
    const related: Record<string, Row[]> = {}
    const skip = new Set(['animal_owners', 'audit_logs'])
    for (const t of await linkedTables(db, 'owner_id')) {
      if (skip.has(t) || t === 'owners') continue
      const r = await db.$client.query(`select * from "${t}" where owner_id = $1`, [id])
      if (r.rows.length) related[t] = r.rows.map(stripSecrets)
    }
    if (animalIds.length) {
      for (const t of await linkedTables(db, 'animal_id')) {
        if (skip.has(t) || related[t]) continue
        const r = await db.$client.query(`select * from "${t}" where animal_id = any($1::uuid[])`, [animalIds])
        if (r.rows.length) related[t] = r.rows.map(stripSecrets)
      }
      const ev = await db.$client.query(
        `select e.* from chip_events e join microchips m on m.id = e.microchip_id where m.animal_id = any($1::uuid[])`,
        [animalIds],
      )
      if (ev.rows.length) related.chip_events = ev.rows
    }
    await writeAudit(db, {
      userId: u.id,
      action: 'export',
      entity: 'owner',
      entityId: id,
      summary: `KVKK veri kopyası${requestId ? ` (talep ${requestId})` : ''}: ${animals.length} hayvan`,
    })
    const [c] = await db.select({ name: clinic.name }).from(clinic).limit(1)
    return {
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      dataController: c?.name ?? '',
      note: 'KVKK m.11 kapsaminda veri kopyasi. Yanit yazisi ile birlikte ilgili kisiye verilmelidir.',
      owner,
      animals,
      related,
    }
  })

  async function buildPreview(tx: Tx | Db, id: string): Promise<AnonymizePreview> {
    const [o] = await rows(tx, sql`select * from owners where id = ${id}`)
    if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
    const cols = await tableColumns(tx, 'owners')
    const clearedFields = ANON_CLEAR.filter((f) => cols.has(f.col) && !f.col.endsWith('_hash')).map((f) => ({
      field: f.col,
      label: f.label,
      hasValue: Array.isArray(o[f.col]) ? o[f.col].length > 0 : f.col === 'reminder_consent' ? o[f.col] === true : o[f.col] !== null && o[f.col] !== '',
    }))
    const count = async (q: SQL) => (await rows<{ n: number }>(tx, q))[0]?.n ?? 0
    const kept: AnonymizePreview['kept'] = []
    const legal = 'Yasal yukumluluk (evcil hayvan kayit ve asi mevzuati)'
    kept.push({ label: 'Hayvan kayıtları', count: await count(sql`select count(distinct animal_id)::int as n from animal_owners where owner_id = ${id}`), reason: legal })
    kept.push({
      label: 'Mikroçip kayıtları',
      count: await count(sql`select count(*)::int as n from microchips m join animal_owners ao on ao.animal_id = m.animal_id where ao.owner_id = ${id}`),
      reason: legal,
    })
    for (const [table, label] of [
      ['vaccinations', 'Aşı kayıtları'],
      ['visits', 'Muayene kayıtları'],
    ] as const) {
      const cs = await tableColumns(tx, table)
      if (cs.has('animal_id')) {
        kept.push({
          label,
          count: await count(sql`select count(*)::int as n from ${sql.identifier(table)} x join animal_owners ao on ao.animal_id = x.animal_id where ao.owner_id = ${id}`),
          reason: legal,
        })
      }
    }
    kept.push({ label: 'PETVET görevleri', count: await count(sql`select count(*)::int as n from petvet_tasks where owner_id = ${id}`), reason: legal })
    const consentCols = await tableColumns(tx, 'consents')
    if (consentCols.has('owner_id')) {
      kept.push({ label: 'Rıza geçmişi (anonim kimliğe bağlı)', count: await count(sql`select count(*)::int as n from consents where owner_id = ${id}`), reason: 'İspat yükümlülüğü' })
    }
    kept.push({
      label: 'Sahibe ait belgeler (elle gözden geçirin)',
      count: await count(sql`select count(*)::int as n from attachments where owner_type = 'owner' and owner_id = ${id} and deleted_at is null`),
      reason: 'Belgeler otomatik silinmez',
    })
    const an = anonName(id)
    return {
      ownerId: id,
      currentName: `${o.first_name} ${o.last_name}`,
      anonymName: `${an.first} ${an.last}`,
      alreadyAnonymized: !!o.anonymized_at,
      clearedFields,
      kept,
    }
  }

  app.get('/api/kvkk/owners/:id/anonymize-preview', async (req) => {
    requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    return buildPreview(db, id)
  })

  app.post('/api/kvkk/owners/:id/anonymize', async (req) => {
    const u = requirePerm(req, 'kvkk.requests')
    const id = parse(uuidSchema, (req.params as { id: string }).id)
    const body = parse(anonymizeSchema, req.body)
    if (body.confirm.trim().toLocaleUpperCase('tr-TR') !== ANONYMIZE_CONFIRM) {
      throw new AppError(400, `Onay için "${ANONYMIZE_CONFIRM}" yazın.`, 'CONFIRM_REQUIRED', [{ path: ['confirm'], message: `"${ANONYMIZE_CONFIRM}" yazın.` }])
    }
    const [me] = await db.select().from(users).where(eq(users.id, u.id)).limit(1)
    if (!me || me.role !== 'admin' || !(await verify(me.passwordHash, body.password))) {
      await writeAudit(db, { userId: u.id, action: 'login_failed', entity: 'user', entityId: u.id, summary: 'Anonimleştirme onayında hatalı yönetici parolası' })
      throw new AppError(403, 'Yönetici parolası hatalı.', 'BAD_PASSWORD', [{ path: ['password'], message: 'Yönetici parolası hatalı.' }])
    }
    return db.transaction(async (tx) => {
      const [o] = await rows(tx, sql`select id, anonymized_at from owners where id = ${id} for update`)
      if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
      if (o.anonymized_at) throw new AppError(409, 'Bu sahip zaten anonimleştirilmiş.', 'ALREADY_ANONYMIZED')
      const preview = await buildPreview(tx, id)
      const cols = await tableColumns(tx, 'owners')
      const an = anonName(id)
      // Sütun adları ve sabit değerler ANON_CLEAR listesinden gelir (kullanıcı girdisi değil)
      const sets: SQL[] = [sql`first_name = ${an.first}`, sql`last_name = ${an.last}`, sql`anonymized_at = now()`]
      for (const f of ANON_CLEAR) if (cols.has(f.col)) sets.push(sql`${sql.identifier(f.col)} = ${sql.raw(f.value)}`)
      if (cols.has('version')) sets.push(sql`version = version + 1`)
      if (cols.has('updated_at')) sets.push(sql`updated_at = now()`)
      if (cols.has('updated_by')) sets.push(sql`updated_by = ${u.id}`)
      await tx.execute(sql`update owners set ${sql.join(sets, sql`, `)} where id = ${id}`)
      // Hatırlatma izni kaldırıldı; rıza geçmişine kayıt düş
      const consentCols = await tableColumns(tx, 'consents')
      if (consentCols.has('owner_id')) {
        await tx.execute(sql`insert into consents (owner_id, type, granted, channel, user_id) values (${id}, 'reminder', false, 'system', ${u.id}),
                                                                                        (${id}, 'marketing', false, 'system', ${u.id})`)
      }
      if (body.requestId) {
        await tx.execute(sql`update kvkk_requests set status = 'done', closed_at = now(), closed_by = ${u.id},
                             response_note = coalesce(response_note, 'Kişisel veriler anonimleştirildi.')
                             where id = ${body.requestId} and owner_id = ${id} and status = 'open'`)
      }
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'owner',
        entityId: id,
        summary: `KVKK anonimleştirme (geri alınamaz) -> ${an.first} ${an.last}`,
        diff: jsonbOrder({ anonymized: true, clearedFields: preview.clearedFields.filter((f) => f.hasValue).map((f) => f.field), requestId: body.requestId ?? null }),
      })
      return { ok: true, anonymName: `${an.first} ${an.last}` }
    })
  })

  // ===== Denetim kaydı =====

  app.get('/api/audit', async (req) => {
    requirePerm(req, 'audit.view')
    const q = req.query as Record<string, string | undefined>
    const pageSize = 50
    const page = Math.max(1, Number(q.page) || 1)
    const userId = q.userId && z.string().uuid().safeParse(q.userId).success ? q.userId : null
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : null
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : null
    const action = q.action?.trim() || null
    const entity = q.entity?.trim() || null
    const entityId = q.entityId?.trim() || null
    const where = sql`(${userId}::uuid is null or a.user_id = ${userId}::uuid)
      and (${from}::date is null or a.created_at >= (${from}::date)::timestamp at time zone 'Europe/Istanbul')
      and (${to}::date is null or a.created_at < (${to}::date + 1)::timestamp at time zone 'Europe/Istanbul')
      and (${action}::text is null or a.action = ${action})
      and (${entity}::text is null or a.entity = ${entity})
      and (${entityId}::text is null or a.entity_id = ${entityId})`
    const [{ n }] = await rows<{ n: number }>(db, sql`select count(*)::int as n from audit_logs a where ${where}`)
    const r = await rows(
      db,
      sql`select a.id, a.created_at as at, a.user_id, u.full_name as user_name, a.action, a.entity, a.entity_id, a.summary
          from audit_logs a left join users u on u.id = a.user_id where ${where}
          order by a.id desc limit ${pageSize} offset ${(page - 1) * pageSize}`,
    )
    return {
      rows: r.map(
        (x): AuditRowDto => ({
          id: Number(x.id),
          at: new Date(x.at).toISOString(),
          userId: x.user_id,
          userName: x.user_name,
          action: x.action,
          entity: x.entity,
          entityId: x.entity_id,
          summary: x.summary,
        }),
      ),
      total: n,
      page,
      pageSize,
    } satisfies AuditListDto
  })

  app.get('/api/audit/meta', async (req) => {
    requirePerm(req, 'audit.view')
    const entities = await rows<{ entity: string }>(db, sql`select distinct entity from audit_logs order by entity`)
    const actions = await rows<{ action: string }>(db, sql`select distinct action from audit_logs order by action`)
    const us = await rows(db, sql`select id, full_name from users order by full_name`)
    return { entities: entities.map((x) => x.entity), actions: actions.map((x) => x.action), users: us.map((x) => ({ id: x.id, fullName: x.full_name })) }
  })

  app.get('/api/audit/:id', async (req) => {
    requirePerm(req, 'audit.view')
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id < 1) throw new AppError(400, 'Geçersiz kayıt.', 'VALIDATION')
    const [x] = await rows(db, sql`select a.*, u.full_name as user_name from audit_logs a left join users u on u.id = a.user_id where a.id = ${id}`)
    if (!x) throw new AppError(404, 'Kayıt bulunamadı.', 'NOT_FOUND')
    return {
      id: Number(x.id),
      at: new Date(x.created_at).toISOString(),
      userId: x.user_id,
      userName: x.user_name,
      action: x.action,
      entity: x.entity,
      entityId: x.entity_id,
      summary: x.summary,
      diff: maskDiff(x.diff),
      prevHash: x.prev_hash,
      hash: x.hash,
    } satisfies AuditDetailDto
  })

  /** Hash zincirini baştan sona doğrular */
  app.post('/api/audit/verify', async (req) => {
    requirePerm(req, 'audit.view')
    const broken: AuditVerifyDto['broken'] = []
    let prev: string | null = null
    let first = true
    let lastId = 0
    let checked = 0
    for (;;) {
      const r = await db.$client.query(
        'select id, created_at as at, user_id, action, entity, entity_id, summary, diff, prev_hash, hash from audit_logs where id > $1 order by id limit 5000',
        [lastId],
      )
      if (!r.rows.length) break
      for (const x of r.rows) {
        const id = Number(x.id)
        lastId = id
        checked++
        if (!first && x.prev_hash !== prev) broken.push({ id, reason: 'Önceki satırla bağlantı kopuk (satır silinmiş ya da araya eklenmiş olabilir).' })
        else if (first && x.prev_hash !== null) broken.push({ id, reason: 'Zincirin ilk satırı bir önceki özete işaret ediyor (baştaki satırlar silinmiş olabilir).' })
        const at = new Date(x.at).toISOString()
        const base = [x.prev_hash, at, x.user_id, x.action, x.entity, x.entity_id, x.summary]
        const ok =
          sha256(JSON.stringify([...base, x.diff ?? null])) === x.hash || (x.diff !== null && sha256(JSON.stringify([...base, sortedKeys(x.diff)])) === x.hash)
        if (!ok) broken.push({ id, reason: 'Satır içeriği değiştirilmiş (özet tutmuyor).' })
        prev = x.hash
        first = false
        if (broken.length >= 200) break
      }
      if (broken.length >= 200) break
    }
    const u = requireUser(req)
    await writeAudit(db, {
      userId: u.id,
      action: 'view_sensitive',
      entity: 'audit_log',
      summary: broken.length ? `Zincir doğrulama: ${broken.length} sorunlu satır` : `Zincir doğrulama: ${checked} satır sağlam`,
    })
    return { ok: broken.length === 0, checked, broken } satisfies AuditVerifyDto
  })
}


