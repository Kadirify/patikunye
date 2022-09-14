// Aşılar modülü (D) API'si: ürünler, protokoller, aşı uygulama (S-50), aşı takvimi (S-51), hayvanın aşı planı
import type { FastifyInstance } from 'fastify'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { animalOwners, animals, owners, petvetTasks, users } from '../../db/schema'
import type { Db } from '../../db/client'
import { AppError, parse, requirePerm, requireUser, type AppDeps, type SessionUser } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import { cancelReminders, scheduleReminder } from '../services/reminders'
import { addDaysIso, diffDaysIso, formatDateTr, petvetDueDate, todayIstanbul } from '../../../shared/petvet'
import { can, type Permission } from '../../../shared/permissions'
import { PETVET_SPECIES, type Species } from '../../../shared/api-types'
import {
  CALENDAR_FILTERS,
  VACCINE_KINDS,
  VACCINE_KIND_LABEL,
  ageWeeks,
  firstDueDate,
  nextAfter,
  stepIndexFor,
  validateSteps,
  type AnimalVaccinesDto,
  type CalendarDto,
  type CalendarFilter,
  type CalendarItem,
  type PlanStatus,
  type ProtocolStep,
  type ReminderInfo,
  type VaccinateResult,
  type VaccinationDto,
  type VaccinationPlanDto,
  type VaccineKind,
  type VaccinePreviewDto,
  type VaccineProduct,
  type VaccineProtocol,
} from '../../../shared/vaccines'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Conn = Tx | Db

// ---------------------------------------------------------------- tablolar (migrations/400_vaccines.sql)

