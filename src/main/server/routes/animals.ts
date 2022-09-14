// Modül B — Hayvanlar: S-30 liste, S-32 form, S-33 detay, S-34 durum değişiklikleri, S-35 çip uygula, S-36 çip düzelt
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { animalOwners, animals, chipEvents, microchips, owners, petvetTasks, users } from '../../db/schema'
import { AppError, parse, requirePerm, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { listAnimals, listTasks } from '../queries'
import { getSettings } from '../settings'
import { cancelAnimalReminders } from '../services/reminders'
import { animalLastVisitSql } from './owners'
import { validateChip } from '../../../shared/chip'
import { diffDaysIso, petvetDueDate, petvetUrgency, todayIstanbul, type PetvetStatus, type PetvetTaskKind } from '../../../shared/petvet'
import { trTitleCase } from '../../../shared/identity'
import { BODY_SITES, PETVET_SPECIES, type ChipLookupDto, type Species } from '../../../shared/api-types'
import {
  ANIMAL_SOURCES,
  BEHAVIORS,
  DEATH_CAUSES,
  DEATH_CAUSE_LABEL,
  type AnimalDetailFull,
  type AnimalListRow,
  type ChipActionResult,
  type ChipEventRow,
  type HistoryRow,
  type OwnershipRow,
  type StatusResult,
  type TimelineRow,
  type WeightRow,
} from '../../../shared/owners'
import { PETVET_KIND_LABEL } from '../../../shared/petvet'
import type { Db } from '../../db/client'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const SPECIES = ['cat', 'dog', 'ferret', 'bird', 'rabbit', 'rodent', 'reptile', 'other'] as const
const isoDate = (msg = 'Tarih geçersiz.') => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, msg)
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `En fazla ${max} karakter.`)
    .optional()
    .transform((v) => (v ? v : undefined))
const tagList = z
  .array(z.string().trim().max(60))
  .max(30)
  .optional()
  .transform((v) => [...new Set((v ?? []).filter(Boolean))])
const idParam = z.object({ id: z.string().uuid('Geçersiz kayıt.') })

const animalFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Hayvan adı gerekli.').max(40, 'Ad en fazla 40 karakter olabilir.'),
    species: z.enum(SPECIES, { message: 'Tür seçin.' }),
    breed: optText(60),
    sex: z.enum(['male', 'female', 'unknown'], { message: 'Cinsiyet seçin.' }),
    neutered: z.boolean(),
    neuteredAt: isoDate().optional().or(z.literal('').transform(() => undefined)),
    birthDate: isoDate('Doğum tarihi gerekli.'),
    birthDateEstimated: z.boolean(),
    color: optText(60),
    marks: optText(200),
    passportNo: optText(40),
    bloodGroup: optText(20),
    allergies: tagList,
    chronicDiseases: tagList,
    behavior: z.enum(BEHAVIORS).optional().or(z.literal('').transform(() => undefined)),
    diet: optText(500),
    source: z.enum(ANIMAL_SOURCES).optional().or(z.literal('').transform(() => undefined)),
    sourceDetail: optText(120),
    notes: optText(4000),
  })
  .superRefine((d, ctx) => {
    if (PETVET_SPECIES.includes(d.species as Species) && !d.color) {
      ctx.addIssue({ code: 'custom', path: ['color'], message: 'Kedi, köpek ve gelincikte renk / desen zorunlu (PETVET).' })
    }
    if (d.source === 'adoption' && !d.sourceDetail) {
      ctx.addIssue({ code: 'custom', path: ['sourceDetail'], message: 'Sahiplenmede barınak / belediye adını yazın.' })
    }
    if (d.neuteredAt && !d.neutered) ctx.addIssue({ code: 'custom', path: ['neuteredAt'], message: 'Kısırlaştırma tarihi için "kısır" işaretlenmeli.' })
  })

const animalCreateSchema = z.intersection(
  animalFormSchema,
  z.object({
    ownerId: z.string().uuid('Sahip seçin.'),
    weightKg: z.number().min(0.01, 'Kilo 0,01–150 kg arasında olmalı.').max(150, 'Kilo 0,01–150 kg arasında olmalı.').optional(),
  }),
)
const animalUpdateSchema = z.intersection(animalFormSchema, z.object({ version: z.number().int().positive() }))

function isUniqueViolation(e: unknown, constraint: string) {
  const err = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string })
  return err?.code === '23505' && err?.constraint === constraint
}

function mapUniqueErrors(e: unknown): never {
  if (isUniqueViolation(e, 'animals_passport_uq')) throw new AppError(409, 'Bu pasaport numarası başka bir hayvanda kayıtlı.', 'PASSPORT_EXISTS')
  if (isUniqueViolation(e, 'microchips_chip_no_uq')) throw new AppError(409, 'Bu çip klinikte başka bir hayvana kayıtlı.', 'CHIP_EXISTS')
  throw e
}

function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

/** PETVET görevi açılabilir mi: kapsamdaki tür + aktif ISO çip (test çipi değil) */
async function petvetChip(tx: Tx, animalId: string, species: string) {
  if (!PETVET_SPECIES.includes(species as Species)) return null
  const [mc] = await tx
    .select()
    .from(microchips)
    .where(and(eq(microchips.animalId, animalId), eq(microchips.status, 'active')))
    .orderBy(sql`${microchips.createdAt} desc`)
    .limit(1)
  if (!mc) return null
  const v = validateChip(mc.chipNo)
  if (!v.ok || v.format !== 'iso' || v.codeKind === 'test') return null
  return mc
}

async function primaryOwnerId(tx: Tx, animalId: string): Promise<string | null> {
  const r = await tx.execute<{ owner_id: string }>(
    sql`select owner_id from animal_owners where animal_id = ${animalId} and to_date is null order by is_primary desc, from_date desc limit 1`,
  )
  return r.rows[0]?.owner_id ?? null
}

