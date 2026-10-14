// Sahipler: liste, form, detay, birleştirme, silme, KVKK rıza geçmişi
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { owners, petvetTasks } from '../../db/schema'
import { AppError, parse, requirePerm, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { formatTrPhone, isValidTckn, normalizeTrMobile, trTitleCase } from '../../../shared/identity'
import { todayIstanbul } from '../../../shared/petvet'
import {
  CHANNELS,
  KVKK_METHODS,
  KVKK_TEXT_VERSION,
  MERGE_FIELDS,
  type ConsentRow,
  type ConsentType,
  type HistoryRow,
  type OwnerAnimalRow,
  type OwnerDetail,
  type OwnerListResult,
  type OwnerListRow,
} from '../../../shared/owners'
import type { Db } from '../../db/client'
import type { FieldCrypto } from '../../crypto'
import type { OwnerListItem } from '../../../shared/api-types'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalı.')
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `En fazla ${max} karakter.`)
    .optional()
    .transform((v) => (v ? v : undefined))

export const ownerInputSchema = z.object({
  firstName: z.string().trim().min(2, 'Ad en az 2 karakter olmalı.').max(60, 'Ad en fazla 60 karakter olabilir.'),
  lastName: z.string().trim().min(2, 'Soyad en az 2 karakter olmalı.').max(60, 'Soyad en fazla 60 karakter olabilir.'),
  tckn: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isValidTckn(v), 'TCKN geçersiz.'),
  birthDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().transform((v, ctx) => {
    const n = normalizeTrMobile(v)
    if (!n) ctx.addIssue({ code: 'custom', message: 'Cep telefonu geçersiz (5XX XXX XX XX).' })
    return n ?? ''
  }),
  email: z.string().trim().email('E-posta geçersiz.').optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().optional(),
  district: z.string().trim().optional(),
  address: z.string().trim().optional(),
  emergencyName: z.string().trim().optional(),
  emergencyPhone: z.string().trim().optional(),
  kvkkNotice: z.boolean().refine((v) => v, 'Aydınlatma metni verilmeden kayıt yapılamaz.'),
  reminderConsent: z.boolean().optional(),
  // ek alanlar (hepsi isteğe bağlı; hızlı kayıt göndermez)
  isForeign: z.boolean().optional(),
  foreignDocNo: optText(40),
  phone2: optText(20),
  preferredChannel: z.enum(CHANNELS, { message: 'Tercih edilen kanal geçersiz.' }).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
  notes: optText(2000),
  kvkkMethod: z.enum(KVKK_METHODS, { message: 'Aydınlatma yöntemi geçersiz.' }).optional(),
  marketingConsent: z.boolean().optional(),
})

export type OwnerInputParsed = z.infer<typeof ownerInputSchema>

const ownerUpdateSchema = ownerInputSchema.extend({
  version: z.number().int().positive(),
  clearTckn: z.boolean().optional(),
})

const idParam = z.object({ id: z.string().uuid('Geçersiz kayıt.') })

/** İkinci telefon: cep ise E.164, değilse rakamlar */
function normPhone2(v: string | undefined): string | null {
  if (!v) return null
  return normalizeTrMobile(v) ?? (v.replace(/[^\d+]/g, '').slice(0, 16) || null)
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))]
}

async function insertConsent(
  tx: Tx | Db,
  ownerId: string,
  type: ConsentType,
  granted: boolean,
  userId: string | null,
  channel: string,
  at: Date,
) {
  await tx.execute(
    sql`insert into consents (owner_id, type, granted, text_version, channel, at, user_id)
        values (${ownerId}, ${type}, ${granted}, ${KVKK_TEXT_VERSION}, ${channel}, ${at.toISOString()}, ${userId})`,
  )
}

async function findTcknOwner(tx: Tx | Db, tcknHash: string) {
  const [dup] = await tx
    .select({ id: owners.id, firstName: owners.firstName, lastName: owners.lastName })
    .from(owners)
    .where(and(eq(owners.tcknHash, tcknHash), isNull(owners.deletedAt)))
    .limit(1)
  return dup
}

