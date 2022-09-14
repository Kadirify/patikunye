// Muayene modülü (C) API'si: SOAP muayene, imza + ek/düzeltme versiyonları, tedavi satırları, öneriler.
// SAYFALAR S-40, S-41, S-42, §15.5, §16.3, §17.
import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { AppError, parse, requirePerm, requireUser, type AppDeps, type SessionUser } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import { scheduleReminder, cancelReminders } from '../services/reminders'
import { can } from '../../../shared/permissions'
import { formatDateTr, todayIstanbul } from '../../../shared/petvet'
import type { Db } from '../../db/client'
import type { Sex, Species } from '../../../shared/api-types'
import {
  DOSE_UNITS,
  SYSTEM_KEYS,
  VISIT_TYPES,
  VITAL_LIMITS,
  allergyMatch,
  isPerKg,
  parseDurationDays,
  totalDose,
  type AnimalTreatmentDto,
  type DiagnosisSuggestion,
  type DrugSuggestion,
  type Findings,
  type TreatmentDto,
  type TreatmentKind,
  type VisitAnimalContext,
  type VisitAnimalDto,
  type VisitDetail,
  type VisitDisplayStatus,
  type VisitListItem,
  type VisitListResult,
  type VisitOwnerDto,
  type VisitPhrase,
  type VisitStatus,
  type VisitType,
  type VisitVersionRef,
  type Vitals,
} from '../../../shared/visits'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Ex = Tx | Db

async function all<T>(ex: Ex, q: SQL): Promise<T[]> {
  const r = await (ex as Db).execute(q)
  return (r as unknown as { rows: T[] }).rows
}
async function one<T>(ex: Ex, q: SQL): Promise<T | undefined> {
  return (await all<T>(ex, q))[0]
}
const arr = (v: string[]) => sql`${sql.param(v)}::text[]`
/** drizzle execute() zaman damgalarını metin döndürür ("2026-10-27 07:15:00+00"); Date'e çevirir */
function toDate(d: Date | string): Date {
  if (d instanceof Date) return d
  const s = String(d).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return new Date(s)
}
const iso = (d: Date | string | null) => (d == null ? null : toDate(d).toISOString())
const num = (v: unknown) => (v == null ? null : Number(v))

/** Zincirde imzalı bir halefi olmayan versiyon ("geçerli" versiyon) */
const HEAD = `not exists (select 1 from visits n where n.supersedes_id = v.id and n.deleted_at is null and n.status = 'signed')`
/** Henüz imzalanmamış ek/düzeltme taslakları hariç (önceki imzalı versiyon geçerlidir) */
const CURRENT = `(v.status = 'signed' or v.supersedes_id is null)`

/* ───────────── Doğrulama şemaları ───────────── */

const vital = (key: keyof typeof VITAL_LIMITS, unit = '') => {
  const l = VITAL_LIMITS[key]
  const msg = `${l.label} ${String(l.hard[0]).replace('.', ',')}–${l.hard[1]}${unit} arasında olmalı.`
  return z.number({ message: `${l.label} sayı olmalı.` }).min(l.hard[0], msg).max(l.hard[1], msg).nullable().optional()
}

const vitalsSchema = z.object({
  temp: vital('temp', ' °C'),
  pulse: vital('pulse', ' /dk'),
  resp: vital('resp', ' /dk'),
  weight: vital('weight', ' kg'),
  bcs: vital('bcs').refine((v) => v == null || Number.isInteger(v), 'VKS tam sayı olmalı (1–9).'),
  crt: vital('crt', ' sn'),
  dehydration: vital('dehydration', ' %'),
  mucosa: z.string().trim().max(60).nullable().optional(),
})

const systemSchema = z.object({
  status: z.enum(['normal', 'abnormal'], { message: 'Sistem durumu normal ya da anormal olmalı.' }),
  note: z.string().trim().max(1000, 'Sistem notu çok uzun.').optional(),
})

const findingsSchema = z.object({
  vitals: vitalsSchema.default({}),
  systems: z.object(Object.fromEntries(SYSTEM_KEYS.map((k) => [k, systemSchema.optional()])) as Record<(typeof SYSTEM_KEYS)[number], z.ZodOptional<typeof systemSchema>>).default({}),
})

const optText = (max: number, label: string) => z.string().max(max, `${label} çok uzun.`).nullable().optional()
const textList = (label: string) =>
  z.array(z.string().trim().max(200, `${label} çok uzun.`)).max(30, `En fazla 30 ${label.toLocaleLowerCase('tr-TR')} girilebilir.`).optional()