async function openTask(
  tx: Tx,
  t: { kind: PetvetTaskKind; animalId: string; ownerId: string | null; vetId?: string | null; sourceType: string; sourceId?: string | null; eventDate: string; note?: string },
) {
  const settings = await getSettings(tx)
  let missing: string[] = []
  if (t.ownerId) {
    const [o] = await tx.select({ tcknHash: owners.tcknHash }).from(owners).where(eq(owners.id, t.ownerId)).limit(1)
    if (!o?.tcknHash) missing = ['owner.tckn']
  } else missing = ['owner']
  const [task] = await tx
    .insert(petvetTasks)
    .values({
      kind: t.kind,
      animalId: t.animalId,
      ownerId: t.ownerId,
      vetId: t.vetId ?? null,
      sourceType: t.sourceType,
      sourceId: t.sourceId ?? null,
      eventDate: t.eventDate,
      dueDate: petvetDueDate(t.kind, t.eventDate, settings.petvet.days),
      status: missing.length ? 'missing_info' : 'pending',
      missingFields: missing,
      note: t.note ?? null,
    })
    .returning()
  return task
}

function result(task: typeof petvetTasks.$inferSelect | null | undefined, warnings?: string[]): StatusResult {
  return {
    ok: true,
    petvetTaskId: task?.id ?? null,
    petvetKind: (task?.kind as PetvetTaskKind) ?? null,
    petvetStatus: (task?.status as PetvetStatus) ?? null,
    dueDate: task?.dueDate ?? null,
    ...(warnings?.length ? { warnings } : {}),
  }
}