export async function createOwner(tx: Tx, crypto: FieldCrypto, input: OwnerInputParsed, userId: string, now = new Date()) {
  let tcknFields = {}
  if (input.tckn) {
    const tcknHash = crypto.hash(input.tckn)
    const dup = await findTcknOwner(tx, tcknHash)
    if (dup) {
      throw new AppError(409, `Bu TCKN ${dup.firstName} ${dup.lastName} adına kayıtlı.`, 'DUPLICATE_TCKN', { ownerId: dup.id })
    }
    tcknFields = { tcknEnc: crypto.encrypt(input.tckn), tcknHash, tcknLast4: input.tckn.slice(-4) }
  }
  const reminder = input.reminderConsent ?? true
  const marketing = input.marketingConsent ?? false
  const [o] = await tx
    .insert(owners)
    .values({
      firstName: trTitleCase(input.firstName),
      lastName: trTitleCase(input.lastName),
      ...tcknFields,
      birthDate: input.birthDate ?? null,
      phone: input.phone,
      phone2: normPhone2(input.phone2),
      email: input.email?.toLowerCase() ?? null,
      city: input.city || null,
      district: input.district || null,
      address: input.address || null,
      emergencyName: input.emergencyName || null,
      emergencyPhone: input.emergencyPhone ? normalizeTrMobile(input.emergencyPhone) : null,
      preferredChannel: input.preferredChannel ?? 'sms',
      notes: input.notes ?? null,
      kvkkNoticeAt: now,
      reminderConsent: reminder,
      marketingConsentAt: marketing ? now : null,
      createdBy: userId,
    })
    .returning()
  // Drizzle şemasında olmayan sütunlar (200_owners.sql)
  await tx.execute(sql`update owners set tags = ${sql.param(cleanTags(input.tags))}::text[], is_foreign = ${!!input.isForeign},
      foreign_doc_enc = ${input.isForeign && input.foreignDocNo ? crypto.encrypt(input.foreignDocNo) : null},
      foreign_doc_last4 = ${input.isForeign && input.foreignDocNo ? input.foreignDocNo.slice(-4) : null},
      kvkk_notice_method = ${input.kvkkMethod ?? 'printed'}, updated_by = ${userId}
    where id = ${o.id}`)
  const channel = input.kvkkMethod ?? 'printed'
  await insertConsent(tx, o.id, 'kvkk_notice', true, userId, channel, now)
  await insertConsent(tx, o.id, 'reminder', reminder, userId, channel, now)
  await insertConsent(tx, o.id, 'marketing', marketing, userId, channel, now)
  await writeAudit(tx, { userId, action: 'create', entity: 'owner', entityId: o.id, summary: `${o.firstName} ${o.lastName}` })
  return o
}

/* ---------- Son ziyaret ifadesi ---------- */

const visitExprCache = new WeakMap<object, string | null>()