const vaccineProducts = pgTable('vaccine_products', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  manufacturer: text('manufacturer'),
  kind: varchar('kind', { length: 20 }).notNull(),
  species: text('species').array().notNull(),
  immunityDays: integer('immunity_days'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

const vaccineProtocols = pgTable('vaccine_protocols', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  species: varchar('species', { length: 20 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  name: text('name').notNull(),
  steps: jsonb('steps').$type<ProtocolStep[]>().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

const vaccinations = pgTable('vaccinations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  animalId: uuid('animal_id').notNull(),
  productId: uuid('product_id'),
  productName: text('product_name'),
  kind: varchar('kind', { length: 20 }).notNull(),
  lotNo: text('lot_no'),
  expiryDate: date('expiry_date'),
  givenAt: date('given_at').notNull(),
  givenBy: uuid('given_by'),
  doseLabel: text('dose_label'),
  protocolId: uuid('protocol_id'),
  visitId: uuid('visit_id'),
  passportRecorded: boolean('passport_recorded').notNull().default(false),
  sideEffects: text('side_effects'),
  external: boolean('external').notNull().default(false),
  externalClinic: text('external_clinic'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deleteReason: text('delete_reason'),
})

const vaccinationPlans = pgTable('vaccination_plans', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  animalId: uuid('animal_id').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  doseLabel: text('dose_label'),
  protocolId: uuid('protocol_id'),
  dueDate: date('due_date').notNull(),
  status: varchar('status', { length: 12 }).notNull().default('planned'),
  vaccinationId: uuid('vaccination_id'),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

const animalVaccineProtocols = pgTable('animal_vaccine_protocols', {
  animalId: uuid('animal_id').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  protocolId: uuid('protocol_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------- doğrulama şemaları

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih geçersiz.')
const SPECIES = ['cat', 'dog', 'ferret', 'bird', 'rabbit', 'rodent', 'reptile', 'other'] as const
const kindSchema = z.enum(VACCINE_KINDS, { message: 'Aşı türünü seçin.' })
const optText = (max: number) => z.string().trim().max(max).optional()
const uuidParam = z.object({ id: z.string().uuid('Geçersiz kayıt.') })

const productSchema = z.object({
  name: z.string().trim().min(1, 'Ürün adı gerekli.').max(80),
  manufacturer: optText(80),
  kind: kindSchema,
  species: z.array(z.enum(SPECIES)).default([]),
  immunityDays: z.number().int().positive('Bağışıklık süresi pozitif olmalı.').max(3650).nullable().optional(),
  active: z.boolean().default(true),
  notes: optText(500),
})

const stepSchema = z.object({
  label: z.string().trim().min(1, 'Adım adı gerekli.').max(40),
  minAgeWeeks: z.number().int().min(0).max(520).optional(),
  afterPrevWeeks: z.number().int().min(1, 'Aralık en az 1 hafta olmalı.').max(520).optional(),
  thenEveryDays: z.number().int().min(1).max(3650).optional(),
})
const protocolSchema = z.object({
  species: z.enum(SPECIES, { message: 'Tür seçin.' }),
  kind: kindSchema,
  name: z.string().trim().min(1, 'Protokol adı gerekli.').max(80),
  steps: z.array(stepSchema).min(1, 'Protokolde en az bir adım olmalı.').max(20),
  active: z.boolean().default(true),
})

const vaccinateSchema = z.object({
  animalId: z.string().uuid('Hayvan seçin.'),
  kind: kindSchema,
  productId: z.string().uuid('Ürün seçin.').optional(),
  productName: optText(80),
  lotNo: optText(40),
  expiryDate: isoDate.optional(),
  givenAt: isoDate,
  givenBy: z.string().uuid('Uygulayan hekimi seçin.').optional(),
  doseLabel: optText(40),
  nextDueDate: isoDate.nullable().optional(),
  passportRecorded: z.boolean().default(false),
  sideEffects: optText(500),
  visitId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  external: z.boolean().default(false),
  externalClinic: optText(120),
})
type VaccinateBody = z.infer<typeof vaccinateSchema>

// ---------------------------------------------------------------- yardımcılar

/** İzinlerden herhangi biri yeterli */
function requireAnyPerm(req: Parameters<typeof requireUser>[0], ...perms: Permission[]): SessionUser {
  const u = requireUser(req)
  if (!perms.some((p) => can(u.role, p))) throw new AppError(403, 'Bu işlem için yetkiniz yok.', 'FORBIDDEN')
  return u
}

const OPEN: PlanStatus[] = ['planned', 'postponed']

/** Vade günü 10:00 (Europe/Istanbul, 2016'dan beri sabit UTC+3) */
const eventAtFor = (dueIso: string) => new Date(`${dueIso}T10:00:00+03:00`)

const vaccineTitle = (kind: VaccineKind, doseLabel: string | null | undefined) =>
  `${VACCINE_KIND_LABEL[kind]}${doseLabel ? ` (${doseLabel})` : ''}`

type AnimalRow = typeof animals.$inferSelect

async function loadAnimal(c: Conn, id: string): Promise<AnimalRow> {
  const [a] = await c.select().from(animals).where(and(eq(animals.id, id), isNull(animals.deletedAt))).limit(1)
  if (!a) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
  return a
}

async function primaryOwner(c: Conn, animalId: string) {
  const [o] = await c
    .select({ id: owners.id, tcknHash: owners.tcknHash })
    .from(animalOwners)
    .innerJoin(owners, eq(owners.id, animalOwners.ownerId))
    .where(and(eq(animalOwners.animalId, animalId), isNull(animalOwners.toDate), isNull(owners.deletedAt)))
    .orderBy(desc(animalOwners.isPrimary))
    .limit(1)
  return o ?? null
}

function mapProtocol(p: typeof vaccineProtocols.$inferSelect): VaccineProtocol {
  return { id: p.id, species: p.species as Species, kind: p.kind as VaccineKind, name: p.name, steps: p.steps ?? [], active: p.active }
}

function mapProduct(p: typeof vaccineProducts.$inferSelect): VaccineProduct {
  return {
    id: p.id,
    name: p.name,
    manufacturer: p.manufacturer,
    kind: p.kind as VaccineKind,
    species: (p.species ?? []) as Species[],
    immunityDays: p.immunityDays,
    active: p.active,
    notes: p.notes,
  }
}

/** Hayvan için geçerli protokol: özel seçim, yoksa tür + aşı türü için ilk etkin protokol */
async function resolveProtocol(c: Conn, animalId: string, species: string, kind: VaccineKind) {
  const [own] = await c
    .select({ p: vaccineProtocols })
    .from(animalVaccineProtocols)
    .innerJoin(vaccineProtocols, eq(vaccineProtocols.id, animalVaccineProtocols.protocolId))
    .where(and(eq(animalVaccineProtocols.animalId, animalId), eq(animalVaccineProtocols.kind, kind)))
    .limit(1)
  if (own) return { protocol: mapProtocol(own.p), custom: true }
  const [def] = await c
    .select()
    .from(vaccineProtocols)
    .where(and(eq(vaccineProtocols.species, species), eq(vaccineProtocols.kind, kind), eq(vaccineProtocols.active, true)))
    .orderBy(asc(vaccineProtocols.createdAt), asc(vaccineProtocols.name))
    .limit(1)
  return def ? { protocol: mapProtocol(def), custom: false } : null
}

async function history(c: Conn, animalId: string, kind: VaccineKind) {
  const rows = await c
    .select()
    .from(vaccinations)
    .where(and(eq(vaccinations.animalId, animalId), eq(vaccinations.kind, kind), isNull(vaccinations.deletedAt)))
    .orderBy(desc(vaccinations.givenAt), desc(vaccinations.createdAt))
  return { count: rows.length, last: rows[0] ?? null }
}

/** Geçmişe göre son yapılan dozun protokoldeki indeksi */
function lastIndex(steps: ProtocolStep[], last: { doseLabel: string | null } | null, count: number): number | null {
  if (!last || !steps.length) return null
  const i = last.doseLabel ? steps.findIndex((s) => s.label === last.doseLabel) : -1
  if (i >= 0) return i
  return Math.min(count - 1, steps.length - 1)
}

interface DoseCalc {
  protocol: VaccineProtocol | null
  doseIndex: number | null
  doseLabel: string
  doseNo: number
  next: { dueDate: string; label: string } | null
  warnings: string[]
}

/** Yeni dozun sırası, sonraki doz tarihi ve uyarılar (geçmiş + protokol + ürün) */
async function calcDose(
  c: Conn,
  animal: AnimalRow,
  kind: VaccineKind,
  givenAt: string,
  opts: { doseLabel?: string; immunityDays?: number | null } = {},
): Promise<DoseCalc> {
  const res = await resolveProtocol(c, animal.id, animal.species, kind)
  const protocol = res?.protocol ?? null
  const steps = protocol?.steps ?? []
  const h = await history(c, animal.id, kind)
  const warnings: string[] = []

  let idx: number | null = null
  if (opts.doseLabel) {
    const i = steps.findIndex((s) => s.label === opts.doseLabel)
    idx = i >= 0 ? i : null
  } else if (steps.length) {
    const li = lastIndex(steps, h.last, h.count)
    idx = li == null ? stepIndexFor(steps, 0) : (nextAfter(steps, li, h.last!.givenAt)?.index ?? null)
  }
  const doseLabel = opts.doseLabel ?? (idx != null ? steps[idx].label : h.count ? 'Rapel' : '1. doz')

  const minAge = idx != null ? steps[idx].minAgeWeeks : undefined
  const w = ageWeeks(animal.birthDate, givenAt)
  if (minAge != null && w != null && w < minAge) {
    warnings.push(`Hayvan ${w} haftalık; protokolde bu doz için en küçük yaş ${minAge} hafta.`)
  }
  if (h.last && h.last.givenAt === givenAt) warnings.push('Bu tarihte aynı türde bir aşı zaten kayıtlı.')

  let next: DoseCalc['next'] = null
  if (idx != null) {
    const n = nextAfter(steps, idx, givenAt)
    if (n) next = { dueDate: n.dueDate, label: steps[n.index].label }
  } else if (opts.immunityDays) {
    next = { dueDate: addDaysIso(givenAt, opts.immunityDays), label: 'Rapel' }
  }
  return { protocol, doseIndex: idx, doseLabel, doseNo: h.count + 1, next, warnings }
}

/** Açık plan oluşturur ve hatırlatmayı planlar. Hayvan aktif değilse (ölü/kayıp) oluşturmaz. */
async function createPlan(
  tx: Tx,
  animal: AnimalRow,
  p: { kind: VaccineKind; doseLabel: string | null; dueDate: string; protocolId: string | null; userId: string },
) {
  if (animal.status !== 'active') return null
  const [plan] = await tx
    .insert(vaccinationPlans)
    .values({ animalId: animal.id, kind: p.kind, doseLabel: p.doseLabel, dueDate: p.dueDate, protocolId: p.protocolId, createdBy: p.userId })
    .returning()
  await remind(tx, animal, plan, false)
  return plan
}

async function remind(c: Conn, animal: { id: string; name: string }, plan: typeof vaccinationPlans.$inferSelect, immediate: boolean) {
  const owner = await primaryOwner(c, animal.id)
  if (!owner) return false
  await scheduleReminder(c, {
    kind: 'vaccine',
    sourceType: 'vaccination_plan',
    sourceId: plan.id,
    ownerId: owner.id,
    animalId: animal.id,
    eventAt: eventAtFor(plan.dueDate),
    vars: { hayvan_ad: animal.name, asi_ad: vaccineTitle(plan.kind as VaccineKind, plan.doseLabel), tarih: formatDateTr(plan.dueDate) },
    immediate,
  })
  return true
}

/** Hayvanın bu türdeki açık planlarını kapatır: ilki (ya da seçilen) verilen duruma, diğerleri iptale */
async function closeOpenPlans(
  tx: Tx,
  animalId: string,
  kind: VaccineKind,
  status: PlanStatus,
  opts: { vaccinationId?: string | null; reason?: string | null; preferId?: string },
) {
  const open = await tx
    .select()
    .from(vaccinationPlans)
    .where(and(eq(vaccinationPlans.animalId, animalId), eq(vaccinationPlans.kind, kind), inArray(vaccinationPlans.status, OPEN)))
    .orderBy(asc(vaccinationPlans.dueDate))
  const main = open.find((p) => p.id === opts.preferId) ?? open[0]
  for (const p of open) {
    const isMain = p.id === main?.id
    await tx
      .update(vaccinationPlans)
      .set({
        status: isMain ? status : 'cancelled',
        vaccinationId: isMain ? (opts.vaccinationId ?? null) : null,
        reason: isMain ? (opts.reason ?? null) : 'Yeni doz kaydedildi',
        updatedAt: new Date(),
      })
      .where(eq(vaccinationPlans.id, p.id))
    await cancelReminders(tx, 'vaccination_plan', p.id, isMain ? status : 'superseded')
  }
  return main?.id ?? null
}

/** Planı geçmiş + protokolden yeniden kurar (açık planlar iptal edilir) */
async function rebuildPlan(tx: Tx, animal: AnimalRow, kind: VaccineKind, userId: string, today: string) {
  await closeOpenPlans(tx, animal.id, kind, 'cancelled', { reason: 'Plan yeniden hesaplandı' })
  const res = await resolveProtocol(tx, animal.id, animal.species, kind)
  const steps = res?.protocol.steps ?? []
  const h = await history(tx, animal.id, kind)
  let due: { dueDate: string; label: string } | null = null
  if (h.last) {
    const li = lastIndex(steps, h.last, h.count)
    if (li != null) {
      const n = nextAfter(steps, li, h.last.givenAt)
      if (n) due = { dueDate: n.dueDate, label: steps[n.index].label }
    } else if (h.last.productId) {
      const [prod] = await tx.select().from(vaccineProducts).where(eq(vaccineProducts.id, h.last.productId)).limit(1)
      if (prod?.immunityDays) due = { dueDate: addDaysIso(h.last.givenAt, prod.immunityDays), label: 'Rapel' }
    }
  } else if (steps.length) {
    due = { dueDate: firstDueDate(steps, animal.birthDate, today), label: steps[0].label }
  }
  if (!due) return null
  return createPlan(tx, animal, { kind, doseLabel: due.label, dueDate: due.dueDate, protocolId: res?.protocol.id ?? null, userId })
}

// ---------------------------------------------------------------- hatırlatma / randevu bilgisi (M ve E modülleri)

/** reminders tablosu (M modülü) hazır mı? Henüz yoksa hatırlatma sütunu boş döner. */
async function remindersAvailable(db: Db): Promise<boolean> {
  const r = await db.$client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
     where table_schema = current_schema() and table_name = 'reminders' and column_name in ('source_type','source_id','status')`,
  )
  return r.rows[0].n === 3
}

const FAILED_SQL = `(r.status ilike '%fail%' or r.status ilike '%undeliver%' or r.status ilike '%error%')`

function reminderState(status: string): ReminderInfo['state'] {
  const s = status.toLowerCase()
  if (/fail|undeliver|error/.test(s)) return 'failed'
  if (/consent|izin/.test(s)) return 'no_consent'
  if (/cancel|expire/.test(s)) return 'cancelled'
  if (/sent|deliver/.test(s)) return 'sent'
  return 'planned'
}

async function reminderInfo(db: Db, planIds: string[], available: boolean): Promise<Map<string, ReminderInfo>> {
  const out = new Map<string, ReminderInfo>()
  if (!available || !planIds.length) return out
  try {
    const r = await db.$client.query<{ source_id: string; status: string; j: Record<string, unknown> }>(
      `select r.source_id::text as source_id, r.status::text as status, to_jsonb(r) as j
       from reminders r
       where r.source_type = 'vaccination_plan' and r.source_id::text = any($1::text[])`,
      [planIds],
    )
    const rank: Record<string, number> = { failed: 5, sent: 4, planned: 3, no_consent: 2, cancelled: 1 }
    for (const row of r.rows) {
      const state = reminderState(row.status)
      const at = (row.j.sent_at ?? row.j.updated_at ?? row.j.due_at ?? row.j.created_at ?? null) as string | null
      const cur = out.get(row.source_id)
      if (!cur || rank[state!] > rank[cur.state!] || (state === cur.state && at && (!cur.at || at > cur.at))) {
        out.set(row.source_id, { state, at, channel: (row.j.channel as string) ?? null, error: ((row.j.last_error ?? row.j.error) as string) ?? null })
      }
    }
  } catch {
    /* M modülü tablosu farklı biçimdeyse hatırlatma bilgisi gösterilmez */
  }
  return out
}

async function nextAppointments(db: Db, animalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!animalIds.length) return out
  try {
    const exists = await db.$client.query<{ t: string | null }>(`select to_regclass('appointments')::text as t`)
    if (!exists.rows[0].t) return out
    const r = await db.$client.query<{ animal_id: string; starts_at: Date }>(
      `select distinct on (animal_id) animal_id, starts_at from appointments
       where animal_id = any($1::uuid[]) and starts_at >= now()
         and coalesce(to_jsonb(appointments)->>'status', '') not in ('cancelled','no_show')
       order by animal_id, starts_at`,
      [animalIds],
    )
    for (const x of r.rows) out.set(x.animal_id, new Date(x.starts_at).toISOString())
  } catch {
    /* E modülü tablosu farklı biçimdeyse randevu bilgisi gösterilmez */
  }
  return out
}

// ---------------------------------------------------------------- aşı uygulama çekirdeği

async function applyVaccination(tx: Tx, u: SessionUser, b: VaccinateBody, today: string): Promise<VaccinateResult> {
  if (b.givenAt > today) throw new AppError(400, 'Uygulama tarihi ileri bir tarih olamaz.', 'VALIDATION')
  if (b.expiryDate && b.expiryDate < b.givenAt) {
    throw new AppError(400, 'Son kullanma tarihi uygulama tarihinden önce. Süresi geçmiş aşı uygulanamaz.', 'EXPIRED')
  }
  if (!b.external) {
    if (b.kind === 'rabies' && !b.lotNo) throw new AppError(400, 'Kuduz aşısında lot / seri no zorunlu.', 'VALIDATION')
    if (b.kind === 'rabies' && !b.expiryDate) throw new AppError(400, 'Kuduz aşısında son kullanma tarihi zorunlu.', 'VALIDATION')
    if (!b.productId) throw new AppError(400, 'Ürün seçin.', 'VALIDATION')
    if (!b.givenBy) throw new AppError(400, 'Uygulayan hekimi seçin.', 'VALIDATION')
  }
  if (b.nextDueDate && b.nextDueDate <= b.givenAt) throw new AppError(400, 'Sonraki doz tarihi uygulama tarihinden sonra olmalı.', 'VALIDATION')

  const animal = await loadAnimal(tx, b.animalId)
  if (animal.birthDate && animal.birthDate > b.givenAt) throw new AppError(400, 'Uygulama tarihi doğum tarihinden önce olamaz.', 'VALIDATION')

  let product: typeof vaccineProducts.$inferSelect | undefined
  if (b.productId) {
    ;[product] = await tx.select().from(vaccineProducts).where(eq(vaccineProducts.id, b.productId)).limit(1)
    if (!product) throw new AppError(404, 'Aşı ürünü bulunamadı.', 'NOT_FOUND')
    if (!product.active && !b.external) throw new AppError(400, 'Bu ürün kullanımdan kaldırılmış.', 'VALIDATION')
    if (product.kind !== b.kind) throw new AppError(400, 'Seçilen ürün bu aşı türüne ait değil.', 'VALIDATION')
    if (product.species.length && !product.species.includes(animal.species)) {
      throw new AppError(400, 'Seçilen ürün bu hayvan türü için tanımlı değil.', 'VALIDATION')
    }
  }
  if (b.givenBy) {
    const [vet] = await tx
      .select({ id: users.id, active: users.active })
      .from(users)
      .where(and(eq(users.id, b.givenBy), inArray(users.role, ['vet', 'admin'])))
      .limit(1)
    if (!vet?.active) throw new AppError(400, 'Uygulayan olarak bir hekim seçilmeli.', 'VALIDATION')
  }
  if (b.planId) {
    const [p] = await tx.select().from(vaccinationPlans).where(eq(vaccinationPlans.id, b.planId)).limit(1)
    if (!p || p.animalId !== animal.id) throw new AppError(404, 'Aşı planı bulunamadı.', 'NOT_FOUND')
    if (!OPEN.includes(p.status as PlanStatus)) throw new AppError(409, 'Bu plan satırı zaten kapatılmış.', 'NOT_OPEN')
    if (p.kind !== b.kind) throw new AppError(400, 'Plan satırının aşı türü farklı.', 'VALIDATION')
  }
  const [dup] = await tx
    .select({ id: vaccinations.id })
    .from(vaccinations)
    .where(and(eq(vaccinations.animalId, animal.id), eq(vaccinations.kind, b.kind), eq(vaccinations.givenAt, b.givenAt), isNull(vaccinations.deletedAt)))
    .limit(1)
  if (dup) throw new AppError(409, 'Bu hayvana aynı gün aynı türde aşı zaten kaydedilmiş.', 'DUPLICATE')

  const calc = await calcDose(tx, animal, b.kind, b.givenAt, { doseLabel: b.doseLabel, immunityDays: product?.immunityDays })

  const [v] = await tx
    .insert(vaccinations)
    .values({
      animalId: animal.id,
      productId: product?.id ?? null,
      productName: product?.name ?? b.productName ?? null,
      kind: b.kind,
      lotNo: b.lotNo || null,
      expiryDate: b.expiryDate ?? null,
      givenAt: b.givenAt,
      givenBy: b.givenBy ?? null,
      doseLabel: calc.doseLabel,
      protocolId: calc.protocol?.id ?? null,
      visitId: b.visitId ?? null,
      passportRecorded: b.passportRecorded,
      sideEffects: b.sideEffects || null,
      external: b.external,
      externalClinic: b.externalClinic || null,
      createdBy: u.id,
    })
    .returning()

  await closeOpenPlans(tx, animal.id, b.kind, b.external ? 'external' : 'done', { vaccinationId: v.id, preferId: b.planId })

  let nextPlan: typeof vaccinationPlans.$inferSelect | null = null
  if (b.nextDueDate !== null) {
    const due = b.nextDueDate ?? calc.next?.dueDate
    if (due) {
      nextPlan = await createPlan(tx, animal, {
        kind: b.kind,
        doseLabel: calc.next?.label ?? 'Rapel',
        dueDate: due,
        protocolId: calc.protocol?.id ?? null,
        userId: u.id,
      })
    }
  }

  // PETVET görevi (ayarlardaki aşı türleri; varsayılan kuduz). Dış kayıtta görev diğer klinikte.
  let task: typeof petvetTasks.$inferSelect | null = null
  const settings = await getSettings(tx)
  if (!b.external && settings.petvet.vaccineKinds.includes(b.kind) && PETVET_SPECIES.includes(animal.species as Species)) {
    const owner = await primaryOwner(tx, animal.id)
    const missing = owner?.tcknHash ? [] : ['owner.tckn']
    ;[task] = await tx
      .insert(petvetTasks)
      .values({
        kind: 'VACCINE',
        animalId: animal.id,
        ownerId: owner?.id ?? null,
        vetId: b.givenBy ?? null,
        sourceType: 'vaccination',
        sourceId: v.id,
        eventDate: b.givenAt,
        dueDate: petvetDueDate('VACCINE', b.givenAt, settings.petvet.days),
        status: missing.length ? 'missing_info' : 'pending',
        missingFields: missing,
      })
      .returning()
  }

  await writeAudit(tx, {
    userId: u.id,
    action: 'create',
    entity: 'vaccination',
    entityId: v.id,
    summary: `${b.external ? 'Dış kayıt: ' : ''}${animal.name} · ${vaccineTitle(b.kind, calc.doseLabel)}${v.productName ? ' · ' + v.productName : ''}${v.lotNo ? ' · lot ' + v.lotNo : ''}`,
  })
  return {
    id: v.id,
    nextPlanId: nextPlan?.id ?? null,
    nextDueDate: nextPlan?.dueDate ?? null,
    petvetTaskId: task?.id ?? null,
    petvetStatus: (task?.status as VaccinateResult['petvetStatus']) ?? null,
    warnings: calc.warnings,
  }
}

// ---------------------------------------------------------------- takvim sorgusu

const CAL_SELECT = `
  from vaccination_plans p
  join animals a on a.id = p.animal_id and a.deleted_at is null and a.status = 'active'
  left join lateral (
    select o.id, o.first_name || ' ' || o.last_name as full_name, o.phone from animal_owners ao join owners o on o.id = ao.owner_id
    where ao.animal_id = a.id and ao.to_date is null and o.deleted_at is null order by ao.is_primary desc limit 1
  ) o on true
  where p.status in ('planned','postponed')`

function filterSql(f: CalendarFilter, t: string, remAvail: boolean): string {
  switch (f) {
    case 'week':
      return `p.due_date between date_trunc('week', ${t}::date)::date and date_trunc('week', ${t}::date)::date + 6`
    case 'month':
      return `date_trunc('month', p.due_date) = date_trunc('month', ${t}::date)`
    case 'overdue':
      return `p.due_date < ${t}::date and p.due_date >= ${t}::date - 30`
    case 'overdue30':
      return `p.due_date < ${t}::date - 30`
    case 'failed':
      return remAvail
        ? `exists (select 1 from reminders r where r.source_type = 'vaccination_plan' and r.source_id::text = p.id::text and ${FAILED_SQL})`
        : 'false'
    default:
      return 'true'
  }
}

// ---------------------------------------------------------------- uçlar

export function vaccinesRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const today = () => deps.today?.() ?? todayIstanbul()

  // ---- Ürünler (S-103)
  app.get('/api/vaccine-products', async (req) => {
    requireUser(req)
    const q = parse(z.object({ all: z.coerce.boolean().optional(), kind: kindSchema.optional(), species: z.string().optional() }), req.query)
    const where = [q.all ? undefined : eq(vaccineProducts.active, true), q.kind ? eq(vaccineProducts.kind, q.kind) : undefined]
    if (q.species) where.push(sql`(cardinality(${vaccineProducts.species}) = 0 or ${q.species} = any(${vaccineProducts.species}))`)
    const rows = await db
      .select()
      .from(vaccineProducts)
      .where(and(...where))
      .orderBy(asc(vaccineProducts.kind), asc(vaccineProducts.name))
    return rows.map(mapProduct)
  })

  app.post('/api/vaccine-products', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(productSchema, req.body)
    return db.transaction(async (tx) => {
      const [p] = await tx
        .insert(vaccineProducts)
        .values({ ...b, manufacturer: b.manufacturer || null, notes: b.notes || null, immunityDays: b.immunityDays ?? null })
        .returning()
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'vaccine_product', entityId: p.id, summary: p.name })
      return mapProduct(p)
    })
  })

  app.put('/api/vaccine-products/:id', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { id } = parse(uuidParam, req.params)
    const b = parse(productSchema, req.body)
    return db.transaction(async (tx) => {
      const [p] = await tx
        .update(vaccineProducts)
        .set({ ...b, manufacturer: b.manufacturer || null, notes: b.notes || null, immunityDays: b.immunityDays ?? null, updatedAt: new Date() })
        .where(eq(vaccineProducts.id, id))
        .returning()
      if (!p) throw new AppError(404, 'Ürün bulunamadı.', 'NOT_FOUND')
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'vaccine_product', entityId: id, summary: p.name, diff: b })
      return mapProduct(p)
    })
  })

  // ---- Protokoller (S-103)
  app.get('/api/vaccine-protocols', async (req) => {
    requireUser(req)
    const q = parse(z.object({ all: z.coerce.boolean().optional(), species: z.string().optional(), kind: kindSchema.optional() }), req.query)
    const rows = await db
      .select()
      .from(vaccineProtocols)
      .where(
        and(
          q.all ? undefined : eq(vaccineProtocols.active, true),
          q.species ? eq(vaccineProtocols.species, q.species) : undefined,
          q.kind ? eq(vaccineProtocols.kind, q.kind) : undefined,
        ),
      )
      .orderBy(asc(vaccineProtocols.species), asc(vaccineProtocols.kind), asc(vaccineProtocols.name))
    return rows.map(mapProtocol)
  })

  const saveProtocol = async (req: Parameters<typeof requireUser>[0], id?: string) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(protocolSchema, req.body)
    const err = validateSteps(b.steps)
    if (err) throw new AppError(400, err, 'VALIDATION')
    return db.transaction(async (tx) => {
      let p: typeof vaccineProtocols.$inferSelect | undefined
      if (id) {
        ;[p] = await tx.update(vaccineProtocols).set({ ...b, updatedAt: new Date() }).where(eq(vaccineProtocols.id, id)).returning()
        if (!p) throw new AppError(404, 'Protokol bulunamadı.', 'NOT_FOUND')
      } else {
        ;[p] = await tx.insert(vaccineProtocols).values(b).returning()
      }
      await writeAudit(tx, { userId: u.id, action: id ? 'update' : 'create', entity: 'vaccine_protocol', entityId: p.id, summary: p.name, diff: id ? b : undefined })
      return mapProtocol(p)
    })
  }
  app.post('/api/vaccine-protocols', async (req) => saveProtocol(req))
  app.put('/api/vaccine-protocols/:id', async (req) => saveProtocol(req, parse(uuidParam, req.params).id))

  // ---- Form önizleme: doz no, sonraki doz, uyarılar, son lot
  app.get('/api/vaccines/preview', async (req) => {
    requireAnyPerm(req, 'vaccinations.write', 'animals.read')
    const q = parse(
      z.object({ animalId: z.string().uuid(), kind: kindSchema, givenAt: isoDate.optional(), productId: z.string().uuid().optional(), doseLabel: z.string().optional() }),
      req.query,
    )
    const givenAt = q.givenAt ?? today()
    const animal = await loadAnimal(db, q.animalId)
    let immunityDays: number | null = null
    let lastLotNo: string | null = null
    let lastExpiryDate: string | null = null
    if (q.productId) {
      const [p] = await db.select().from(vaccineProducts).where(eq(vaccineProducts.id, q.productId)).limit(1)
      immunityDays = p?.immunityDays ?? null
      const [last] = await db
        .select({ lotNo: vaccinations.lotNo, expiryDate: vaccinations.expiryDate })
        .from(vaccinations)
        .where(and(eq(vaccinations.productId, q.productId), isNull(vaccinations.deletedAt), sql`${vaccinations.lotNo} is not null`, eq(vaccinations.external, false)))
        .orderBy(desc(vaccinations.createdAt))
        .limit(1)
      lastLotNo = last?.lotNo ?? null
      lastExpiryDate = last?.expiryDate ?? null
    }
    const calc = await calcDose(db, animal, q.kind, givenAt, { doseLabel: q.doseLabel || undefined, immunityDays })
    const settings = await getSettings(db)
    const inactive = animal.status !== 'active'
    if (inactive) calc.warnings.push('Hayvan aktif değil (ölü/kayıp): sonraki doz planı ve hatırlatma oluşturulmayacak.')
    return {
      doseLabel: calc.doseLabel,
      doseNo: calc.doseNo,
      protocolId: calc.protocol?.id ?? null,
      protocolName: calc.protocol?.name ?? null,
      nextDueDate: inactive ? null : (calc.next?.dueDate ?? null),
      nextDoseLabel: calc.next?.label ?? null,
      warnings: calc.warnings,
      lastLotNo,
      lastExpiryDate,
      petvetTask: settings.petvet.vaccineKinds.includes(q.kind) && PETVET_SPECIES.includes(animal.species as Species),
      animalInactive: inactive,
    } satisfies VaccinePreviewDto
  })

  // ---- Aşı uygula (S-50)
  app.post('/api/vaccinations', async (req) => {
    const u = requirePerm(req, 'vaccinations.write')
    const b = parse(vaccinateSchema, req.body)
    return db.transaction((tx) => applyVaccination(tx, u, b, today()))
  })

  // Hatalı kaydı sil (yumuşak) — PETVET görevi iptal olur, plan yeniden hesaplanır
  app.post('/api/vaccinations/:id/delete', async (req) => {
    const u = requirePerm(req, 'vaccinations.write')
    const { id } = parse(uuidParam, req.params)
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Silme nedenini yazın.').max(300) }), req.body)
    return db.transaction(async (tx) => {
      const [v] = await tx.select().from(vaccinations).where(and(eq(vaccinations.id, id), isNull(vaccinations.deletedAt))).for('update').limit(1)
      if (!v) throw new AppError(404, 'Aşı kaydı bulunamadı.', 'NOT_FOUND')
      await tx.update(vaccinations).set({ deletedAt: new Date(), deleteReason: reason, updatedAt: new Date() }).where(eq(vaccinations.id, id))
      await tx
        .update(petvetTasks)
        .set({ status: 'cancelled', cancelReason: `Aşı kaydı silindi: ${reason}`, updatedAt: new Date() })
        .where(and(eq(petvetTasks.sourceType, 'vaccination'), eq(petvetTasks.sourceId, id), inArray(petvetTasks.status, ['pending', 'missing_info'])))
      const animal = await loadAnimal(tx, v.animalId)
      await rebuildPlan(tx, animal, v.kind as VaccineKind, u.id, today())
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'vaccination', entityId: id, summary: reason })
      return { ok: true }
    })
  })

  // ---- Hayvanın aşıları + planı (S-33 Aşılar sekmesi)
  app.get('/api/animals/:id/vaccines', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(uuidParam, req.params)
    const animal = await loadAnimal(db, id)
    const t = today()
    const vr = await db.$client.query(
      `select v.*, p.name as p_name, p.manufacturer, u.full_name as given_by_name, pt.id as pt_id, pt.status as pt_status
       from vaccinations v
       left join vaccine_products p on p.id = v.product_id
       left join users u on u.id = v.given_by
       left join lateral (select id, status from petvet_tasks t where t.source_type = 'vaccination' and t.source_id = v.id order by t.created_at desc limit 1) pt on true
       where v.animal_id = $1 and v.deleted_at is null
       order by v.given_at desc, v.created_at desc`,
      [id],
    )
    const pr = await db
      .select()
      .from(vaccinationPlans)
      .where(eq(vaccinationPlans.animalId, id))
      .orderBy(sql`case when ${vaccinationPlans.status} in ('planned','postponed') then 0 else 1 end`, asc(vaccinationPlans.dueDate))
    const remAvail = await remindersAvailable(db)
    const rem = await reminderInfo(db, pr.map((p) => p.id), remAvail)
    const protocols: AnimalVaccinesDto['protocols'] = {}
    for (const k of VACCINE_KINDS) {
      const r = await resolveProtocol(db, id, animal.species, k)
      if (r) protocols[k] = { protocolId: r.protocol.id, name: r.protocol.name, custom: r.custom }
    }
    return {
      animalId: id,
      species: animal.species as Species,
      animalStatus: animal.status,
      vaccinations: vr.rows.map(
        (r): VaccinationDto => ({
          id: r.id,
          kind: r.kind,
          productId: r.product_id,
          productName: r.p_name ?? r.product_name,
          manufacturer: r.manufacturer ?? null,
          lotNo: r.lot_no,
          expiryDate: r.expiry_date,
          givenAt: r.given_at,
          givenById: r.given_by,
          givenByName: r.given_by_name ?? null,
          doseLabel: r.dose_label,
          visitId: r.visit_id,
          passportRecorded: r.passport_recorded,
          sideEffects: r.side_effects,
          external: r.external,
          externalClinic: r.external_clinic,
          petvetStatus: r.pt_status ?? null,
          petvetTaskId: r.pt_id ?? null,
        }),
      ),
      plans: pr.map(
        (p): VaccinationPlanDto => ({
          id: p.id,
          kind: p.kind as VaccineKind,
          doseLabel: p.doseLabel,
          dueDate: p.dueDate,
          status: p.status as PlanStatus,
          reason: p.reason,
          vaccinationId: p.vaccinationId,
          protocolId: p.protocolId,
          daysLeft: diffDaysIso(t, p.dueDate),
          reminder: remAvail ? (rem.get(p.id) ?? { state: null, at: null, channel: null, error: null }) : null,
        }),
      ),
      protocols,
    } satisfies AnimalVaccinesDto
  })

  // Protokol değiştir → planı yeniden kur
  app.post('/api/animals/:id/vaccine-protocol', async (req) => {
    const u = requirePerm(req, 'vaccinations.write')
    const { id } = parse(uuidParam, req.params)
    const b = parse(z.object({ kind: kindSchema, protocolId: z.string().uuid('Protokol seçin.') }), req.body)
    return db.transaction(async (tx) => {
      const animal = await loadAnimal(tx, id)
      const [p] = await tx.select().from(vaccineProtocols).where(eq(vaccineProtocols.id, b.protocolId)).limit(1)
      if (!p || !p.active) throw new AppError(404, 'Protokol bulunamadı.', 'NOT_FOUND')
      if (p.kind !== b.kind || p.species !== animal.species) throw new AppError(400, 'Protokol bu hayvan türüne / aşı türüne uygun değil.', 'VALIDATION')
      await tx
        .insert(animalVaccineProtocols)
        .values({ animalId: id, kind: b.kind, protocolId: b.protocolId })
        .onConflictDoUpdate({ target: [animalVaccineProtocols.animalId, animalVaccineProtocols.kind], set: { protocolId: b.protocolId, updatedAt: new Date() } })
      const plan = await rebuildPlan(tx, animal, b.kind, u.id, today())
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: `Aşı protokolü: ${p.name}` })
      return { planId: plan?.id ?? null, dueDate: plan?.dueDate ?? null }
    })
  })

  // Planı yeniden hesapla (tek tür ya da hayvanın ilgili tüm türleri)
  app.post('/api/animals/:id/vaccine-plan/recalculate', async (req) => {
    const u = requirePerm(req, 'vaccinations.write')
    const { id } = parse(uuidParam, req.params)
    const b = parse(z.object({ kind: kindSchema.optional() }), req.body ?? {})
    return db.transaction(async (tx) => {
      const animal = await loadAnimal(tx, id)
      let kinds: VaccineKind[]
      if (b.kind) kinds = [b.kind]
      else {
        const r = await tx.execute<{ kind: VaccineKind }>(sql`
          select kind from vaccinations where animal_id = ${id} and deleted_at is null
          union select kind from vaccination_plans where animal_id = ${id} and status in ('planned','postponed')
          union select kind from animal_vaccine_protocols where animal_id = ${id}`)
        kinds = r.rows.map((x) => x.kind)
      }
      const plans = []
      for (const k of kinds) {
        const p = await rebuildPlan(tx, animal, k, u.id, today())
        if (p) plans.push({ id: p.id, kind: k, dueDate: p.dueDate })
      }
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: `Aşı planı yeniden hesaplandı (${kinds.length} tür)` })
      return { plans }
    })
  })

  // ---- Takvim (S-51)
  app.get('/api/vaccine-calendar', async (req) => {
    requirePerm(req, 'animals.read')
    const q = parse(
      z.object({
        filter: z.enum(CALENDAR_FILTERS).default('overdue'),
        kind: kindSchema.optional(),
        species: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    )
    const remAvail = await remindersAvailable(db)
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    const t = p(today())
    const base: string[] = []
    if (q.kind) base.push(`p.kind = ${p(q.kind)}`)
    if (q.species) base.push(`a.species = ${p(q.species)}`)
    const baseSql = CAL_SELECT + (base.length ? ' and ' + base.join(' and ') : '')

    const countSql = `select ${CALENDAR_FILTERS.map((f) => `count(*) filter (where ${filterSql(f, t, remAvail)})::int as "${f}"`).join(', ')} ${baseSql}`
    const counts = (await db.$client.query<Record<CalendarFilter, number>>(countSql, params)).rows[0]

    const listParams = [...params]
    const lp = (v: unknown) => {
      listParams.push(v)
      return `$${listParams.length}`
    }
    const listSql = `select p.id, p.due_date, p.status, p.kind, p.dose_label, a.id as animal_id, a.name as animal_name, a.species,
        o.id as owner_id, o.full_name as owner_name, o.phone as owner_phone
      ${baseSql} and ${t}::date is not null and ${filterSql(q.filter, t, remAvail)}
      order by p.due_date asc, a.name asc
      limit ${lp(q.pageSize)} offset ${lp((q.page - 1) * q.pageSize)}`
    const rows = (await db.$client.query(listSql, listParams)).rows
    const rem = await reminderInfo(db, rows.map((r) => r.id), remAvail)
    const appts = await nextAppointments(db, [...new Set(rows.map((r) => r.animal_id as string))])
    const td = today()
    const items: CalendarItem[] = rows.map((r) => ({
      planId: r.id,
      dueDate: r.due_date,
      daysLeft: diffDaysIso(td, r.due_date),
      status: r.status,
      kind: r.kind,
      doseLabel: r.dose_label,
      animalId: r.animal_id,
      animalName: r.animal_name,
      species: r.species,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ownerPhone: r.owner_phone,
      reminder: remAvail ? (rem.get(r.id) ?? { state: null, at: null, channel: null, error: null }) : null,
      appointmentAt: appts.get(r.animal_id) ?? null,
    }))
    return { items, total: counts[q.filter], page: q.page, pageSize: q.pageSize, counts, remindersAvailable: remAvail } satisfies CalendarDto
  })

  // ---- Plan satırı işlemleri
  const loadOpenPlan = async (tx: Tx, id: string) => {
    const [p] = await tx.select().from(vaccinationPlans).where(eq(vaccinationPlans.id, id)).for('update').limit(1)
    if (!p) throw new AppError(404, 'Aşı planı bulunamadı.', 'NOT_FOUND')
    if (!OPEN.includes(p.status as PlanStatus)) throw new AppError(409, 'Bu plan satırı zaten kapatılmış.', 'NOT_OPEN')
    return p
  }

  // Ertele: yeni vade + hatırlatmayı yeniden planla
  app.post('/api/vaccination-plans/:id/postpone', async (req) => {
    const u = requireAnyPerm(req, 'vaccinations.write', 'messages.send')
    const { id } = parse(uuidParam, req.params)
    const b = parse(z.object({ dueDate: isoDate, reason: optText(300) }), req.body)
    if (b.dueDate < today()) throw new AppError(400, 'Yeni vade bugünden önce olamaz.', 'VALIDATION')
    return db.transaction(async (tx) => {
      const p = await loadOpenPlan(tx, id)
      if (b.dueDate === p.dueDate) throw new AppError(400, 'Yeni vade mevcut vadeyle aynı.', 'VALIDATION')
      const [np] = await tx
        .update(vaccinationPlans)
        .set({ dueDate: b.dueDate, status: 'postponed', reason: b.reason || null, updatedAt: new Date() })
        .where(eq(vaccinationPlans.id, id))
        .returning()
      await cancelReminders(tx, 'vaccination_plan', id, 'postponed')
      const animal = await loadAnimal(tx, p.animalId)
      if (animal.status === 'active') await remind(tx, animal, np, false)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'vaccination_plan', entityId: id, summary: `Ertelendi: ${formatDateTr(p.dueDate)} → ${formatDateTr(b.dueDate)}${b.reason ? ' · ' + b.reason : ''}` })
      return { ok: true, dueDate: b.dueDate }
    })
  })

  // İptal (neden zorunlu)
  app.post('/api/vaccination-plans/:id/cancel', async (req) => {
    const u = requireAnyPerm(req, 'vaccinations.write', 'messages.send')
    const { id } = parse(uuidParam, req.params)
    const b = parse(z.object({ reason: z.string().trim().min(3, 'İptal nedenini yazın.').max(300) }), req.body)
    return db.transaction(async (tx) => {
      await loadOpenPlan(tx, id)
      await tx.update(vaccinationPlans).set({ status: 'cancelled', reason: b.reason, updatedAt: new Date() }).where(eq(vaccinationPlans.id, id))
      await cancelReminders(tx, 'vaccination_plan', id, 'cancelled')
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'vaccination_plan', entityId: id, summary: `İptal: ${b.reason}` })
      return { ok: true }
    })
  })

  // Başka klinikte yaptırıldı → dış kayıt + sonraki plan
  app.post('/api/vaccination-plans/:id/external', async (req) => {
    const u = requirePerm(req, 'vaccinations.write')
    const { id } = parse(uuidParam, req.params)
    const b = parse(
      z.object({
        givenAt: isoDate,
        productId: z.string().uuid().optional(),
        productName: optText(80),
        lotNo: optText(40),
        externalClinic: optText(120),
        nextDueDate: isoDate.nullable().optional(),
      }),
      req.body,
    )
    return db.transaction(async (tx) => {
      const p = await loadOpenPlan(tx, id)
      return applyVaccination(
        tx,
        u,
        {
          animalId: p.animalId,
          kind: p.kind as VaccineKind,
          productId: b.productId,
          productName: b.productName,
          lotNo: b.lotNo,
          givenAt: b.givenAt,
          nextDueDate: b.nextDueDate,
          passportRecorded: false,
          planId: id,
          external: true,
          externalClinic: b.externalClinic,
        },
        today(),
      )
    })
  })

  // Toplu: seçililere hatırlatma gönder (şimdi)
  app.post('/api/vaccination-plans/remind', async (req) => {
    const u = requirePerm(req, 'messages.send')
    const b = parse(z.object({ planIds: z.array(z.string().uuid()).min(1, 'Satır seçin.').max(500) }), req.body)
    return db.transaction(async (tx) => {
      const plans = await tx
        .select({ plan: vaccinationPlans, animalName: animals.name, animalStatus: animals.status })
        .from(vaccinationPlans)
        .innerJoin(animals, eq(animals.id, vaccinationPlans.animalId))
        .where(and(inArray(vaccinationPlans.id, b.planIds), inArray(vaccinationPlans.status, OPEN)))
      let sent = 0
      for (const x of plans) {
        if (x.animalStatus !== 'active') continue
        if (await remind(tx, { id: x.plan.animalId, name: x.animalName }, x.plan, true)) sent++
      }
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'reminder', summary: `Aşı hatırlatması kuyruğa alındı: ${sent} satır` })
      return { queued: sent, skipped: b.planIds.length - sent }
    })
  })
}