export function animalRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const today = () => deps.today?.() ?? todayIstanbul()
  const now = () => deps.now?.() ?? new Date()

  async function lockAnimal(tx: Tx, id: string) {
    const [a] = await tx.select().from(animals).where(eq(animals.id, id)).for('update').limit(1)
    if (!a || a.deletedAt) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
    return a
  }

  async function setStatus(tx: Tx, a: typeof animals.$inferSelect, to: string, date: string, userId: string) {
    await tx
      .update(animals)
      .set({ status: to, statusDate: date, updatedAt: now(), version: sql`${animals.version} + 1` })
      .where(eq(animals.id, a.id))
    await tx.execute(sql`update animals set updated_by = ${userId} where id = ${a.id}`)
  }

  async function statusEvent(tx: Tx, animalId: string, kind: string, date: string, from: string, to: string, data: unknown, userId: string) {
    await tx.execute(sql`insert into animal_status_events (animal_id, kind, event_date, from_status, to_status, data, user_id, at)
      values (${animalId}, ${kind}, ${date}, ${from}, ${to}, ${JSON.stringify(data)}::jsonb, ${userId}, ${now().toISOString()})`)
  }

  function checkDate(date: string, label: string, birthDate?: string | null) {
    if (date > today()) throw new AppError(400, `${label} ileri bir tarih olamaz.`, 'VALIDATION')
    if (birthDate && date < birthDate) throw new AppError(400, `${label} doğum tarihinden önce olamaz.`, 'VALIDATION')
  }

  /* ---------- S-30 liste ---------- */
  app.get('/api/animals', async (req) => {
    requirePerm(req, 'animals.read')
    const f = parse(
      z.object({
        q: z.string().optional(),
        status: z.string().optional(),
        species: z.enum(SPECIES).optional(),
        chip: z.enum(['yes', 'no']).optional(),
        chipless: z.enum(['true', 'false', '1', '0']).optional(),
        risk6m: z.enum(['1', '0']).optional(),
        petvet: z.enum(['open', 'overdue']).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    )
    const t = today()
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    const where = ['a.deleted_at is null']
    const status = f.status ?? 'active'
    if (status !== 'all') where.push(`a.status = ${p(status)}`)
    if (f.species) where.push(`a.species = ${p(f.species)}`)
    const chipless = f.chip === 'no' || f.chipless === 'true' || f.chipless === '1'
    if (chipless) where.push(`mc.chip_no is null`)
    if (f.chip === 'yes') where.push(`mc.chip_no is not null`)
    if (f.risk6m === '1') where.push(`mc.chip_no is null and a.birth_date <= ${p(t)}::date - interval '6 months'`)
    if (f.petvet === 'open') where.push(`pt.status is not null`)
    if (f.petvet === 'overdue') where.push(`pt.due_date < ${p(t)}::date`)
    const q = f.q?.trim()
    if (q) {
      const digits = q.replace(/\D/g, '')
      if (digits.length >= 4 && digits.length === q.replace(/[\s()+-]/g, '').length) {
        where.push(`(mc.chip_no like ${p('%' + digits + '%')} or o.phone like ${p('%' + digits.replace(/^0/, '') + '%')} or exists (
          select 1 from microchips m2 where m2.animal_id = a.id and m2.chip_no like ${p('%' + digits + '%')}))`)
      } else {
        const like = p('%' + q + '%')
        where.push(`(pk_norm(a.name) like pk_norm(${like}) or pk_norm(o.first_name || ' ' || o.last_name) like pk_norm(${like}) or a.passport_no ilike ${like})`)
      }
    }
    const lastVisit = await animalLastVisitSql(db, 'a.id')
    const r = await db.$client.query(
      `select a.id, a.name, a.species, a.breed, a.sex, a.neutered, a.birth_date, a.status, a.passport_no, a.allergies, a.behavior,
              mc.chip_no, o.id as owner_id, o.first_name || ' ' || o.last_name as owner_name, o.phone as owner_phone,
              pt.status as pt_status, pt.due_date as pt_due, ${lastVisit} as last_visit
       from animals a
       left join lateral (select chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1) mc on true
       left join lateral (
         select o.* from animal_owners ao join owners o on o.id = ao.owner_id
         where ao.animal_id = a.id and ao.to_date is null order by ao.is_primary desc limit 1
       ) o on true
       left join lateral (
         select status, due_date from petvet_tasks t where t.animal_id = a.id and t.status in ('pending','missing_info') order by t.due_date limit 1
       ) pt on true
       where ${where.join(' and ')}
       order by a.updated_at desc
       limit ${f.limit ?? 50} offset ${f.offset ?? 0}`,
      params,
    )
    return r.rows.map(
      (x): AnimalListRow => ({
        id: x.id,
        name: x.name,
        species: x.species,
        breed: x.breed,
        sex: x.sex,
        neutered: x.neutered,
        birthDate: x.birth_date,
        status: x.status,
        chipNo: x.chip_no,
        passportNo: x.passport_no,
        ownerId: x.owner_id,
        ownerName: x.owner_name,
        ownerPhone: x.owner_phone,
        allergies: x.allergies ?? [],
        behavior: x.behavior,
        lastVisit: toIsoDate(x.last_visit),
        petvet: x.pt_status && x.pt_due ? { status: x.pt_status, dueDate: x.pt_due, ...petvetUrgency(x.pt_due, t) } : null,
      }),
    )
  })

  /* ---------- S-32 yeni hayvan (çipsiz de olabilir) ---------- */
  app.post('/api/animals', async (req) => {
    const u = requirePerm(req, 'animals.write')
    const b = parse(animalCreateSchema, req.body)
    checkDate(b.birthDate, 'Doğum tarihi')
    if (b.neuteredAt) checkDate(b.neuteredAt, 'Kısırlaştırma tarihi', b.birthDate)
    try {
      return await db.transaction(async (tx) => {
        const [o] = await tx.select({ id: owners.id, deletedAt: owners.deletedAt }).from(owners).where(eq(owners.id, b.ownerId)).limit(1)
        if (!o || o.deletedAt) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
        const [a] = await tx
          .insert(animals)
          .values({
            name: trTitleCase(b.name),
            species: b.species,
            breed: b.breed ?? null,
            sex: b.sex,
            neutered: b.neutered,
            neuteredAt: b.neuteredAt ?? null,
            birthDate: b.birthDate,
            birthDateEstimated: b.birthDateEstimated,
            color: b.color ?? null,
            marks: b.marks ?? null,
            passportNo: b.passportNo ?? null,
            allergies: b.allergies,
            behavior: b.behavior ?? null,
            source: b.source ?? null,
            notes: b.notes ?? null,
            createdBy: u.id,
          })
          .returning()
        await tx.execute(sql`update animals set chronic_diseases = ${sql.param(b.chronicDiseases)}::text[], blood_group = ${b.bloodGroup ?? null},
            diet = ${b.diet ?? null}, source_detail = ${b.sourceDetail ?? null}, updated_by = ${u.id} where id = ${a.id}`)
        await tx.insert(animalOwners).values({ animalId: a.id, ownerId: b.ownerId, isPrimary: true, fromDate: today() })
        if (b.weightKg) {
          await tx.execute(sql`insert into animal_weights (animal_id, kg, measured_at, source, user_id) values (${a.id}, ${b.weightKg}, ${now().toISOString()}, 'manual', ${u.id})`)
        }
        await writeAudit(tx, { userId: u.id, action: 'create', entity: 'animal', entityId: a.id, summary: `${a.name} (çipsiz kayıt)` })
        return { id: a.id }
      })
    } catch (e) {
      mapUniqueErrors(e)
    }
  })

  /* ---------- S-33 detay ---------- */
  app.get('/api/animals/:id', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(idParam, req.params)
    const ar = await db.$client.query(
      `select a.*, cu.full_name as created_by_name, uu.full_name as updated_by_name
       from animals a left join users cu on cu.id = a.created_by left join users uu on uu.id = a.updated_by
       where a.id = $1 and a.deleted_at is null`,
      [id],
    )
    const a = ar.rows[0]
    if (!a) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
    const ownersR = await db.$client.query(
      `select o.id, o.first_name || ' ' || o.last_name as full_name, o.phone, ao.is_primary, o.tckn_last4
       from animal_owners ao join owners o on o.id = ao.owner_id
       where ao.animal_id = $1 and ao.to_date is null order by ao.is_primary desc, ao.from_date desc`,
      [id],
    )
    const chips = await db
      .select({
        id: microchips.id,
        chipNo: microchips.chipNo,
        format: microchips.format,
        implantedAt: microchips.implantedAt,
        implantedByName: users.fullName,
        bodySite: microchips.bodySite,
        lotNo: microchips.lotNo,
        status: microchips.status,
        createdAt: microchips.createdAt,
      })
      .from(microchips)
      .leftJoin(users, eq(users.id, microchips.implantedBy))
      .where(eq(microchips.animalId, id))
      .orderBy(microchips.createdAt)
    const evR = await db.$client.query(
      `select e.id, m.chip_no, e.kind, e.data, e.created_at as at, u.full_name as user_name
       from chip_events e join microchips m on m.id = e.microchip_id left join users u on u.id = e.user_id
       where m.animal_id = $1 order by e.created_at desc`,
      [id],
    )
    const wR = await db.$client.query(`select kg, measured_at from animal_weights where animal_id = $1 order by measured_at desc limit 1`, [id])
    const tasks = await listTasks(db, today(), { filter: 'all', animalId: id })
    const detail: AnimalDetailFull = {
      id: a.id,
      name: a.name,
      species: a.species,
      breed: a.breed,
      sex: a.sex,
      neutered: a.neutered,
      neuteredAt: a.neutered_at,
      birthDate: a.birth_date,
      birthDateEstimated: a.birth_date_estimated,
      color: a.color,
      marks: a.marks,
      passportNo: a.passport_no,
      status: a.status,
      statusDate: a.status_date,
      allergies: a.allergies ?? [],
      chronicDiseases: a.chronic_diseases ?? [],
      behavior: a.behavior,
      bloodGroup: a.blood_group,
      diet: a.diet,
      source: a.source,
      sourceDetail: a.source_detail,
      notes: a.notes,
      version: a.version,
      createdAt: new Date(a.created_at).toISOString(),
      updatedAt: new Date(a.updated_at).toISOString(),
      createdByName: a.created_by_name,
      updatedByName: a.updated_by_name,
      lastWeight: wR.rows[0] ? { kg: Number(wR.rows[0].kg), measuredAt: new Date(wR.rows[0].measured_at).toISOString() } : null,
      owners: ownersR.rows.map((o) => ({ id: o.id, fullName: o.full_name, phone: o.phone, isPrimary: o.is_primary, tcknLast4: o.tckn_last4 })),
      chips: chips.map(({ lotNo: _l, createdAt: _c, ...c }) => c),
      chipsFull: chips.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
      chipEvents: evR.rows.map(
        (e): ChipEventRow => ({ id: e.id, chipNo: e.chip_no, kind: e.kind, data: e.data ?? {}, at: new Date(e.at).toISOString(), userName: e.user_name }),
      ),
      petvetTasks: tasks,
    }
    return detail
  })

  /* ---------- S-32 düzenle (iyimser kilit) ---------- */
  app.put('/api/animals/:id', async (req) => {
    const u = requirePerm(req, 'animals.write')
    const { id } = parse(idParam, req.params)
    const b = parse(animalUpdateSchema, req.body)
    checkDate(b.birthDate, 'Doğum tarihi')
    if (b.neuteredAt) checkDate(b.neuteredAt, 'Kısırlaştırma tarihi', b.birthDate)
    try {
      return await db.transaction(async (tx) => {
        const cur = await lockAnimal(tx, id)
        if (cur.version !== b.version) {
          const r = await tx.execute<{ full_name: string | null }>(sql`select u.full_name from animals a left join users u on u.id = a.updated_by where a.id = ${id}`)
          const by = r.rows[0]?.full_name
          throw new AppError(409, `Bu kayıt ${by ? by + ' tarafından ' : ''}siz düzenlerken değiştirildi. Kaydı yeniden yükleyin.`, 'VERSION_CONFLICT', {
            version: cur.version,
            updatedAt: cur.updatedAt.toISOString(),
            updatedByName: by ?? null,
          })
        }
        const next = {
          name: trTitleCase(b.name),
          species: b.species,
          breed: b.breed ?? null,
          sex: b.sex,
          neutered: b.neutered,
          neuteredAt: b.neuteredAt ?? null,
          birthDate: b.birthDate,
          birthDateEstimated: b.birthDateEstimated,
          color: b.color ?? null,
          marks: b.marks ?? null,
          passportNo: b.passportNo ?? null,
          allergies: b.allergies,
          behavior: b.behavior ?? null,
          source: b.source ?? null,
          notes: b.notes ?? null,
        }
        const diff: Record<string, [unknown, unknown]> = {}
        for (const [k, v] of Object.entries(next)) {
          const old = (cur as Record<string, unknown>)[k] ?? null
          if (JSON.stringify(old) !== JSON.stringify(v)) diff[k] = [old, v]
        }
        await tx
          .update(animals)
          .set({ ...next, updatedAt: now(), version: sql`${animals.version} + 1` })
          .where(eq(animals.id, id))
        await tx.execute(sql`update animals set chronic_diseases = ${sql.param(b.chronicDiseases)}::text[], blood_group = ${b.bloodGroup ?? null},
            diet = ${b.diet ?? null}, source_detail = ${b.sourceDetail ?? null}, updated_by = ${u.id} where id = ${id}`)
        await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: next.name, diff: Object.keys(diff).length ? diff : undefined })
        return { id, version: cur.version + 1 }
      })
    } catch (e) {
      mapUniqueErrors(e)
    }
  })

  /* ---------- Özet zaman çizelgesi ---------- */
  app.get('/api/animals/:id/timeline', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query(
      `select * from (
         select e.created_at as at, 'chip' as kind, e.kind as sub, m.chip_no as detail, e.data, u.full_name as user_name, null as pstatus
           from chip_events e join microchips m on m.id = e.microchip_id left join users u on u.id = e.user_id where m.animal_id = $1
         union all
         select s.at, 'status', s.kind, s.event_date::text, s.data, u.full_name, null
           from animal_status_events s left join users u on u.id = s.user_id where s.animal_id = $1
         union all
         select t.created_at, 'petvet', t.kind, t.due_date::text, '{}'::jsonb, null, 'opened'
           from petvet_tasks t where t.animal_id = $1
         union all
         select t.done_at, 'petvet', t.kind, t.petvet_ref, '{}'::jsonb, u.full_name, t.status
           from petvet_tasks t left join users u on u.id = t.done_by where t.animal_id = $1 and t.status = 'done' and t.done_at is not null
         union all
         select w.measured_at, 'weight', w.source, w.kg::text, '{}'::jsonb, u.full_name, null
           from animal_weights w left join users u on u.id = w.user_id where w.animal_id = $1
         union all
         select a.created_at, 'create', '', '', '{}'::jsonb, u.full_name, null
           from animals a left join users u on u.id = a.created_by where a.id = $1
       ) x order by at desc limit 50`,
      [id],
    )
    const STATUS_TITLE: Record<string, string> = { death: 'Ölüm kaydı', lost: 'Kayıp bildirimi', found: 'Bulundu', transfer: 'Sahip devri' }
    const CHIP_TITLE: Record<string, string> = { IMPLANT: 'Çip uygulandı', CORRECTION: 'Çip numarası düzeltildi', DEACTIVATE: 'Çip pasif yapıldı' }
    return r.rows.map((x): TimelineRow => {
      const d = (x.data ?? {}) as Record<string, string>
      let title = ''
      let detail = ''
      let petvetStatus: PetvetStatus | undefined
      switch (x.kind) {
        case 'chip':
          title = CHIP_TITLE[x.sub] ?? x.sub
          detail = x.sub === 'CORRECTION' ? `${d.oldChipNo ?? ''} → ${x.detail}${d.reason ? ' · ' + d.reason : ''}` : `${x.detail}${d.bodySite ? ' · ' + d.bodySite : ''}`
          break
        case 'status':
          title = STATUS_TITLE[x.sub] ?? x.sub
          detail = [
            x.sub === 'death' && d.cause ? DEATH_CAUSE_LABEL[d.cause as keyof typeof DEATH_CAUSE_LABEL] : null,
            x.sub === 'transfer' ? `${d.fromOwnerName ?? ''} → ${d.toOwnerName ?? ''}` : null,
            x.sub === 'lost' ? [d.city, d.district, d.place].filter(Boolean).join(' / ') : null,
            d.note || d.reason || null,
          ]
            .filter(Boolean)
            .join(' · ')
          break
        case 'petvet':
          if (x.pstatus === 'opened') {
            title = `PETVET görevi: ${PETVET_KIND_LABEL[x.sub as PetvetTaskKind] ?? x.sub}`
            detail = `son gün ${x.detail ? x.detail.split('-').reverse().join('.') : ''}`
          } else {
            title = `PETVET'e girildi: ${PETVET_KIND_LABEL[x.sub as PetvetTaskKind] ?? x.sub}`
            detail = x.detail ? `referans ${x.detail}` : ''
            petvetStatus = 'done'
          }
          break
        case 'weight':
          title = 'Kilo ölçümü'
          detail = `${String(Number(x.detail)).replace('.', ',')} kg${x.sub === 'visit' ? ' (muayene)' : ''}`
          break
        case 'create':
          title = 'Kayıt oluşturuldu'
          break
      }
      return { at: new Date(x.at).toISOString(), kind: x.kind, title, detail, userName: x.user_name, ...(petvetStatus ? { petvetStatus } : {}) }
    })
  })

  /* ---------- Kilo ---------- */
  app.get('/api/animals/:id/weights', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query(
      `select w.id, w.kg, w.measured_at, w.source, u.full_name as user_name
       from animal_weights w left join users u on u.id = w.user_id where w.animal_id = $1 order by w.measured_at desc limit 500`,
      [id],
    )
    return r.rows.map((x): WeightRow => ({ id: x.id, kg: Number(x.kg), measuredAt: new Date(x.measured_at).toISOString(), source: x.source, userName: x.user_name }))
  })

  app.post('/api/animals/:id/weights', async (req) => {
    const u = requirePerm(req, 'animals.write')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z.object({
        kg: z.number({ message: 'Kilo girin.' }).min(0.01, 'Kilo 0,01–150 kg arasında olmalı.').max(150, 'Kilo 0,01–150 kg arasında olmalı.'),
        date: isoDate().optional(),
        confirm: z.boolean().optional(),
      }),
      req.body,
    )
    if (b.date) checkDate(b.date, 'Ölçüm tarihi')
    return db.transaction(async (tx) => {
      const a = await lockAnimal(tx, id)
      const prev = await tx.execute<{ kg: string }>(sql`select kg from animal_weights where animal_id = ${id} order by measured_at desc limit 1`)
      const last = prev.rows[0] ? Number(prev.rows[0].kg) : null
      if (last && !b.confirm && Math.abs(b.kg - last) / last > 0.3) {
        throw new AppError(409, `Önceki ölçüm ${String(last).replace('.', ',')} kg. Fark %30'dan fazla — emin misiniz?`, 'CONFIRM_REQUIRED', { previousKg: last })
      }
      const at = b.date && b.date !== today() ? new Date(b.date + 'T12:00:00+03:00') : now()
      const r = await tx.execute<{ id: string }>(
        sql`insert into animal_weights (animal_id, kg, measured_at, source, user_id) values (${id}, ${b.kg}, ${at.toISOString()}, 'manual', ${u.id}) returning id`,
      )
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'animal', entityId: id, summary: `${a.name}: kilo ${b.kg} kg` })
      return { id: r.rows[0].id }
    })
  })

  /* ---------- Sahiplik geçmişi ---------- */
  app.get('/api/animals/:id/ownership', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query(
      `select ao.owner_id, o.first_name || ' ' || o.last_name as owner_name, o.phone, ao.is_primary, ao.from_date, ao.to_date, ao.end_reason
       from animal_owners ao join owners o on o.id = ao.owner_id where ao.animal_id = $1
       order by (ao.to_date is null) desc, ao.from_date desc`,
      [id],
    )
    return r.rows.map(
      (x): OwnershipRow => ({
        ownerId: x.owner_id,
        ownerName: x.owner_name,
        phone: x.phone,
        isPrimary: x.is_primary,
        fromDate: x.from_date,
        toDate: x.to_date,
        endReason: x.end_reason,
      }),
    )
  })

  /* ---------- Geçmiş (audit) ---------- */
  app.get('/api/animals/:id/history', async (req) => {
    requirePerm(req, 'animals.read')
    const { id } = parse(idParam, req.params)
    const r = await db.$client.query(
      `select l.id, l.created_at as at, l.action, l.entity, l.summary, u.full_name as user_name
       from audit_logs l left join users u on u.id = l.user_id
       where l.entity = 'animal' and l.entity_id = $1 order by l.id desc limit 200`,
      [id],
    )
    return r.rows.map(
      (x): HistoryRow => ({ id: Number(x.id), at: new Date(x.at).toISOString(), action: x.action, entity: x.entity, summary: x.summary, userName: x.user_name }),
    )
  })

  /* ---------- S-34 Ölüm ---------- */
  app.post('/api/animals/:id/death', async (req) => {
    const u = requirePerm(req, 'animals.status', 'animals.death')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z.object({
        date: isoDate('Ölüm tarihi gerekli.'),
        cause: z.enum(DEATH_CAUSES, { message: 'Ölüm nedenini seçin.' }),
        note: optText(1000),
        confirm: z.boolean().refine((v) => v, 'Geri alınamaz işlemi onaylayın.'),
      }),
      req.body,
    )
    return db.transaction(async (tx) => {
      const a = await lockAnimal(tx, id)
      if (a.status === 'dead') throw new AppError(409, 'Bu hayvan için ölüm kaydı zaten var.', 'INVALID_STATUS')
      checkDate(b.date, 'Ölüm tarihi', a.birthDate)
      await setStatus(tx, a, 'dead', b.date, u.id)
      await statusEvent(tx, id, 'death', b.date, a.status, 'dead', { cause: b.cause, note: b.note }, u.id)
      await cancelAnimalReminders(tx, id, 'Hayvan öldü')
      // ⚠️ Gelecek randevuların iptali randevu modülüne (E) bağlı; burada yapılmıyor.
      const chip = await petvetChip(tx, id, a.species)
      const task = chip
        ? await openTask(tx, { kind: 'DEATH', animalId: id, ownerId: await primaryOwnerId(tx, id), sourceType: 'animal_status', eventDate: b.date })
        : null
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: `${a.name}: ölüm kaydı (${DEATH_CAUSE_LABEL[b.cause]})` })
      return result(task)
    })
  })

  /* ---------- S-34 Kayıp ---------- */
  app.post('/api/animals/:id/lost', async (req) => {
    const u = requirePerm(req, 'animals.status')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z.object({
        date: isoDate('Kayıp tarihi gerekli.'),
        city: optText(60),
        district: optText(60),
        place: optText(300),
        note: optText(1000),
        openPetvet: z.boolean().optional(),
      }),
      req.body,
    )
    return db.transaction(async (tx) => {
      const a = await lockAnimal(tx, id)
      if (a.status !== 'active') throw new AppError(409, 'Yalnızca aktif bir hayvan kayıp bildirilebilir.', 'INVALID_STATUS')
      checkDate(b.date, 'Kayıp tarihi', a.birthDate)
      await setStatus(tx, a, 'lost', b.date, u.id)
      await statusEvent(tx, id, 'lost', b.date, a.status, 'lost', { city: b.city, district: b.district, place: b.place, note: b.note }, u.id)
      const chip = b.openPetvet === false ? null : await petvetChip(tx, id, a.species)
      const task = chip ? await openTask(tx, { kind: 'LOST', animalId: id, ownerId: await primaryOwnerId(tx, id), sourceType: 'animal_status', eventDate: b.date }) : null
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: `${a.name}: kayıp bildirildi` })
      return result(task)
    })
  })

  /* ---------- S-34 Bulundu ---------- */
  app.post('/api/animals/:id/found', async (req) => {
    const u = requirePerm(req, 'animals.status')
    const { id } = parse(idParam, req.params)
    const b = parse(z.object({ date: isoDate('Bulunma tarihi gerekli.'), note: optText(1000) }), req.body)
    return db.transaction(async (tx) => {
      const a = await lockAnimal(tx, id)
      if (a.status !== 'lost') throw new AppError(409, 'Hayvan kayıp durumunda değil.', 'INVALID_STATUS')
      checkDate(b.date, 'Bulunma tarihi', a.statusDate)
      await setStatus(tx, a, 'active', b.date, u.id)
      await statusEvent(tx, id, 'found', b.date, 'lost', 'active', { note: b.note }, u.id)
      // Açık LOST görevi (henüz PETVET'e girilmemiş) iptal edilir; kayıp PETVET'e girilmişse FOUND görevi açılır.
      const cancelled = await tx
        .update(petvetTasks)
        .set({ status: 'cancelled', cancelReason: 'Hayvan bulundu', updatedAt: now() })
        .where(and(eq(petvetTasks.animalId, id), eq(petvetTasks.kind, 'LOST'), inArray(petvetTasks.status, ['pending', 'missing_info'])))
        .returning({ id: petvetTasks.id })
      const doneLost = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from petvet_tasks where animal_id = ${id} and kind = 'LOST' and status = 'done'
            and event_date >= coalesce(${a.statusDate}::date, '1900-01-01'::date)`,
      )
      let task = null
      if (Number(doneLost.rows[0].n) > 0) {
        const chip = await petvetChip(tx, id, a.species)
        if (chip) task = await openTask(tx, { kind: 'FOUND', animalId: id, ownerId: await primaryOwnerId(tx, id), sourceType: 'animal_status', eventDate: b.date })
      }
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'animal',
        entityId: id,
        summary: `${a.name}: bulundu${cancelled.length ? ' · açık kayıp görevi iptal edildi' : ''}`,
      })
      return { ...result(task), cancelledTasks: cancelled.length }
    })
  })

  /* ---------- S-34 Devir ---------- */
  app.post('/api/animals/:id/transfer', async (req) => {
    const u = requirePerm(req, 'animals.status')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z.object({
        date: isoDate('Devir tarihi gerekli.'),
        newOwnerId: z.string().uuid('Yeni sahibi seçin.'),
        reason: optText(300),
        removeOldOwners: z.boolean().optional(),
      }),
      req.body,
    )
    return db.transaction(async (tx) => {
      const a = await lockAnimal(tx, id)
      if (a.status !== 'active') throw new AppError(409, 'Yalnızca aktif bir hayvan devredilebilir.', 'INVALID_STATUS')
      checkDate(b.date, 'Devir tarihi', a.birthDate)
      const [no] = await tx.select().from(owners).where(eq(owners.id, b.newOwnerId)).limit(1)
      if (!no || no.deletedAt) throw new AppError(404, 'Yeni sahip bulunamadı.', 'NOT_FOUND')
      if (!no.kvkkNoticeAt) throw new AppError(409, 'Yeni sahibe KVKK aydınlatma metni verilmemiş. Önce sahip kaydını tamamlayın.', 'KVKK_REQUIRED')
      const cur = await tx.execute<{ owner_id: string; from_date: string; name: string }>(
        sql`select ao.owner_id, ao.from_date::text, o.first_name || ' ' || o.last_name as name
            from animal_owners ao join owners o on o.id = ao.owner_id where ao.animal_id = ${id} and ao.to_date is null`,
      )
      if (cur.rows.some((r) => r.owner_id === b.newOwnerId)) throw new AppError(400, 'Seçilen kişi zaten bu hayvanın sahibi.', 'VALIDATION')
      if (cur.rows.some((r) => r.from_date > b.date)) throw new AppError(400, 'Devir tarihi mevcut sahipliğin başlangıcından önce olamaz.', 'VALIDATION')
      const remove = b.removeOldOwners ?? true
      if (remove) {
        await tx.execute(sql`update animal_owners set to_date = ${b.date}, end_reason = ${b.reason ?? 'Devir'}
            where animal_id = ${id} and to_date is null`)
      } else {
        await tx.execute(sql`update animal_owners set is_primary = false where animal_id = ${id} and to_date is null`)
      }
      await tx.execute(sql`insert into animal_owners (animal_id, owner_id, is_primary, from_date) values (${id}, ${b.newOwnerId}, true, ${b.date})
          on conflict (animal_id, owner_id, from_date) do update set to_date = null, is_primary = true, end_reason = null`)
      await tx.update(animals).set({ updatedAt: now(), version: sql`${animals.version} + 1` }).where(eq(animals.id, id))
      const toName = `${no.firstName} ${no.lastName}`
      const fromName = cur.rows.map((r) => r.name).join(', ')
      await statusEvent(tx, id, 'transfer', b.date, 'active', 'active', { fromOwnerName: fromName, toOwnerName: toName, toOwnerId: no.id, reason: b.reason, removeOldOwners: remove }, u.id)
      // Hatırlatmalar eski sahip adına planlanmıştı; iptal edilir (yeni sahip için yeniden planlama ilgili modüllerde)
      await cancelAnimalReminders(tx, id, 'Sahip devri')
      const chip = await petvetChip(tx, id, a.species)
      const task = chip ? await openTask(tx, { kind: 'TRANSFER', animalId: id, ownerId: no.id, sourceType: 'animal_status', eventDate: b.date }) : null
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'animal', entityId: id, summary: `${a.name}: devir ${fromName} → ${toName}` })
      return result(task)
    })
  })

  /* ---------- S-35 Çip uygula / ikinci çip ---------- */
  app.post('/api/animals/:id/chips', async (req) => {
    const u = requirePerm(req, 'chips.implant')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z
        .object({
          chipNo: z.string().min(1, 'Çip numarası gerekli.'),
          date: isoDate('Uygulama tarihi gerekli.'),
          vetId: z.string().uuid('Uygulayan hekimi seçin.'),
          bodySite: z.enum(BODY_SITES, { message: 'Vücut bölgesini seçin.' }),
          bodySiteReason: optText(200),
          lotNo: optText(40),
          passportNo: optText(40),
          verified: z.boolean().refine((v) => v, 'Uygulamadan sonra çipin tekrar okutulduğunu onaylayın.'),
          second: z.boolean().optional(),
        })
        .refine((d) => d.bodySite === 'Boyun sol' || !!d.bodySiteReason, { message: 'Varsayılan dışındaki bölge için nedeni yazın.', path: ['bodySiteReason'] }),
      req.body,
    )
    const chip = validateChip(b.chipNo)
    if (!chip.ok) throw new AppError(400, chip.error, 'INVALID_CHIP')
    if (b.date > today()) throw new AppError(400, 'Uygulama tarihi ileri bir tarih olamaz.', 'VALIDATION')
    const warnings = [...chip.warnings]
    if (diffDaysIso(b.date, today()) > 15) warnings.push('Uygulama 15 günden eski: PETVET kayıt süresi geçmiş olabilir.')
    try {
      return await db.transaction(async (tx) => {
        const a = await lockAnimal(tx, id)
        if (a.status === 'dead') throw new AppError(409, 'Ölü kaydedilmiş hayvana çip uygulanamaz.', 'INVALID_STATUS')
        if (a.birthDate && b.date < a.birthDate) throw new AppError(400, 'Uygulama tarihi doğum tarihinden önce olamaz.', 'VALIDATION')
        const [existing] = await tx
          .select({ animalId: microchips.animalId })
          .from(microchips)
          .where(and(eq(microchips.chipNo, chip.value), ne(microchips.status, 'corrected')))
          .limit(1)
        if (existing) {
          const [other] = await listAnimals(db, today(), { ids: [existing.animalId], status: 'all' })
          throw new AppError(409, `Bu çip klinikte ${other ? other.name + ' adlı ' : 'başka bir '}hayvana kayıtlı.`, 'CHIP_EXISTS', { animalId: existing.animalId, animal: other ?? null })
        }
        const [vet] = await tx
          .select({ id: users.id, active: users.active, chamberRegNo: users.chamberRegNo })
          .from(users)
          .where(and(eq(users.id, b.vetId), inArray(users.role, ['vet', 'admin'])))
          .limit(1)
        if (!vet?.active) throw new AppError(400, 'Çipi yalnızca hekim uygulayabilir.', 'VALIDATION')
        if (!vet.chamberRegNo) warnings.push('Uygulayan hekimin oda sicil numarası eksik.')

        const active = await tx.select().from(microchips).where(and(eq(microchips.animalId, id), eq(microchips.status, 'active')))
        if (active.length && !b.second) {
          throw new AppError(409, 'Bu hayvanın aktif çipi var. Yeni çip için "İkinci çip ekle"yi, yanlış numara için "Düzelt"i kullanın.', 'HAS_CHIP')
        }
        for (const old of active) {
          await tx.update(microchips).set({ status: 'inactive' }).where(eq(microchips.id, old.id))
          await tx.insert(chipEvents).values({ microchipId: old.id, kind: 'DEACTIVATE', data: { reason: 'İkinci çip uygulandı', newChipNo: chip.value }, userId: u.id })
        }
        const [mc] = await tx
          .insert(microchips)
          .values({
            chipNo: chip.value,
            format: chip.format,
            animalId: id,
            implantedAt: b.date,
            implantedBy: b.vetId,
            bodySite: b.bodySite,
            lotNo: b.lotNo ?? null,
          })
          .returning()
        await tx.insert(chipEvents).values({
          microchipId: mc.id,
          kind: 'IMPLANT',
          data: { verified: true, warnings, bodySite: b.bodySite, bodySiteReason: b.bodySiteReason, second: !!b.second },
          userId: u.id,
        })
        if (b.passportNo) await tx.update(animals).set({ passportNo: b.passportNo }).where(eq(animals.id, id))
        await tx.update(animals).set({ updatedAt: now(), version: sql`${animals.version} + 1` }).where(eq(animals.id, id))

        let task = null
        if (PETVET_SPECIES.includes(a.species as Species) && chip.format === 'iso' && chip.codeKind !== 'test') {
          // Daha önce PETVET'e girilmiş çip varsa ikinci çip "bilgi düzeltme" olarak bildirilir
          const prevDone = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from petvet_tasks where animal_id = ${id} and kind = 'CHIP_NEW' and status = 'done'`,
          )
          const kind: PetvetTaskKind = b.second && Number(prevDone.rows[0].n) > 0 ? 'UPDATE' : 'CHIP_NEW'
          task = await openTask(tx, { kind, animalId: id, ownerId: await primaryOwnerId(tx, id), vetId: b.vetId, sourceType: 'microchip', sourceId: mc.id, eventDate: b.date })
        }
        await writeAudit(tx, {
          userId: u.id,
          action: 'create',
          entity: 'animal',
          entityId: id,
          summary: `${a.name}: ${b.second ? 'ikinci çip' : 'çip'} uygulandı ${chip.value}`,
        })
        return { ...result(task, warnings), chipId: mc.id } satisfies ChipActionResult
      })
    } catch (e) {
      mapUniqueErrors(e)
    }
  })

  /* ---------- S-36 Çip düzelt (yanlış girilmiş numara) ---------- */
  app.post('/api/chips/:id/correct', async (req) => {
    const u = requirePerm(req, 'chips.correct')
    const { id } = parse(idParam, req.params)
    const b = parse(
      z.object({ newChipNo: z.string().min(1, 'Yeni çip numarası gerekli.'), reason: z.string().trim().min(3, 'Düzeltme nedenini yazın.').max(300) }),
      req.body,
    )
    const chip = validateChip(b.newChipNo)
    if (!chip.ok) throw new AppError(400, chip.error, 'INVALID_CHIP')
    try {
      return await db.transaction(async (tx) => {
        const [old] = await tx.select().from(microchips).where(eq(microchips.id, id)).for('update').limit(1)
        if (!old) throw new AppError(404, 'Çip kaydı bulunamadı.', 'NOT_FOUND')
        if (old.status === 'corrected') throw new AppError(409, 'Bu çip kaydı zaten düzeltilmiş.', 'INVALID_STATUS')
        if (old.chipNo === chip.value) throw new AppError(400, 'Yeni numara eskisiyle aynı.', 'VALIDATION')
        const a = await lockAnimal(tx, old.animalId)
        const [existing] = await tx
          .select({ animalId: microchips.animalId })
          .from(microchips)
          .where(and(eq(microchips.chipNo, chip.value), ne(microchips.status, 'corrected')))
          .limit(1)
        if (existing) {
          const [other] = await listAnimals(db, today(), { ids: [existing.animalId], status: 'all' })
          throw new AppError(409, `Bu çip klinikte ${other ? other.name + ' adlı ' : 'başka bir '}hayvana kayıtlı.`, 'CHIP_EXISTS', { animalId: existing.animalId, animal: other ?? null })
        }
        await tx.update(microchips).set({ status: 'corrected' }).where(eq(microchips.id, old.id))
        const [mc] = await tx
          .insert(microchips)
          .values({
            chipNo: chip.value,
            format: chip.format,
            animalId: old.animalId,
            implantedAt: old.implantedAt,
            implantedBy: old.implantedBy,
            bodySite: old.bodySite,
            lotNo: old.lotNo,
            status: old.status,
          })
          .returning()
        await tx.insert(chipEvents).values({
          microchipId: mc.id,
          kind: 'CORRECTION',
          data: { oldChipId: old.id, oldChipNo: old.chipNo, newChipNo: chip.value, reason: b.reason, warnings: chip.warnings },
          userId: u.id,
        })
        // PETVET: açık CHIP_NEW görevi yeni çipe bağlanır; girilmişse UPDATE görevi açılır
        await tx
          .update(petvetTasks)
          .set({ sourceId: mc.id, updatedAt: now() })
          .where(and(eq(petvetTasks.sourceType, 'microchip'), eq(petvetTasks.sourceId, old.id), inArray(petvetTasks.status, ['pending', 'missing_info'])))
        const [entered] = await tx
          .select({ id: petvetTasks.id })
          .from(petvetTasks)
          .where(and(eq(petvetTasks.sourceType, 'microchip'), eq(petvetTasks.sourceId, old.id), eq(petvetTasks.status, 'done')))
          .limit(1)
        let task = null
        if (entered && PETVET_SPECIES.includes(a.species as Species)) {
          task = await openTask(tx, {
            kind: 'UPDATE',
            animalId: a.id,
            ownerId: await primaryOwnerId(tx, a.id),
            vetId: old.implantedBy,
            sourceType: 'microchip',
            sourceId: mc.id,
            eventDate: today(),
            note: `Çip no düzeltildi: ${old.chipNo} → ${chip.value}`,
          })
        }
        await tx.update(animals).set({ updatedAt: now(), version: sql`${animals.version} + 1` }).where(eq(animals.id, a.id))
        await writeAudit(tx, {
          userId: u.id,
          action: 'update',
          entity: 'animal',
          entityId: a.id,
          summary: `${a.name}: çip düzeltildi ${old.chipNo} → ${chip.value} (${b.reason})`,
        })
        return { ...result(task, chip.warnings), chipId: mc.id } satisfies ChipActionResult
      })
    } catch (e) {
      mapUniqueErrors(e)
    }
  })

  // Okuyucudan gelen numarayı doğrular ve klinikteki kaydı bulur
  app.get('/api/chips/lookup', async (req) => {
    requirePerm(req, 'animals.read')
    const { no } = parse(z.object({ no: z.string().min(1).max(64) }), req.query)
    const validation = validateChip(no)
    let match: ChipLookupDto['match'] = null
    if (validation.ok) {
      const [chip] = await db
        .select({
          id: microchips.id,
          chipNo: microchips.chipNo,
          format: microchips.format,
          implantedAt: microchips.implantedAt,
          implantedByName: users.fullName,
          bodySite: microchips.bodySite,
          status: microchips.status,
          animalId: microchips.animalId,
        })
        .from(microchips)
        .leftJoin(users, eq(users.id, microchips.implantedBy))
        .where(and(eq(microchips.chipNo, validation.value), ne(microchips.status, 'corrected')))
        .orderBy(microchips.createdAt)
        .limit(1)
      if (chip) {
        const [animal] = await listAnimals(db, today(), { ids: [chip.animalId], status: 'all' })
        if (animal) {
          const { animalId: _, ...chipDto } = chip
          match = { animal, chip: chipDto }
        }
      }
    }
    return { validation, match } satisfies ChipLookupDto
  })
}