/** visits tablosu  varsa son ziyaret için kullanılacak sütun ifadesi; yoksa null */
async function visitsSource(db: Db): Promise<string | null> {
  if (visitExprCache.has(db)) return visitExprCache.get(db)!
  const r = await db.$client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'visits'`,
  )
  const cols = new Set(r.rows.map((x) => x.column_name))
  let expr: string | null = null
  if (cols.has('animal_id')) {
    const dateCol = ['visit_date', 'visited_at', 'visit_at', 'started_at', 'date', 'created_at'].find((c) => cols.has(c))
    if (dateCol) expr = `(select max(v.${dateCol})::date from visits v where v.animal_id = %A%${cols.has('deleted_at') ? ' and v.deleted_at is null' : ''})`
  }
  visitExprCache.set(db, expr)
  return expr
}

/** Bir hayvanın son ziyaret tarihi (muayene, kilo ölçümü, çip uygulaması) için SQL ifadesi */
export async function animalLastVisitSql(db: Db, animalIdExpr: string): Promise<string> {
  const v = await visitsSource(db)
  const parts = [
    `(select max(w.measured_at)::date from animal_weights w where w.animal_id = ${animalIdExpr})`,
    `(select max(m.implanted_at) from microchips m where m.animal_id = ${animalIdExpr})`,
  ]
  if (v) parts.push(v.replaceAll('%A%', animalIdExpr))
  return `greatest(${parts.join(', ')})`
}

/* ---------- Liste ---------- */

const listSchema = z.object({
  q: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  active: z.enum(['1', '0']).optional(),
  marketing: z.enum(['1', '0']).optional(),
  inactive12: z.enum(['1', '0']).optional(),
  tag: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
})
type ListFilter = z.infer<typeof listSchema>

async function queryOwners(db: Db, crypto: FieldCrypto, today: string, f: ListFilter): Promise<OwnerListResult> {
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const where = ['o.deleted_at is null']
  const term = f.q?.trim()
  if (term) {
    const digits = term.replace(/\D/g, '')
    if (digits.length === 11 && isValidTckn(digits)) {
      where.push(`o.tckn_hash = ${p(crypto.hash(digits))}`)
    } else if (digits.length >= 4 && digits.length === term.replace(/[\s()+-]/g, '').length) {
      where.push(`(o.phone like ${p('%' + digits.replace(/^0/, '') + '%')} or o.phone2 like ${p('%' + digits.replace(/^0/, '') + '%')} or o.tckn_last4 = ${p(digits.slice(-4))})`)
    } else {
      const like = p('%' + term + '%')
      where.push(`(pk_norm(o.first_name || ' ' || o.last_name) like pk_norm(${like}) or pk_norm(coalesce(o.email,'')) like pk_norm(${like}))`)
    }
  }
  if (f.city) where.push(`pk_norm(o.city) = pk_norm(${p(f.city)})`)
  if (f.district) where.push(`pk_norm(o.district) = pk_norm(${p(f.district)})`)
  if (f.marketing === '1') where.push(`o.marketing_consent_at is not null`)
  if (f.tag) where.push(`${p(f.tag)} = any(o.tags)`)
  if (f.active === '1') where.push(`x.animal_count > 0`)
  if (f.inactive12 === '1') where.push(`coalesce(x.last_visit, o.created_at::date) < ${p(today)}::date - interval '12 months'`)

  const lastVisit = await animalLastVisitSql(db, 'ao2.animal_id')
  const limit = Math.min(f.limit ?? 50, 5000)
  const r = await db.$client.query(
    `select o.id, o.first_name || ' ' || o.last_name as full_name, o.phone, o.email, o.city, o.district, o.tckn_last4,
            o.kvkk_notice_at, o.reminder_consent, o.marketing_consent_at, o.tags, x.animal_count, x.last_visit,
            count(*) over() as total
     from owners o
     cross join lateral (
       select
         (select count(*) from animal_owners ao join animals a on a.id = ao.animal_id
            where ao.owner_id = o.id and ao.to_date is null and a.status <> 'dead' and a.deleted_at is null)::int as animal_count,
         (select max(${lastVisit}) from animal_owners ao2 where ao2.owner_id = o.id) as last_visit
     ) x
     where ${where.join(' and ')}
     order by o.last_name, o.first_name
     limit ${limit} offset ${f.offset ?? 0}`,
    params,
  )
  return {
    total: r.rows.length ? Number(r.rows[0].total) : 0,
    items: r.rows.map(
      (x): OwnerListRow => ({
        id: x.id,
        fullName: x.full_name,
        phone: x.phone,
        email: x.email,
        city: x.city,
        district: x.district,
        tcknLast4: x.tckn_last4,
        animalCount: x.animal_count,
        kvkkNoticeAt: x.kvkk_notice_at ? new Date(x.kvkk_notice_at).toISOString() : null,
        reminderConsent: x.reminder_consent,
        marketingConsent: !!x.marketing_consent_at,
        tags: x.tags ?? [],
        lastVisit: x.last_visit ? toIsoDate(x.last_visit) : null,
      }),
    ),
  }
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) {
    // pg 'date' tipini Date olarak döndürebilir (yerel saat)
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // CSV formül enjeksiyonuna karşı
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/* ---------- Detay ---------- */

async function loadOwnerDetail(db: Db, id: string): Promise<OwnerDetail> {
  const r = await db.$client.query(
    `select o.*, cu.full_name as created_by_name, uu.full_name as updated_by_name
     from owners o left join users cu on cu.id = o.created_by left join users uu on uu.id = o.updated_by
     where o.id = $1`,
    [id],
  )
  const o = r.rows[0]
  if (!o) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
  if (o.deleted_at) {
    throw new AppError(404, o.merged_into ? 'Bu kayıt başka bir sahiple birleştirildi.' : 'Sahip kaydı silinmiş.', 'NOT_FOUND', { mergedInto: o.merged_into })
  }
  const animalsR = await db.$client.query(
    `select distinct on (a.id) a.id, a.name, a.species, a.breed, a.sex, a.neutered, a.birth_date, a.status, a.allergies, a.behavior,
            ao.to_date, ao.is_primary,
            (select chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1) as chip_no
     from animal_owners ao join animals a on a.id = ao.animal_id
     where ao.owner_id = $1 and a.deleted_at is null
     order by a.id, (ao.to_date is null) desc, ao.from_date desc`,
    [id],
  )
  const consR = await db.$client.query(
    `select c.id, c.type, c.granted, c.text_version, c.channel, c.at, u.full_name as user_name
     from consents c left join users u on u.id = c.user_id where c.owner_id = $1 order by c.at desc, c.type`,
    [id],
  )
  const animalsList: OwnerAnimalRow[] = animalsR.rows
    .map((a) => ({
      id: a.id,
      name: a.name,
      species: a.species,
      breed: a.breed,
      sex: a.sex,
      neutered: a.neutered,
      birthDate: a.birth_date,
      status: a.status,
      chipNo: a.chip_no,
      toDate: a.to_date,
      isPrimary: a.is_primary,
      allergies: a.allergies ?? [],
      behavior: a.behavior,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
  return {
    id: o.id,
    firstName: o.first_name,
    lastName: o.last_name,
    fullName: `${o.first_name} ${o.last_name}`,
    tcknLast4: o.tckn_last4,
    hasTckn: !!o.tckn_enc,
    isForeign: o.is_foreign,
    foreignDocLast4: o.foreign_doc_last4,
    birthDate: o.birth_date,
    phone: o.phone,
    phone2: o.phone2,
    email: o.email,
    city: o.city,
    district: o.district,
    address: o.address,
    emergencyName: o.emergency_name,
    emergencyPhone: o.emergency_phone,
    preferredChannel: o.preferred_channel,
    tags: o.tags ?? [],
    notes: o.notes,
    kvkkNoticeAt: o.kvkk_notice_at ? new Date(o.kvkk_notice_at).toISOString() : null,
    kvkkMethod: o.kvkk_notice_method,
    reminderConsent: o.reminder_consent,
    marketingConsentAt: o.marketing_consent_at ? new Date(o.marketing_consent_at).toISOString() : null,
    version: o.version,
    createdAt: new Date(o.created_at).toISOString(),
    createdByName: o.created_by_name,
    updatedAt: new Date(o.updated_at).toISOString(),
    updatedByName: o.updated_by_name,
    animals: animalsList,
    consents: consR.rows.map(
      (c): ConsentRow => ({
        id: c.id,
        type: c.type,
        granted: c.granted,
        textVersion: c.text_version,
        channel: c.channel,
        at: new Date(c.at).toISOString(),
        userName: c.user_name,
      }),
    ),
  }
}

/** Bir sahibe ait aktif (ölmemiş, devredilmemiş) hayvan sayısı */
async function activeAnimalCount(tx: Tx | Db, ownerId: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from animal_owners ao join animals a on a.id = ao.animal_id
        where ao.owner_id = ${ownerId} and ao.to_date is null and a.status <> 'dead' and a.deleted_at is null`,
  )
  return Number(r.rows[0].n)
}