const treatmentSchema = z.object({
  drug: z.string().trim().min(1, 'İlaç / ürün adını girin.').max(120, 'İlaç adı çok uzun.'),
  activeIngredient: z.string().trim().max(120).nullable().optional(),
  dose: z.number({ message: 'Doz sayı olmalı.' }).positive('Doz sıfırdan büyük olmalı.').max(100000, 'Doz çok büyük.').nullable().optional(),
  doseUnit: z.enum(DOSE_UNITS, { message: 'Doz birimini seçin.' }).nullable().optional(),
  route: z.string().trim().max(20).nullable().optional(),
  frequency: z.string().trim().max(40).nullable().optional(),
  duration: z.string().trim().max(40).nullable().optional(),
  kind: z.enum(['administered', 'prescribed'], { message: 'Klinikte uygulandı / reçete edildi seçin.' }),
  eReceteNo: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  allergyAck: z.boolean().optional(),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih geçersiz.')

const contentSchema = z.object({
  vetId: z.string().uuid('Hekim seçin.').nullable().optional(),
  visitAt: z.iso.datetime({ offset: true, message: 'Muayene tarihi/saati geçersiz.' }).optional(),
  type: z.enum(VISIT_TYPES, { message: 'Muayene türünü seçin.' }).optional(),
  subjective: optText(10000, 'Şikayet / öykü'),
  findings: findingsSchema.optional(),
  assessment: optText(10000, 'Değerlendirme'),
  diagnoses: textList('Tanı'),
  differential: textList('Ayırıcı tanı'),
  planText: optText(10000, 'Plan'),
  tests: optText(4000, 'Tetkikler'),
  ownerAdvice: optText(10000, 'Sahibe öneriler'),
  internalNote: optText(4000, 'İç not'),
  controlDate: isoDate.nullable().optional(),
  treatments: z.array(treatmentSchema).max(50, 'En fazla 50 tedavi satırı girilebilir.').optional(),
})
type ContentInput = z.infer<typeof contentSchema>

const createSchema = contentSchema.extend({
  animalId: z.string().uuid('Hayvan seçin.'),
  appointmentId: z.string().uuid().nullable().optional(),
})
const patchSchema = contentSchema.extend({ rev: z.number().int({ message: 'Revizyon bilgisi eksik.' }) })
const idParam = z.object({ id: z.string().uuid('Geçersiz kayıt.') })

/* ───────────── Satır tipleri ───────────── */

interface VisitRow {
  id: string
  animal_id: string
  vet_id: string | null
  visit_at: Date
  type: VisitType
  appointment_id: string | null
  subjective: string | null
  findings: Partial<Findings> | null
  assessment: string | null
  diagnoses: string[]
  differential: string[]
  plan_text: string | null
  tests: string | null
  owner_advice: string | null
  internal_note: string | null
  control_date: string | null
  status: VisitStatus
  signed_at: Date | null
  signed_by: string | null
  version: number
  supersedes_id: string | null
  root_id: string | null
  amend_reason: string | null
  rev: number
  created_at: Date
  updated_at: Date
  created_by: string | null
  updated_by: string | null
}

interface TreatmentRow {
  id: string
  visit_id: string
  drug: string
  active_ingredient: string | null
  dose: string | null
  dose_unit: string | null
  per_kg: boolean
  total_dose: string | null
  route: string | null
  frequency: string | null
  duration: string | null
  duration_days: number | null
  kind: TreatmentKind
  e_recete_no: string | null
  note: string | null
  allergy_ack: boolean
}

function mapTreatment(r: TreatmentRow): TreatmentDto {
  return {
    id: r.id,
    visitId: r.visit_id,
    drug: r.drug,
    activeIngredient: r.active_ingredient,
    dose: num(r.dose),
    doseUnit: r.dose_unit as TreatmentDto['doseUnit'],
    perKg: r.per_kg,
    totalDose: num(r.total_dose),
    route: r.route,
    frequency: r.frequency,
    duration: r.duration,
    durationDays: r.duration_days,
    kind: r.kind,
    eReceteNo: r.e_recete_no,
    note: r.note,
    allergyAck: r.allergy_ack,
  }
}

function normFindings(f: Partial<Findings> | null | undefined): Findings {
  return { vitals: f?.vitals ?? {}, systems: f?.systems ?? {} }
}

const displayStatus = (status: VisitStatus, version: number): VisitDisplayStatus =>
  status === 'draft' ? 'draft' : version > 1 ? 'amended' : 'signed'

const cleanText = (s: string | null | undefined) => {
  if (s == null) return null
  const t = s.trim()
  return t ? t : null
}
const cleanList = (xs: string[] | undefined) => {
  const out: string[] = []
  for (const x of xs ?? []) {
    const t = x.trim()
    if (t && !out.some((o) => o.toLocaleLowerCase('tr-TR') === t.toLocaleLowerCase('tr-TR'))) out.push(t)
  }
  return out
}

/** Istanbul saatine göre bir anın tarihi */
const dateIstanbul = (d: Date) => todayIstanbul(d)

export function visitsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const today = () => deps.today?.() ?? todayIstanbul()
  const now = () => deps.now?.() ?? new Date()

  /** Muayene içeriğini görebilir mi? Sekreter varsayılan olarak göremez; ayar (visits.secretaryCanRead) ile açılabilir. */
  async function canReadContent(u: SessionUser) {
    if (can(u.role, 'visits.read')) return true
    if (u.role !== 'secretary') return false
    const s = (await getSettings(db)) as unknown as { visits?: { secretaryCanRead?: boolean } }
    return s.visits?.secretaryCanRead === true
  }

  async function loadVisit(ex: Ex, id: string, lock = false): Promise<VisitRow> {
    const r = await one<VisitRow>(ex, sql`select * from visits where id = ${id} and deleted_at is null ${lock ? sql`for update` : sql``}`)
    if (!r) throw new AppError(404, 'Muayene kaydı bulunamadı.', 'NOT_FOUND')
    r.visit_at = toDate(r.visit_at)
    r.created_at = toDate(r.created_at)
    r.updated_at = toDate(r.updated_at)
    if (r.signed_at) r.signed_at = toDate(r.signed_at)
    return r
  }

  async function loadAnimal(ex: Ex, id: string) {
    const a = await one<{ id: string; name: string; allergies: string[]; status: string }>(
      ex,
      sql`select id, name, allergies, status from animals where id = ${id} and deleted_at is null`,
    )
    if (!a) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
    return a
  }

  async function checkVet(ex: Ex, vetId: string) {
    const v = await one<{ id: string }>(ex, sql`select id from users where id = ${vetId} and active and role in ('vet', 'admin')`)
    if (!v) throw new AppError(400, 'Hekim olarak yalnızca aktif bir hekim seçilebilir.', 'VALIDATION')
  }

  async function lastWeight(ex: Ex, animalId: string, excludeVisitIds: string[] = []) {
    const r = await one<{ kg: string; measured_at: Date }>(
      ex,
      sql`select kg, measured_at from animal_weights where animal_id = ${animalId}
          and (visit_id is null or not (visit_id = any(${sql.param(excludeVisitIds)}::uuid[])))
          order by measured_at desc, created_at desc limit 1`,
    )
    return r ? { kg: Number(r.kg), measuredAt: iso(r.measured_at)! } : null
  }

  async function chainIds(ex: Ex, v: Pick<VisitRow, 'id' | 'root_id'>) {
    const rows = await all<{ id: string }>(ex, sql`select id from visits where root_id = ${v.root_id ?? v.id}`)
    return rows.map((r) => r.id)
  }

  /** Muayenedeki kiloyu kilo geçmişine yansıtır (zincir başına tek satır, en güncel versiyondan). */
  async function syncWeight(tx: Tx, v: VisitRow, userId: string) {
    const ids = await chainIds(tx, v)
    await tx.execute(sql`delete from animal_weights where source = 'visit' and visit_id = any(${sql.param(ids)}::uuid[])`)
    const kg = normFindings(v.findings).vitals.weight
    if (kg != null) {
      await tx.execute(
        sql`insert into animal_weights (animal_id, kg, measured_at, source, visit_id, user_id)
            values (${v.animal_id}, ${kg}, ${v.visit_at}, 'visit', ${v.id}, ${userId})`,
      )
    }
  }

  /** İçerik alanlarını yazar (oluşturma ve taslak güncelleme). Tedaviler verilirse tümüyle değiştirilir. */
  async function writeContent(tx: Tx, visitId: string, animal: { id: string }, input: ContentInput, userId: string, bumpRev: boolean) {
    const sets: SQL[] = []
    if (input.vetId !== undefined) {
      if (input.vetId) await checkVet(tx, input.vetId)
      sets.push(sql`vet_id = ${input.vetId}`)
    }
    if (input.visitAt !== undefined) {
      const at = new Date(input.visitAt)
      if (at.getTime() > now().getTime() + 10 * 60_000) throw new AppError(400, 'Muayene tarihi/saati ileri bir zaman olamaz.', 'VALIDATION')
      sets.push(sql`visit_at = ${at}`)
    }
    if (input.type !== undefined) sets.push(sql`type = ${input.type}`)
    if (input.subjective !== undefined) sets.push(sql`subjective = ${cleanText(input.subjective)}`)
    if (input.findings !== undefined) {
      const f = input.findings
      const systems = Object.fromEntries(
        Object.entries(f.systems).filter(([, s]) => s).map(([k, s]) => [k, { status: s!.status, ...(s!.note?.trim() ? { note: s!.note.trim() } : {}) }]),
      )
      const vitals = Object.fromEntries(Object.entries(f.vitals).filter(([, x]) => x != null && x !== ''))
      sets.push(sql`findings = ${JSON.stringify({ vitals, systems })}::jsonb`)
    }
    if (input.assessment !== undefined) sets.push(sql`assessment = ${cleanText(input.assessment)}`)
    if (input.diagnoses !== undefined) sets.push(sql`diagnoses = ${arr(cleanList(input.diagnoses))}`)
    if (input.differential !== undefined) sets.push(sql`differential = ${arr(cleanList(input.differential))}`)
    if (input.planText !== undefined) sets.push(sql`plan_text = ${cleanText(input.planText)}`)
    if (input.tests !== undefined) sets.push(sql`tests = ${cleanText(input.tests)}`)
    if (input.ownerAdvice !== undefined) sets.push(sql`owner_advice = ${cleanText(input.ownerAdvice)}`)
    if (input.internalNote !== undefined) sets.push(sql`internal_note = ${cleanText(input.internalNote)}`)
    if (input.controlDate !== undefined) sets.push(sql`control_date = ${input.controlDate}`)
    sets.push(sql`updated_at = now()`, sql`updated_by = ${userId}`)
    if (bumpRev) sets.push(sql`rev = rev + 1`)
    await tx.execute(sql`update visits set ${sql.join(sets, sql`, `)} where id = ${visitId}`)

    const v = await loadVisit(tx, visitId)
    if (v.control_date && v.control_date < dateIstanbul(v.visit_at)) {
      throw new AppError(400, 'Kontrol tarihi muayene tarihinden önce olamaz.', 'VALIDATION')
    }

    if (input.findings !== undefined || input.visitAt !== undefined) await syncWeight(tx, v, userId)

    if (input.treatments !== undefined || input.findings !== undefined) {
      // Tedaviler yeniden yazılır; kilo değiştiyse mg/kg toplam dozlar da güncellenir
      const weight = normFindings(v.findings).vitals.weight ?? (await lastWeight(tx, animal.id, await chainIds(tx, v)))?.kg ?? null
      if (input.treatments !== undefined) {
        await tx.execute(sql`delete from treatments where visit_id = ${visitId}`)
        let i = 0
        for (const t of input.treatments) {
          await tx.execute(sql`insert into treatments
            (visit_id, animal_id, sort, drug, active_ingredient, dose, dose_unit, per_kg, total_dose, route, frequency, duration, duration_days, kind, e_recete_no, note, allergy_ack)
            values (${visitId}, ${animal.id}, ${i++}, ${t.drug}, ${cleanText(t.activeIngredient)}, ${t.dose ?? null}, ${t.doseUnit ?? null},
              ${isPerKg(t.doseUnit)}, ${totalDose(t.dose, t.doseUnit, weight)}, ${cleanText(t.route)}, ${cleanText(t.frequency)},
              ${cleanText(t.duration)}, ${parseDurationDays(t.duration)}, ${t.kind}, ${cleanText(t.eReceteNo)}, ${cleanText(t.note)}, ${t.allergyAck === true})`)
        }
      } else {
        await tx.execute(sql`update treatments set total_dose = case when per_kg and ${weight}::numeric is not null then round(dose * ${weight}::numeric, 3) else null end where visit_id = ${visitId}`)
      }
    }
    return v
  }

  /* ───────────── Ayrıntı ───────────── */

  async function animalDto(ex: Ex, animalId: string): Promise<{ animal: VisitAnimalDto; owner: VisitOwnerDto | null }> {
    const a = await one<{
      id: string
      name: string
      species: Species
      breed: string | null
      sex: Sex
      neutered: boolean
      birth_date: string | null
      allergies: string[]
      behavior: string | null
      status: string
      chip_no: string | null
    }>(
      ex,
      sql`select a.id, a.name, a.species, a.breed, a.sex, a.neutered, a.birth_date, a.allergies, a.behavior, a.status,
            (select chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1) as chip_no
          from animals a where a.id = ${animalId}`,
    )
    if (!a) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
    const o = await one<{ id: string; full_name: string; phone: string | null; address: string | null; city: string | null; district: string | null }>(
      ex,
      sql`select o.id, o.first_name || ' ' || o.last_name as full_name, o.phone, o.address, o.city, o.district
          from animal_owners ao join owners o on o.id = ao.owner_id
          where ao.animal_id = ${animalId} and ao.to_date is null order by ao.is_primary desc limit 1`,
    )
    return {
      animal: {
        id: a.id,
        name: a.name,
        species: a.species,
        breed: a.breed,
        sex: a.sex,
        neutered: a.neutered,
        birthDate: a.birth_date,
        allergies: a.allergies ?? [],
        behavior: a.behavior,
        chipNo: a.chip_no,
        status: a.status,
      },
      owner: o ? { id: o.id, fullName: o.full_name, phone: o.phone, address: o.address, city: o.city, district: o.district } : null,
    }
  }

  async function visitDetail(ex: Ex, id: string, full: boolean): Promise<VisitDetail> {
    const v = await loadVisit(ex, id)
    const names = await all<{ id: string; full_name: string; chamber_reg_no: string | null }>(
      ex,
      sql`select id, full_name, chamber_reg_no from users where id = any(${sql.param(
        [v.vet_id, v.signed_by, v.created_by, v.updated_by].filter((x): x is string => !!x),
      )}::uuid[])`,
    )
    const nm = (uid: string | null) => names.find((n) => n.id === uid)?.full_name ?? null
    const { animal, owner } = await animalDto(ex, v.animal_id)
    const versions = await all<{ id: string; version: number; status: VisitStatus; signed_at: Date | null; signed_by_name: string | null; amend_reason: string | null }>(
      ex,
      sql`select x.id, x.version, x.status, x.signed_at, u.full_name as signed_by_name, x.amend_reason
          from visits x left join users u on u.id = x.signed_by
          where x.root_id = ${v.root_id ?? v.id} and x.deleted_at is null order by x.version`,
    )
    const succ = await one<{ id: string }>(ex, sql`select id from visits where supersedes_id = ${v.id} and deleted_at is null`)
    const treatments = full
      ? (await all<TreatmentRow>(ex, sql`select * from treatments where visit_id = ${v.id} order by sort`)).map(mapTreatment)
      : []
    return {
      id: v.id,
      restricted: !full,
      animalId: v.animal_id,
      vetId: v.vet_id,
      vetName: nm(v.vet_id),
      vetChamberRegNo: names.find((n) => n.id === v.vet_id)?.chamber_reg_no ?? null,
      visitAt: iso(v.visit_at)!,
      type: v.type,
      appointmentId: v.appointment_id,
      status: v.status,
      displayStatus: displayStatus(v.status, v.version),
      signedAt: iso(v.signed_at),
      signedBy: v.signed_by,
      signedByName: nm(v.signed_by),
      version: v.version,
      supersedesId: v.supersedes_id,
      supersededById: succ?.id ?? null,
      amendReason: full ? v.amend_reason : null,
      rev: v.rev,
      subjective: full ? v.subjective : null,
      findings: full ? normFindings(v.findings) : { vitals: {}, systems: {} },
      assessment: full ? v.assessment : null,
      diagnoses: full ? v.diagnoses : [],
      differential: full ? v.differential : [],
      planText: full ? v.plan_text : null,
      tests: full ? v.tests : null,
      ownerAdvice: full ? v.owner_advice : null,
      internalNote: full ? v.internal_note : null,
      controlDate: full ? v.control_date : null,
      treatments,
      animal: full ? animal : { ...animal, allergies: [] },
      owner,
      versions: versions.map((x) => ({
        id: x.id,
        version: x.version,
        status: x.status,
        signedAt: iso(x.signed_at),
        signedByName: x.signed_by_name,
        amendReason: full ? x.amend_reason : null,
      })) satisfies VisitVersionRef[],
      createdAt: iso(v.created_at)!,
      createdByName: nm(v.created_by),
      updatedAt: iso(v.updated_at)!,
      updatedByName: nm(v.updated_by),
    }
  }

  /* ───────────── Uçlar ───────────── */

  // S-41 liste
  app.get('/api/visits', async (req) => {
    const u = requireUser(req)
    const full = await canReadContent(u)
    const f = parse(
      z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        vetId: z.string().uuid('Geçersiz hekim.').optional(),
        type: z.enum(VISIT_TYPES).optional(),
        status: z.enum(['all', 'draft', 'signed', 'amended', 'stale']).optional(),
        diagnosis: z.string().trim().max(100).optional(),
        q: z.string().trim().max(100).optional(),
        animalId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      req.query,
    )
    const where: string[] = ['v.deleted_at is null', HEAD]
    const params: unknown[] = []
    const p = (x: unknown) => {
      params.push(x)
      return `$${params.length}`
    }
    if (f.from) where.push(`v.visit_at >= (${p(f.from)}::date)::timestamp at time zone 'Europe/Istanbul'`)
    if (f.to) where.push(`v.visit_at < ((${p(f.to)}::date + 1)::timestamp at time zone 'Europe/Istanbul')`)
    if (f.vetId) where.push(`v.vet_id = ${p(f.vetId)}`)
    if (f.type) where.push(`v.type = ${p(f.type)}`)
    if (f.animalId) where.push(`v.animal_id = ${p(f.animalId)}`)
    switch (f.status ?? 'all') {
      case 'draft':
        where.push(`v.status = 'draft'`)
        break
      case 'signed':
        where.push(`v.status = 'signed'`)
        break
      case 'amended':
        where.push(`v.status = 'signed' and v.version > 1`)
        break
      case 'stale':
        where.push(`v.status = 'draft' and v.created_at < ${p(now())}::timestamptz - interval '24 hours'`)
        break
    }
    if (f.diagnosis && full) {
      where.push(`exists (select 1 from unnest(v.diagnoses || v.differential) d where pk_norm(d) like pk_norm(${p('%' + f.diagnosis + '%')}))`)
    }
    if (f.q) {
      const like = p('%' + f.q + '%')
      where.push(`(pk_norm(a.name) like pk_norm(${like}) or pk_norm(coalesce(o.first_name || ' ' || o.last_name, '')) like pk_norm(${like}))`)
    }
    const from = `from visits v
      join animals a on a.id = v.animal_id
      left join users u on u.id = v.vet_id
      left join lateral (
        select o.first_name, o.last_name from animal_owners ao join owners o on o.id = ao.owner_id
        where ao.animal_id = a.id and ao.to_date is null order by ao.is_primary desc limit 1
      ) o on true
      where ${where.join(' and ')}`
    const nowP = p(now())
    const limit = f.limit ?? 50
    const rowsQ = db.$client.query<{
      id: string
      visit_at: Date
      type: VisitType
      status: VisitStatus
      version: number
      created_at: Date
      stale: boolean
      animal_id: string
      animal_name: string
      species: Species
      owner_name: string | null
      vet_id: string | null
      vet_name: string | null
      diagnoses: string[]
      subjective: string | null
      control_date: string | null
    }>(
      `select v.id, v.visit_at, v.type, v.status, v.version, v.created_at, v.animal_id, a.name as animal_name, a.species,
              o.first_name || ' ' || o.last_name as owner_name, v.vet_id, u.full_name as vet_name, v.diagnoses, v.subjective, v.control_date,
              (v.status = 'draft' and v.created_at < ${nowP}::timestamptz - interval '24 hours') as stale
       ${from} order by v.visit_at desc limit ${limit} offset ${f.offset ?? 0}`,
      params,
    )
    const countQ = db.$client.query<{ n: string }>(`select count(*) as n ${from}`, params.slice(0, -1))
    const [rows, count] = await Promise.all([rowsQ, countQ])
    return {
      rows: rows.rows.map(
        (r): VisitListItem => ({
          id: r.id,
          visitAt: iso(r.visit_at)!,
          type: r.type,
          status: r.status,
          displayStatus: displayStatus(r.status, r.version),
          version: r.version,
          stale: r.stale,
          animalId: r.animal_id,
          animalName: r.animal_name,
          species: r.species,
          ownerName: r.owner_name,
          vetId: r.vet_id,
          vetName: r.vet_name,
          diagnosisSummary: full ? (r.diagnoses.length ? r.diagnoses.join(', ') : r.subjective ? r.subjective.slice(0, 80) : null) : null,
          controlDate: full ? r.control_date : null,
        }),
      ),
      total: Number(count.rows[0].n),
    } satisfies VisitListResult
  })

  // Hazır cümleler ("/" ile)
  app.get('/api/visits/phrases', async (req) => {
    requirePerm(req, 'visits.read')
    const rows = await all<{ id: string; shortcut: string; text: string; field: VisitPhrase['field'] }>(
      db,
      sql`select id, shortcut, text, field from visit_phrases where active order by shortcut`,
    )
    return rows satisfies VisitPhrase[]
  })

  // Tanı önerileri: sık kullanılan tanı listesi + klinikte daha önce yazılmış tanılar (kullanım sıklığına göre)
  app.get('/api/visits/suggest/diagnoses', async (req) => {
    requirePerm(req, 'visits.read')
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query)
    const like = '%' + (q ?? '') + '%'
    const rows = await all<{ name: string; category: string | null; uses: string }>(
      db,
      sql`with used as (
            select d as name, count(*) as uses from visits v, unnest(v.diagnoses || v.differential) d
            where v.deleted_at is null group by d
          ), terms as (
            select name, category, sort from diagnosis_terms where active
          )
          select coalesce(t.name, u.name) as name, t.category, coalesce(u.uses, 0) as uses
          from terms t full outer join used u on lower(u.name) = lower(t.name)
          where pk_norm(coalesce(t.name, u.name)) like pk_norm(${like})
          order by coalesce(u.uses, 0) desc, coalesce(t.sort, 1000), 1
          limit 20`,
    )
    return rows.map((r) => ({ name: r.name, category: r.category, uses: Number(r.uses) })) satisfies DiagnosisSuggestion[]
  })

  // Sık kullanılan ilaçlar (MVP: daha önce yazılan tedavilerden)
  app.get('/api/visits/suggest/drugs', async (req) => {
    requirePerm(req, 'visits.read')
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query)
    const like = '%' + (q ?? '') + '%'
    const rows = await all<{
      drug: string
      active_ingredient: string | null
      dose: string | null
      dose_unit: string | null
      route: string | null
      frequency: string | null
      duration: string | null
      uses: string
    }>(
      db,
      sql`select distinct on (lower(drug)) drug, active_ingredient, dose, dose_unit, route, frequency, duration,
             count(*) over (partition by lower(drug)) as uses
          from treatments
          where pk_norm(drug) like pk_norm(${like}) or pk_norm(coalesce(active_ingredient, '')) like pk_norm(${like})
          order by lower(drug), created_at desc`,
    )
    return rows
      .map((r) => ({
        drug: r.drug,
        activeIngredient: r.active_ingredient,
        dose: num(r.dose),
        doseUnit: r.dose_unit as DrugSuggestion['doseUnit'],
        route: r.route,
        frequency: r.frequency,
        duration: r.duration,
        uses: Number(r.uses),
      }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 20) satisfies DrugSuggestion[]
  })

  // Muayene ekranı sol paneli: hayvan kartı, son kilo, önceki vitaller, son 3 muayene, süren tedaviler
  app.get('/api/visits/animal-context/:id', async (req) => {
    const u = requireUser(req)
    const { id } = parse(idParam, req.params)
    const { exclude } = parse(z.object({ exclude: z.string().uuid().optional() }), req.query)
    const full = await canReadContent(u)
    const { animal, owner } = await animalDto(db, id)
    const excludeIds = exclude ? await chainIds(db, await loadVisit(db, exclude).catch(() => ({ id: exclude, root_id: exclude }) as VisitRow)) : []
    const recent = await all<VisitRow & { vet_name: string | null }>(
      db,
      sql`select v.*, u.full_name as vet_name from visits v left join users u on u.id = v.vet_id
          where v.animal_id = ${id} and v.deleted_at is null and ${sql.raw(HEAD)} and ${sql.raw(CURRENT)}
            and not (v.id = any(${sql.param(excludeIds)}::uuid[]))
          order by v.visit_at desc limit 3`,
    )
    const prev = full
      ? await one<{ id: string; visit_at: Date; findings: Partial<Findings> }>(
          db,
          sql`select v.id, v.visit_at, v.findings from visits v
              where v.animal_id = ${id} and v.deleted_at is null and v.status = 'signed' and ${sql.raw(HEAD)}
                and not (v.id = any(${sql.param(excludeIds)}::uuid[]))
                and v.findings->'vitals' <> '{}'::jsonb
              order by v.visit_at desc limit 1`,
        )
      : undefined
    const treatments = full ? await animalTreatments(id, true) : []
    return {
      animal: full ? animal : { ...animal, allergies: [] },
      owner,
      lastWeight: await lastWeight(db, id, excludeIds),
      previousVitals: prev ? { visitId: prev.id, visitAt: iso(prev.visit_at)!, vitals: normFindings(prev.findings).vitals as Vitals } : null,
      recentVisits: recent.map((v) => ({
        id: v.id,
        visitAt: iso(v.visit_at)!,
        vetName: v.vet_name,
        type: v.type,
        status: v.status,
        summary: full ? summarize(v) : '',
      })),
      activeTreatments: treatments,
    } satisfies VisitAnimalContext
  })

  function summarize(v: Pick<VisitRow, 'diagnoses' | 'subjective' | 'plan_text'>) {
    const parts = [v.diagnoses.join(', '), v.subjective, v.plan_text].filter(Boolean) as string[]
    const s = parts.join(' · ')
    return s.length > 160 ? s.slice(0, 157) + '…' : s
  }

  async function animalTreatments(animalId: string, activeOnly: boolean): Promise<AnimalTreatmentDto[]> {
    const rows = await all<TreatmentRow & { visit_at: Date; vet_name: string | null; visit_status: VisitStatus; end_date: string | null; active: boolean }>(
      db,
      sql`select t.*, v.visit_at, v.status as visit_status, u.full_name as vet_name,
            case when t.duration_days is not null then ((v.visit_at at time zone 'Europe/Istanbul')::date + t.duration_days - 1)::text end as end_date,
            (t.duration_days is not null and (v.visit_at at time zone 'Europe/Istanbul')::date + t.duration_days - 1 >= ${today()}::date) as active
          from treatments t join visits v on v.id = t.visit_id left join users u on u.id = v.vet_id
          where t.animal_id = ${animalId} and v.deleted_at is null and ${sql.raw(HEAD)} and ${sql.raw(CURRENT)}
            ${activeOnly ? sql`and v.status = 'signed' and t.duration_days is not null and (v.visit_at at time zone 'Europe/Istanbul')::date + t.duration_days - 1 >= ${today()}::date` : sql``}
          order by v.visit_at desc, t.sort`,
    )
    return rows.map((r) => ({
      ...mapTreatment(r),
      visitAt: iso(r.visit_at)!,
      vetName: r.vet_name,
      visitStatus: r.visit_status,
      active: r.active,
      endDate: r.end_date,
    }))
  }

  // Hayvanın tedavileri (hayvan detayı → Tedaviler sekmesi)
  app.get('/api/treatments', async (req) => {
    requirePerm(req, 'visits.read')
    const { animalId, active } = parse(z.object({ animalId: z.string().uuid('Hayvan seçin.'), active: z.enum(['1', '0']).optional() }), req.query)
    return animalTreatments(animalId, active === '1')
  })

  // Ayrıntı (yazdırma modülü de kullanır)
  app.get('/api/visits/:id', async (req) => {
    const u = requireUser(req)
    const { id } = parse(idParam, req.params)
    return visitDetail(db, id, await canReadContent(u))
  })

  // Yeni taslak
  app.post('/api/visits', async (req) => {
    const u = requirePerm(req, 'visits.write')
    const body = parse(createSchema, req.body)
    return db.transaction(async (tx) => {
      const animal = await loadAnimal(tx, body.animalId)
      if (animal.status !== 'active' && animal.status !== 'lost') {
        // Ölmüş hayvana yeni muayene açılmaz (ölüm sonrası işlem gerekiyorsa not düşülür)
        throw new AppError(400, 'Bu hayvan aktif değil; yeni muayene açılamaz.', 'VALIDATION')
      }
      // Aynı randevudan açılmış muayene varsa onu döndür (çift tıklama / "Muayeneye al" tekrarı)
      if (body.appointmentId) {
        const ex = await one<{ id: string; rev: number }>(
          tx,
          sql`select id, rev from visits where appointment_id = ${body.appointmentId} and deleted_at is null order by created_at desc limit 1`,
        )
        if (ex) return { id: ex.id, rev: ex.rev, existing: true }
      } else {
        // Az önce aynı kullanıcı tarafından açılmış boş taslak varsa onu döndür (çift istek koruması)
        const ex = await one<{ id: string; rev: number }>(
          tx,
          sql`select id, rev from visits where animal_id = ${body.animalId} and created_by = ${u.id} and status = 'draft' and rev = 1
                and appointment_id is null and deleted_at is null and created_at > now() - interval '15 seconds'
                and subjective is null and diagnoses = '{}' order by created_at desc limit 1`,
        )
        if (ex && Object.keys(body).every((k) => k === 'animalId' || k === 'appointmentId')) return { id: ex.id, rev: ex.rev, existing: true }
      }
      const defaultVet = u.role === 'vet' || u.role === 'admin' ? u.id : null
      const [row] = await all<{ id: string }>(
        tx,
        sql`insert into visits (animal_id, vet_id, visit_at, type, appointment_id, created_by, updated_by)
            values (${animal.id}, ${defaultVet}, ${now()}, 'exam', ${body.appointmentId ?? null}, ${u.id}, ${u.id}) returning id`,
      )
      await tx.execute(sql`update visits set root_id = id where id = ${row.id}`)
      const { animalId: _a, appointmentId: _b, ...content } = body
      const v = await writeContent(tx, row.id, animal, content, u.id, false)
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'visit', entityId: row.id, summary: `Muayene taslağı: ${animal.name}` })
      return { id: row.id, rev: v.rev, existing: false }
    })
  })

  // Taslak güncelle (otomatik kayıt; iyimser kilit)
  app.patch('/api/visits/:id', async (req) => {
    const u = requirePerm(req, 'visits.write')
    const { id } = parse(idParam, req.params)
    const body = parse(patchSchema, req.body)
    return db.transaction(async (tx) => {
      const cur = await loadVisit(tx, id, true)
      if (cur.status !== 'draft') throw new AppError(409, 'İmzalı muayene değiştirilemez. Değişiklik için "Ek/düzeltme" kullanın.', 'SIGNED')
      if (cur.rev !== body.rev) throw await conflict(tx, cur)
      const animal = await loadAnimal(tx, cur.animal_id)
      const { rev: _r, ...content } = body
      const v = await writeContent(tx, id, animal, content, u.id, true)
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'visit',
        entityId: id,
        summary: `Muayene taslağı güncellendi: ${animal.name}`,
        diff: { fields: Object.keys(content) },
      })
      return { id, rev: v.rev, updatedAt: iso(v.updated_at)! }
    })
  })

  async function conflict(ex: Ex, cur: VisitRow) {
    const by = cur.updated_by ? await one<{ full_name: string }>(ex, sql`select full_name from users where id = ${cur.updated_by}`) : undefined
    return new AppError(
      409,
      `Bu muayene ${by?.full_name ?? 'başka bir kullanıcı'} tarafından değiştirildi. Yeniden yükleyip tekrar deneyin.`,
      'CONFLICT',
      { rev: cur.rev, updatedBy: by?.full_name ?? null, updatedAt: iso(cur.updated_at) },
    )
  }

  // İmzala ve kapat
  app.post('/api/visits/:id/sign', async (req) => {
    const u = requirePerm(req, 'visits.sign')
    const { id } = parse(idParam, req.params)
    const body = parse(z.object({ rev: z.number().int().optional() }), req.body ?? {})
    return db.transaction(async (tx) => {
      const cur = await loadVisit(tx, id, true)
      if (cur.status !== 'draft') throw new AppError(409, 'Bu muayene zaten imzalanmış.', 'SIGNED')
      if (body.rev !== undefined && cur.rev !== body.rev) throw await conflict(tx, cur)
      const animal = await loadAnimal(tx, cur.animal_id)
      const f = normFindings(cur.findings)
      const hasContent =
        !!cur.subjective || !!cur.assessment || cur.diagnoses.length > 0 || Object.keys(f.vitals).length > 0 || Object.keys(f.systems).length > 0
      if (!hasContent) throw new AppError(400, 'İmzalamak için en az şikayet, bulgu ya da tanı girin.', 'VALIDATION')
      if (cur.visit_at.getTime() > now().getTime() + 10 * 60_000) throw new AppError(400, 'Muayene tarihi/saati ileri bir zaman olamaz.', 'VALIDATION')
      const treatments = await all<TreatmentRow>(tx, sql`select * from treatments where visit_id = ${id} order by sort`)
      for (const t of treatments) {
        const a = allergyMatch(animal.allergies, { drug: t.drug, activeIngredient: t.active_ingredient })
        if (a && !t.allergy_ack) {
          throw new AppError(400, `${t.drug}: hayvanın "${a}" alerjisi kayıtlı. İmzalamadan önce alerji uyarısını onaylayın.`, 'ALLERGY', {
            treatmentId: t.id,
            allergy: a,
          })
        }
      }
      const vetId = cur.vet_id ?? u.id
      await checkVet(tx, vetId)
      await tx.execute(
        sql`update visits set status = 'signed', signed_at = ${now()}, signed_by = ${u.id}, vet_id = ${vetId},
              updated_at = now(), updated_by = ${u.id}, rev = rev + 1 where id = ${id}`,
      )

      // Kontrol hatırlatması (önceki versiyonlarınki iptal edilir)
      const ids = await chainIds(tx, cur)
      for (const x of ids) await cancelReminders(tx, 'visit', x, 'Muayene yeniden imzalandı')
      if (cur.control_date && cur.control_date >= today()) {
        const owner = await one<{ id: string }>(
          tx,
          sql`select owner_id as id from animal_owners where animal_id = ${animal.id} and to_date is null order by is_primary desc limit 1`,
        )
        const vet = await one<{ full_name: string }>(tx, sql`select full_name from users where id = ${vetId}`)
        if (owner) {
          await scheduleReminder(tx, {
            kind: 'control',
            ownerId: owner.id,
            animalId: animal.id,
            sourceType: 'visit',
            sourceId: id,
            // Kontrol günü saat 10:00 (Türkiye UTC+3, yaz saati yok)
            eventAt: new Date(`${cur.control_date}T10:00:00+03:00`),
            vars: { hayvan_ad: animal.name, tarih: formatDateTr(cur.control_date), hekim_ad: vet?.full_name ?? '' },
          })
        }
      }
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'visit',
        entityId: id,
        summary: `Muayene imzalandı (v${cur.version}): ${animal.name}`,
      })
      return visitDetail(tx, id, true)
    })
  })

  // Ek / düzeltme: imzalı kaydın yeni versiyonu (taslak olarak açılır, imzalanınca geçerli olur)
  app.post('/api/visits/:id/amend', async (req) => {
    const u = requirePerm(req, 'visits.write')
    const { id } = parse(idParam, req.params)
    const body = parse(z.object({ reason: z.string().trim().min(3, 'Düzeltme nedenini yazın.').max(500, 'Neden çok uzun.') }), req.body ?? {})
    try {
      return await db.transaction(async (tx) => {
        const cur = await loadVisit(tx, id, true)
        if (cur.status !== 'signed') throw new AppError(409, 'Yalnızca imzalı muayeneye ek/düzeltme yapılabilir; taslağı doğrudan düzenleyin.', 'NOT_SIGNED')
        const succ = await one<{ id: string; status: VisitStatus }>(tx, sql`select id, status from visits where supersedes_id = ${id} and deleted_at is null`)
        if (succ) {
          throw new AppError(
            409,
            succ.status === 'draft' ? 'Bu muayene için açık bir ek/düzeltme taslağı zaten var.' : 'Bu muayenenin daha yeni bir versiyonu var; düzeltmeyi son versiyona yapın.',
            'HAS_SUCCESSOR',
            { id: succ.id },
          )
        }
        const [row] = await all<{ id: string }>(
          tx,
          sql`insert into visits (animal_id, vet_id, visit_at, type, appointment_id, subjective, findings, assessment, diagnoses, differential,
                plan_text, tests, owner_advice, internal_note, control_date, version, supersedes_id, root_id, amend_reason, created_by, updated_by)
              select animal_id, vet_id, visit_at, type, appointment_id, subjective, findings, assessment, diagnoses, differential,
                plan_text, tests, owner_advice, internal_note, control_date, version + 1, id, coalesce(root_id, id), ${body.reason}, ${u.id}, ${u.id}
              from visits where id = ${id} returning id`,
        )
        await tx.execute(
          sql`insert into treatments (visit_id, animal_id, sort, drug, active_ingredient, dose, dose_unit, per_kg, total_dose, route, frequency, duration, duration_days, kind, e_recete_no, note, allergy_ack)
              select ${row.id}, animal_id, sort, drug, active_ingredient, dose, dose_unit, per_kg, total_dose, route, frequency, duration, duration_days, kind, e_recete_no, note, allergy_ack
              from treatments where visit_id = ${id}`,
        )
        await writeAudit(tx, {
          userId: u.id,
          action: 'create',
          entity: 'visit',
          entityId: row.id,
          summary: `Ek/düzeltme v${cur.version + 1} açıldı (önceki ${id}): ${body.reason}`,
        })
        return { id: row.id, version: cur.version + 1 }
      })
    } catch (e) {
      const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string })
      if (c?.code === '23505' && c.constraint === 'visits_supersedes_uq') throw new AppError(409, 'Bu muayene için açık bir ek/düzeltme taslağı zaten var.', 'HAS_SUCCESSOR')
      throw e
    }
  })

  // Taslak sil (imzalı kayıt silinemez)
  app.delete('/api/visits/:id', async (req) => {
    const u = requirePerm(req, 'visits.write')
    const { id } = parse(idParam, req.params)
    return db.transaction(async (tx) => {
      const cur = await loadVisit(tx, id, true)
      if (cur.status !== 'draft') throw new AppError(409, 'İmzalı muayene silinemez.', 'SIGNED')
      const animal = await loadAnimal(tx, cur.animal_id)
      await tx.execute(sql`update visits set deleted_at = now(), updated_by = ${u.id}, updated_at = now() where id = ${id}`)
      // Kilo geçmişi: bu taslağın kilosu kaldırılır; ek/düzeltme taslağıysa önceki versiyonun kilosu geri yazılır
      await tx.execute(sql`delete from animal_weights where source = 'visit' and visit_id = ${id}`)
      if (cur.supersedes_id) {
        const prev = await loadVisit(tx, cur.supersedes_id).catch(() => null)
        if (prev) await syncWeight(tx, prev, u.id)
      }
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'visit', entityId: id, summary: `Muayene taslağı silindi: ${animal.name}` })
      return { ok: true }
    })
  })
}