/** TCKN eklenince yalnızca TCKN eksikliği nedeniyle bekleyen PETVET görevleri tekrar "bekliyor" olur */
async function reopenMissingTcknTasks(tx: Tx, ownerId: string) {
  await tx
    .update(petvetTasks)
    .set({ status: 'pending', missingFields: sql`array_remove(${petvetTasks.missingFields}, 'owner.tckn')`, updatedAt: new Date() })
    .where(and(eq(petvetTasks.ownerId, ownerId), inArray(petvetTasks.status, ['missing_info']), sql`${petvetTasks.missingFields} = array['owner.tckn']`))
}

export function ownerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, crypto } = deps
  const today = () => deps.today?.() ?? todayIstanbul()
  const now = () => deps.now?.() ?? new Date()

  // Basit arama (hızlı kayıt, devir, birleştirme seçicileri) - dizi döndürür
  app.get('/api/owners', async (req) => {
    requirePerm(req, 'owners.read')
    const { q } = parse(z.object({ q: z.string().optional() }), req.query)
    const r = await queryOwners(db, crypto, today(), { q, limit: 30 })
    return r.items.map(
      (x): OwnerListItem => ({
        id: x.id,
        fullName: x.fullName,
        phone: x.phone,
        city: x.city,
        district: x.district,
        tcknLast4: x.tcknLast4,
        animalCount: x.animalCount,
        kvkkNoticeAt: x.kvkkNoticeAt,
      }),
    )
  })

  // liste (filtreli, sayfalı)
  app.get('/api/owners/list', async (req) => {
    requirePerm(req, 'owners.read')
    const f = parse(listSchema, req.query)
    return queryOwners(db, crypto, today(), { ...f, limit: Math.min(f.limit ?? 50, 200) })
  })

  // CSV dışa aktarma (TCKN içermez)
  app.get('/api/owners/export.csv', async (req, reply) => {
    const u = requirePerm(req, 'owners.export')
    const f = parse(listSchema, req.query)
    const r = await queryOwners(db, crypto, today(), { ...f, offset: 0, limit: 5000 })
    const head = ['Ad soyad', 'Telefon', 'E-posta', 'İl', 'İlçe', 'Aktif hayvan', 'Son ziyaret', 'Aydınlatma', 'Hatırlatma izni', 'Ticari ileti izni', 'Etiketler']
    const lines = [head.map(csvCell).join(';')]
    for (const x of r.items) {
      lines.push(
        [
          x.fullName,
          formatTrPhone(x.phone),
          x.email,
          x.city,
          x.district,
          x.animalCount,
          x.lastVisit,
          x.kvkkNoticeAt ? 'Evet' : 'Hayır',
          x.reminderConsent ? 'Evet' : 'Hayır',
          x.marketingConsent ? 'Evet' : 'Hayır',
          x.tags.join(', '),
        ]
          .map(csvCell)
          .join(';'),
      )
    }
    await writeAudit(db, { userId: u.id, action: 'export', entity: 'owner', summary: `Sahip listesi CSV (${r.items.length} kayıt)`, diff: { filters: f } })
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="sahipler-${today()}.csv"`)
    return '﻿' + lines.join('\r\n')
  })

  // Form alanı terk edilince: aynı TCKN / telefon başka sahipte var mı
  app.get('/api/owners/check', async (req) => {
    requirePerm(req, 'owners.read')
    const f = parse(z.object({ tckn: z.string().optional(), phone: z.string().optional(), exclude: z.string().uuid().optional() }), req.query)
    let tcknOwner: { id: string; fullName: string } | null = null
    if (f.tckn && isValidTckn(f.tckn)) {
      const dup = await findTcknOwner(db, crypto.hash(f.tckn))
      if (dup && dup.id !== f.exclude) tcknOwner = { id: dup.id, fullName: `${dup.firstName} ${dup.lastName}` }
    }
    let phoneOwners: { id: string; fullName: string }[] = []
    const phone = f.phone ? normalizeTrMobile(f.phone) : null
    if (phone) {
      const r = await db.$client.query(
        `select id, first_name || ' ' || last_name as full_name from owners where deleted_at is null and phone = $1 and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000') limit 5`,
        [phone, f.exclude ?? null],
      )
      phoneOwners = r.rows.map((x) => ({ id: x.id, fullName: x.full_name }))
    }
    return { tcknOwner, phoneOwners }
  })

  app.post('/api/owners', async (req) => {
    const u = requirePerm(req, 'owners.write')
    const input = parse(ownerInputSchema, req.body)
    const o = await db.transaction((tx) => createOwner(tx, crypto, input, u.id, now()))
    return { id: o.id }
  })

  app.get('/api/owners/:id', async (req) => {
    requirePerm(req, 'owners.read')
    const { id } = parse(idParam, req.params)
    return loadOwnerDetail(db, id)
  })

  // düzenleme (iyimser kilit)
  app.put('/api/owners/:id', async (req) => {
    const u = requirePerm(req, 'owners.write')
    const { id } = parse(idParam, req.params)
    const input = parse(ownerUpdateSchema, req.body)
    const at = now()
    return db.transaction(async (tx) => {
      const [cur] = await tx.select().from(owners).where(eq(owners.id, id)).for('update').limit(1)
      if (!cur || cur.deletedAt) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
      if (cur.version !== input.version) {
        const r = await tx.execute<{ full_name: string | null }>(sql`select u.full_name from owners o left join users u on u.id = o.updated_by where o.id = ${id}`)
        const by = r.rows[0]?.full_name
        throw new AppError(409, `Bu kayıt ${by ? by + ' tarafından ' : ''}siz düzenlerken değiştirildi. Kaydı yeniden yükleyin.`, 'VERSION_CONFLICT', {
          version: cur.version,
          updatedAt: cur.updatedAt.toISOString(),
          updatedByName: by ?? null,
        })
      }
      const extra = (await tx.execute<{ tags: string[]; is_foreign: boolean; foreign_doc_last4: string | null }>(
        sql`select tags, is_foreign, foreign_doc_last4 from owners where id = ${id}`,
      )).rows[0]

      const next = {
        firstName: trTitleCase(input.firstName),
        lastName: trTitleCase(input.lastName),
        birthDate: input.birthDate ?? null,
        phone: input.phone,
        phone2: normPhone2(input.phone2),
        email: input.email?.toLowerCase() ?? null,
        city: input.city || null,
        district: input.district || null,
        address: input.address || null,
        emergencyName: input.emergencyName || null,
        emergencyPhone: input.emergencyPhone ? normalizeTrMobile(input.emergencyPhone) : null,
        preferredChannel: input.preferredChannel ?? cur.preferredChannel,
        notes: input.notes ?? null,
      }
      const diff: Record<string, [unknown, unknown]> = {}
      for (const [k, v] of Object.entries(next)) {
        const old = (cur as Record<string, unknown>)[k] ?? null
        if (old !== v) diff[k] = [old, v]
      }
      const tags = cleanTags(input.tags ?? extra.tags)
      if (JSON.stringify(tags) !== JSON.stringify(extra.tags ?? [])) diff.tags = [extra.tags, tags]

      // TCKN: boş gönderilirse değişmez; clearTckn ile silinir. Değer audit'e yazılmaz.
      let tcknSet: Record<string, unknown> = {}
      let tcknAdded = false
      if (input.tckn) {
        const tcknHash = crypto.hash(input.tckn)
        if (tcknHash !== cur.tcknHash) {
          const dup = await findTcknOwner(tx, tcknHash)
          if (dup && dup.id !== id) {
            throw new AppError(409, `Bu TCKN ${dup.firstName} ${dup.lastName} adına kayıtlı.`, 'DUPLICATE_TCKN', { ownerId: dup.id })
          }
          tcknSet = { tcknEnc: crypto.encrypt(input.tckn), tcknHash, tcknLast4: input.tckn.slice(-4) }
          diff.tckn = [cur.tcknLast4 ? '****' + cur.tcknLast4 : null, '****' + input.tckn.slice(-4)]
          tcknAdded = true
        }
      } else if (input.clearTckn && cur.tcknHash) {
        tcknSet = { tcknEnc: null, tcknHash: null, tcknLast4: null }
        diff.tckn = ['****' + cur.tcknLast4, null]
      }

      // Rıza değişiklikleri -> consents geçmişi
      const channel = input.kvkkMethod ?? 'printed'
      const consentSet: Record<string, unknown> = {}
      if (!cur.kvkkNoticeAt) {
        consentSet.kvkkNoticeAt = at
        await insertConsent(tx, id, 'kvkk_notice', true, u.id, channel, at)
      }
      if (input.reminderConsent !== undefined && input.reminderConsent !== cur.reminderConsent) {
        consentSet.reminderConsent = input.reminderConsent
        await insertConsent(tx, id, 'reminder', input.reminderConsent, u.id, channel, at)
        diff.reminderConsent = [cur.reminderConsent, input.reminderConsent]
      }
      if (input.marketingConsent !== undefined && input.marketingConsent !== !!cur.marketingConsentAt) {
        consentSet.marketingConsentAt = input.marketingConsent ? at : null
        await insertConsent(tx, id, 'marketing', input.marketingConsent, u.id, channel, at)
        diff.marketingConsent = [!!cur.marketingConsentAt, input.marketingConsent]
      }

      await tx
        .update(owners)
        .set({ ...next, ...tcknSet, ...consentSet, updatedAt: at, version: sql`${owners.version} + 1` })
        .where(eq(owners.id, id))
      const foreign = !!input.isForeign
      const docChanged = foreign && !!input.foreignDocNo
      await tx.execute(sql`update owners set tags = ${sql.param(tags)}::text[], is_foreign = ${foreign}, updated_by = ${u.id},
          kvkk_notice_method = coalesce(${input.kvkkMethod ?? null}, kvkk_notice_method),
          foreign_doc_enc = case when ${!foreign} then null when ${docChanged} then ${docChanged ? crypto.encrypt(input.foreignDocNo!) : null} else foreign_doc_enc end,
          foreign_doc_last4 = case when ${!foreign} then null when ${docChanged} then ${docChanged ? input.foreignDocNo!.slice(-4) : null} else foreign_doc_last4 end
        where id = ${id}`)
      if (tcknAdded) await reopenMissingTcknTasks(tx, id)
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'owner',
        entityId: id,
        summary: `${next.firstName} ${next.lastName}${diff.tckn ? ' - TCKN değiştirildi' : ''}`,
        diff: Object.keys(diff).length ? diff : undefined,
      })
      return { id, version: cur.version + 1 }
    })
  })

  // TCKN tam görüntüleme (izin + denetim kaydı)
  app.post('/api/owners/:id/tckn/reveal', async (req) => {
    const u = requirePerm(req, 'owners.tckn.view')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query('select tckn_enc, foreign_doc_enc, deleted_at from owners where id = $1', [id])
    const o = r.rows[0]
    if (!o || o.deleted_at) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
    if (!o.tckn_enc && !o.foreign_doc_enc) throw new AppError(404, 'Bu sahipte kimlik numarası kayıtlı değil.', 'NO_TCKN')
    await writeAudit(db, { userId: u.id, action: 'view_sensitive', entity: 'owner', entityId: id, summary: 'Sahip detayı: kimlik numarası görüntülendi' })
    return {
      tckn: o.tckn_enc ? crypto.decrypt(o.tckn_enc) : null,
      foreignDocNo: o.foreign_doc_enc ? crypto.decrypt(o.foreign_doc_enc) : null,
    }
  })

  // Geçmiş sekmesi
  app.get('/api/owners/:id/history', async (req) => {
    requirePerm(req, 'owners.read')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query(
      `select l.id, l.created_at as at, l.action, l.entity, l.summary, u.full_name as user_name
       from audit_logs l left join users u on u.id = l.user_id
       where l.entity = 'owner' and l.entity_id = $1 order by l.id desc limit 200`,
      [id],
    )
    return r.rows.map(
      (x): HistoryRow => ({ id: Number(x.id), at: new Date(x.at).toISOString(), action: x.action, entity: x.entity, summary: x.summary, userName: x.user_name }),
    )
  })

  // Sil (yumuşak). Aktif hayvanı varsa engellenir.
  app.delete('/api/owners/:id', async (req) => {
    const u = requirePerm(req, 'owners.merge')
    const { id } = parse(idParam, req.params)
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(owners).where(eq(owners.id, id)).for('update').limit(1)
      if (!cur || cur.deletedAt) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
      const n = await activeAnimalCount(tx, id)
      if (n > 0) throw new AppError(409, `Bu sahibin ${n} aktif hayvanı var. Önce hayvanları devredin ya da durumlarını güncelleyin.`, 'HAS_ACTIVE_ANIMALS', { count: n })
      await tx.update(owners).set({ deletedAt: now(), updatedAt: now(), version: sql`${owners.version} + 1` }).where(eq(owners.id, id))
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'owner', entityId: id, summary: `${cur.firstName} ${cur.lastName}` })
    })
    return { ok: true }
  })

  // Birleştir: :id kalır, otherId taşınır ve yumuşak silinir
  app.post('/api/owners/:id/merge', async (req) => {
    const u = requirePerm(req, 'owners.merge')
    const { id } = parse(idParam, req.params)
    const body = parse(
      z.object({
        otherId: z.string().uuid('Birleştirilecek kaydı seçin.'),
        pick: z.partialRecord(z.enum(MERGE_FIELDS), z.enum(['keep', 'other'])).optional(),
      }),
      req.body,
    )
    if (body.otherId === id) throw new AppError(400, 'Bir kayıt kendisiyle birleştirilemez.', 'VALIDATION')
    const pick = body.pick ?? {}
    const at = now()
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(owners).where(inArray(owners.id, [id, body.otherId])).for('update')
      const keep = rows.find((r) => r.id === id)
      const other = rows.find((r) => r.id === body.otherId)
      if (!keep || keep.deletedAt || !other || other.deletedAt) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')

      const patch: Partial<typeof owners.$inferInsert> = {}
      const take = (f: string) => pick[f as keyof typeof pick] === 'other'
      if (take('firstName')) patch.firstName = other.firstName
      if (take('lastName')) patch.lastName = other.lastName
      if (take('birthDate')) patch.birthDate = other.birthDate
      if (take('phone')) patch.phone = other.phone
      if (take('phone2')) patch.phone2 = other.phone2
      if (take('email')) patch.email = other.email
      if (take('city')) patch.city = other.city
      if (take('district')) patch.district = other.district
      if (take('address')) patch.address = other.address
      if (take('notes')) patch.notes = other.notes
      if (take('emergency')) {
        patch.emergencyName = other.emergencyName
        patch.emergencyPhone = other.emergencyPhone
      }
      const tcknFromOther = take('tckn') || (!keep.tcknHash && !!other.tcknHash)
      if (tcknFromOther) {
        patch.tcknEnc = other.tcknEnc
        patch.tcknHash = other.tcknHash
        patch.tcknLast4 = other.tcknLast4
      }
      if (!keep.kvkkNoticeAt && other.kvkkNoticeAt) patch.kvkkNoticeAt = other.kvkkNoticeAt

      // Önce diğer kaydı sil (TCKN benzersiz indeksi yalnızca silinmemişlerde)
      await tx.update(owners).set({ deletedAt: at, updatedAt: at, version: sql`${owners.version} + 1` }).where(eq(owners.id, other.id))
      await tx.execute(sql`update owners set merged_into = ${id}, updated_by = ${u.id} where id = ${other.id}`)

      // Sahiplikler: çakışan (aynı hayvan, aynı başlangıç ya da ikisi de açık) satırlar düşer, kalanlar taşınır
      await tx.execute(sql`delete from animal_owners x where x.owner_id = ${other.id} and exists (
          select 1 from animal_owners y where y.owner_id = ${id} and y.animal_id = x.animal_id
            and (y.from_date = x.from_date or (y.to_date is null and x.to_date is null)))`)
      const moved = await tx.execute<{ animal_id: string }>(sql`update animal_owners set owner_id = ${id} where owner_id = ${other.id} returning animal_id`)
      await tx.execute(sql`update petvet_tasks set owner_id = ${id}, updated_at = now() where owner_id = ${other.id}`)
      await tx.execute(sql`update consents set owner_id = ${id} where owner_id = ${other.id}`)
      await tx.execute(sql`update attachments set owner_id = ${id} where owner_type = 'owner' and owner_id = ${other.id}`)

      await tx
        .update(owners)
        .set({ ...patch, updatedAt: at, version: sql`${owners.version} + 1` })
        .where(eq(owners.id, id))
      await tx.execute(sql`update owners set updated_by = ${u.id},
          tags = array(select distinct unnest(tags || (select o2.tags from owners o2 where o2.id = ${other.id})))
        where id = ${id}`)
      if (patch.tcknHash ?? keep.tcknHash) await reopenMissingTcknTasks(tx, id)

      const summary = `Birleştirme: ${other.firstName} ${other.lastName} kaydı ${keep.firstName} ${keep.lastName} kaydına taşındı`
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'owner',
        entityId: id,
        summary,
        diff: { mergedFrom: other.id, fields: Object.keys(patch).filter((k) => !k.startsWith('tckn')).concat(tcknFromOther ? ['tckn'] : []) },
      })
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'owner', entityId: other.id, summary, diff: { mergedInto: id } })
      return { ok: true, movedAnimals: moved.rows.length }
    })
  })
}
