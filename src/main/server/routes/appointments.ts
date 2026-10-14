// Randevu modülü API'si: takvim, randevu formu, durum geçişleri, bekleme salonu, randevu türleri, tatiller.
// Kurallar ve  Saat dilimi Europe/Istanbul.
import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { AppError, parse, requirePerm, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import { cancelReminders, scheduleReminder } from '../services/reminders'
import type { Db } from '../../db/client'
import { formatDateTr, todayIstanbul, addDaysIso } from '../../../shared/petvet'
import { normalizeTrMobile, trTitleCase } from '../../../shared/identity'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  NO_SHOW_SUGGEST_MINUTES,
  canTransition,
  istanbulParts,
  scheduleWarnings,
  type AppointmentConfigDto,
  type AppointmentDto,
  type AppointmentSaveResult,
  type AppointmentStatus,
  type AppointmentTypeDto,
  type AppointmentWarning,
  type HolidayDto,
  type WaitingRoomDto,
} from '../../../shared/appointments'
import type { Species } from '../../../shared/api-types'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Exec = Tx | Db

const SPECIES = ['cat', 'dog', 'ferret', 'bird', 'rabbit', 'rodent', 'reptile', 'other'] as const
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih geçersiz.')
const uuid = (msg: string) => z.string().uuid(msg)
const dateTime = z
  .string({ message: 'Tarih ve saat gerekli.' })
  .refine((s) => !Number.isNaN(Date.parse(s)) && /T\d{2}:\d{2}/.test(s), 'Tarih ve saat geçersiz.')
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Renk #RRGGBB biçiminde olmalı.')

const newPatientSchema = z.object({
  ownerName: z.string().trim().min(2, 'Sahip adını girin.').max(80),
  phone: z.string().trim().min(1, 'Telefon gerekli.'),
  animalName: z.string().trim().min(1, 'Hayvan adını girin.').max(40),
  species: z.enum(SPECIES, { message: 'Tür seçin.' }),
})

const patientRefine = (d: { animalId?: string | null; newPatient?: unknown }) => !!d.animalId !== !!d.newPatient

const baseInput = z.object({
  animalId: uuid('Hayvan geçersiz.').nullish(),
  newPatient: newPatientSchema.optional(),
  startsAt: dateTime,
  durationMinutes: z.coerce.number({ message: 'Süre gerekli.' }).int().min(5, 'Süre en az 5 dakika olmalı.').max(480, 'Süre en fazla 8 saat olabilir.'),
  vetId: uuid('Hekim seçin.'),
  typeId: uuid('Randevu türünü seçin.'),
  reason: z.string().trim().max(500).optional(),
  reminder: z.boolean().default(true),
  sendConfirmation: z.boolean().optional(),
})
const createSchema = baseInput.refine(patientRefine, 'Bir hayvan seçin ya da yeni hasta bilgilerini girin.')
const updateSchema = baseInput
  .extend({ version: z.number().int(), notifyOwner: z.boolean().optional() })
  .refine(patientRefine, 'Bir hayvan seçin ya da yeni hasta bilgilerini girin.')

const moveSchema = z.object({
  startsAt: dateTime,
  endsAt: dateTime,
  vetId: uuid('Hekim seçin.'),
  version: z.number().int(),
  notifyOwner: z.boolean().optional(),
})

const statusSchema = z
  .object({
    status: z.enum(APPOINTMENT_STATUSES, { message: 'Durum geçersiz.' }),
    version: z.number().int().optional(),
    room: z.string().trim().max(20).optional(),
    cancelReason: z.string().trim().max(300).optional(),
    cancelledBySide: z.enum(['owner', 'clinic'], { message: 'İptal edeni seçin.' }).optional(),
    notifyOwner: z.boolean().optional(),
  })
  .refine((d) => d.status !== 'cancelled' || !!d.cancelledBySide, { message: 'İptali kimin yaptığını seçin (sahip / klinik).' })

const walkInSchema = z
  .object({
    animalId: uuid('Hayvan geçersiz.').nullish(),
    newPatient: newPatientSchema.optional(),
    vetId: uuid('Hekim geçersiz.').nullish(),
    typeId: uuid('Tür geçersiz.').nullish(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(patientRefine, 'Bir hayvan seçin ya da yeni hasta bilgilerini girin.')

const checkSchema = z.object({
  startsAt: dateTime,
  durationMinutes: z.coerce.number().int().min(5).max(480),
  vetId: uuid('Hekim seçin.').nullish(),
  excludeId: uuid('Geçersiz kayıt.').nullish(),
})

const typeSchema = z.object({
  name: z.string().trim().min(2, 'Tür adı en az 2 karakter olmalı.').max(40),
  color: hexColor,
  defaultMinutes: z.coerce.number().int().min(5, 'Süre en az 5 dakika.').max(480, 'Süre en fazla 480 dakika.'),
  active: z.boolean().optional(),
  sort: z.coerce.number().int().optional(),
})

const holidaySchema = z.object({ date: isoDate, name: z.string().trim().min(2, 'Tatil adını girin.').max(80) })
const idParam = z.object({ id: uuid('Geçersiz kayıt.') })

/* ---------- Sorgu ---------- */

const APPT_SELECT = `
  select ap.*,
         to_char(ap.starts_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD') as l_date,
         to_char(ap.starts_at at time zone 'Europe/Istanbul', 'HH24:MI') as l_time,
         to_char(ap.ends_at at time zone 'Europe/Istanbul', 'HH24:MI') as l_end,
         coalesce(a.name, ap.animal_name) as x_animal_name,
         coalesce(a.species, ap.animal_species) as x_species,
         a.breed as x_breed, a.birth_date as x_birth, a.behavior as x_behavior,
         coalesce(a.allergies, '{}'::text[]) as x_allergies,
         mc.chip_no as x_chip,
         coalesce(o.first_name || ' ' || o.last_name, ap.owner_name) as x_owner_name,
         coalesce(o.phone, ap.owner_phone) as x_owner_phone,
         u.full_name as x_vet_name,
         t.name as x_type_name, t.color as x_type_color,
         (ap.vet_id is not null and ap.status not in ('cancelled', 'no_show') and exists (
            select 1 from appointments b
            where b.vet_id = ap.vet_id and b.id <> ap.id and b.status not in ('cancelled', 'no_show')
              and b.starts_at < ap.ends_at and b.ends_at > ap.starts_at
         )) as x_overlap
  from appointments ap
  left join animals a on a.id = ap.animal_id
  left join owners o on o.id = ap.owner_id
  left join users u on u.id = ap.vet_id
  left join appointment_types t on t.id = ap.type_id
  left join lateral (
    select chip_no from microchips m where m.animal_id = ap.animal_id and m.status = 'active' order by m.created_at desc limit 1
  ) mc on true`

type ApptRow = {
  id: string
  animal_id: string | null
  owner_id: string | null
  vet_id: string | null
  type_id: string | null
  starts_at: Date
  ends_at: Date
  reason: string | null
  status: AppointmentStatus
  arrived_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  room: string | null
  walk_in: boolean
  cancel_reason: string | null
  cancelled_by_side: 'owner' | 'clinic' | null
  reminder: boolean
  version: number
  l_date: string
  l_time: string
  l_end: string
  x_animal_name: string
  x_species: Species | null
  x_breed: string | null
  x_birth: string | null
  x_behavior: string | null
  x_allergies: string[]
  x_chip: string | null
  x_owner_name: string | null
  x_owner_phone: string | null
  x_vet_name: string | null
  x_type_name: string | null
  x_type_color: string | null
  x_overlap: boolean
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60000))

function mapAppt(r: ApptRow, now: Date): AppointmentDto {
  const startsAt = new Date(r.starts_at)
  const endsAt = new Date(r.ends_at)
  let waitMinutes: number | null = null
  if (r.status === 'arrived' && r.arrived_at) waitMinutes = minutesBetween(new Date(r.arrived_at), now)
  if (r.status === 'in_exam' && r.started_at) waitMinutes = minutesBetween(new Date(r.started_at), now)
  return {
    id: r.id,
    status: r.status,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    date: r.l_date,
    time: r.l_time,
    endTime: r.l_end,
    durationMinutes: Math.round((endsAt.getTime() - startsAt.getTime()) / 60000),
    reason: r.reason,
    room: r.room,
    walkIn: r.walk_in,
    reminder: r.reminder,
    version: r.version,
    arrivedAt: iso(r.arrived_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    cancelReason: r.cancel_reason,
    cancelledBySide: r.cancelled_by_side,
    animalId: r.animal_id,
    animalName: r.x_animal_name,
    species: r.x_species,
    breed: r.x_breed,
    birthDate: r.x_birth,
    behavior: r.x_behavior,
    allergies: r.x_allergies ?? [],
    chipNo: r.x_chip,
    ownerId: r.owner_id,
    ownerName: r.x_owner_name,
    ownerPhone: r.x_owner_phone,
    vetId: r.vet_id,
    vetName: r.x_vet_name,
    typeId: r.type_id,
    typeName: r.x_type_name,
    typeColor: r.x_type_color,
    overlap: r.x_overlap,
    waitMinutes,
    suggestNoShow:
      (r.status === 'planned' || r.status === 'confirmed') && now.getTime() > startsAt.getTime() + NO_SHOW_SUGGEST_MINUTES * 60000,
    isNewPatient: !r.animal_id,
  }
}

async function rowsOf<T>(ex: Exec, q: SQL): Promise<T[]> {
  const r = await ex.execute(q)
  return r.rows as T[]
}

async function loadAppt(ex: Exec, id: string): Promise<ApptRow | undefined> {
  const [r] = await rowsOf<ApptRow>(ex, sql`${sql.raw(APPT_SELECT)} where ap.id = ${id}`)
  return r
}

function mapType(r: Record<string, unknown>): AppointmentTypeDto {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    defaultMinutes: r.default_minutes as number,
    active: r.active as boolean,
    sort: r.sort as number,
  }
}

/* ---------- Kurallar ---------- */

async function computeWarnings(
  ex: Exec,
  now: Date,
  startsAt: Date,
  endsAt: Date,
  vetId: string | null | undefined,
  excludeId: string | null,
): Promise<{ warnings: AppointmentWarning[]; overlap: boolean }> {
  const settings = await getSettings(ex)
  const s = istanbulParts(startsAt)
  const e = istanbulParts(endsAt)
  const endMin = e.date === s.date ? e.minutes : 24 * 60
  const holidays = await rowsOf<{ date: string; name: string }>(ex, sql`select date::text as date, name from holidays where date = ${s.date}::date`)
  const warnings = scheduleWarnings(s.date, s.minutes, endMin, settings.workHours, holidays)
  if (startsAt.getTime() < now.getTime() - 60000) warnings.unshift({ code: 'PAST', message: 'Randevu geçmiş bir zamana veriliyor.' })
  let overlap = false
  if (vetId) {
    const rows = await rowsOf<{ n: number }>(
      ex,
      sql`select count(*)::int as n from appointments
          where vet_id = ${vetId} and status not in ('cancelled', 'no_show')
            and starts_at < ${endsAt.toISOString()}::timestamptz and ends_at > ${startsAt.toISOString()}::timestamptz
            and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)`,
    )
    overlap = (rows[0]?.n ?? 0) > 0
    if (overlap) warnings.push({ code: 'OVERLAP', message: 'Bu hekimin aynı saatte başka randevusu var (çift kayıt).' })
  }
  return { warnings, overlap }
}

async function assertVet(ex: Exec, vetId: string) {
  const [v] = await rowsOf<{ id: string }>(
    ex,
    sql`select id from users where id = ${vetId} and active and role in ('vet', 'admin')`,
  )
  if (!v) throw new AppError(400, 'Seçilen kullanıcı hekim değil ya da pasif.', 'VALIDATION')
}

async function assertType(ex: Exec, typeId: string) {
  const [t] = await rowsOf<{ id: string }>(ex, sql`select id from appointment_types where id = ${typeId}`)
  if (!t) throw new AppError(400, 'Randevu türü bulunamadı.', 'VALIDATION')
}

/** Hayvanı doğrular ve birincil (güncel) sahibini döndürür */
async function resolveAnimal(ex: Exec, animalId: string): Promise<{ ownerId: string | null; name: string }> {
  const [a] = await rowsOf<{ id: string; name: string; status: string; owner_id: string | null }>(
    ex,
    sql`select a.id, a.name, a.status,
          (select ao.owner_id from animal_owners ao where ao.animal_id = a.id and ao.to_date is null
           order by ao.is_primary desc limit 1) as owner_id
        from animals a where a.id = ${animalId} and a.deleted_at is null`,
  )
  if (!a) throw new AppError(404, 'Hayvan kaydı bulunamadı.', 'NOT_FOUND')
  if (a.status === 'dead') throw new AppError(400, 'Ölü olarak kayıtlı hayvana randevu verilemez.', 'VALIDATION')
  return { ownerId: a.owner_id, name: a.name }
}

function newPatientFields(np: z.infer<typeof newPatientSchema>) {
  const phone = normalizeTrMobile(np.phone)
  if (!phone) throw new AppError(400, 'Cep telefonu geçersiz (5XX XXX XX XX).', 'VALIDATION')
  return { ownerName: trTitleCase(np.ownerName), phone, animalName: trTitleCase(np.animalName), species: np.species }
}

function reminderVars(r: ApptRow): Record<string, string> {
  return {
    hayvan_ad: r.x_animal_name ?? '',
    sahip_ad: r.x_owner_name ?? '',
    tarih: formatDateTr(r.l_date),
    saat: r.l_time,
    hekim_ad: r.x_vet_name ?? '',
    randevu_tur: r.x_type_name ?? '',
  }
}

/** Randevu hatırlatmasını (ve isteğe bağlı anlık mesajı) planlar. Sahip kaydı yoksa (yeni hasta mini kaydı) atlanır. */
async function planReminders(
  ex: Exec,
  r: ApptRow,
  now: Date,
  opts: { immediate?: 'appointment_confirm' | 'appointment_cancel'; extraVars?: Record<string, string> } = {},
) {
  if (!r.owner_id) return
  const base = { ownerId: r.owner_id, animalId: r.animal_id, sourceType: 'appointment', sourceId: r.id, eventAt: new Date(r.starts_at) }
  const vars = { ...reminderVars(r), ...opts.extraVars }
  if (r.reminder && opts.immediate !== 'appointment_cancel' && new Date(r.starts_at).getTime() > now.getTime()) {
    await scheduleReminder(ex, { ...base, kind: 'appointment', vars })
  }
  if (opts.immediate) await scheduleReminder(ex, { ...base, kind: opts.immediate, vars, immediate: true })
}

function versionConflict(): never {
  throw new AppError(409, 'Bu randevu başka biri tarafından değiştirildi. Yeniden yükleyip tekrar deneyin.', 'VERSION_CONFLICT')
}

/* ---------- Uçlar ---------- */

export function appointmentsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const now = () => deps.now?.() ?? new Date()
  const today = () => deps.today?.() ?? todayIstanbul(now())

  async function listAppts(where: string[], params: unknown[]): Promise<AppointmentDto[]> {
    const r = await db.$client.query<ApptRow>(
      `${APPT_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by ap.starts_at, ap.created_at limit 2000`,
      params,
    )
    const n = now()
    return r.rows.map((x) => mapAppt(x, n))
  }

  /* Takvim yapılandırması: çalışma saatleri, slot, türler, tatiller, hekimler */
  app.get('/api/appointments/config', async (req) => {
    requirePerm(req, 'appointments.read')
    const settings = await getSettings(db)
    const types = await rowsOf<Record<string, unknown>>(db, sql`select * from appointment_types order by sort, name`)
    const holidays = await rowsOf<HolidayDto>(
      db,
      sql`select id, date::text as date, name from holidays where date >= ${addDaysIso(today(), -400)}::date order by date`,
    )
    const vets = await rowsOf<{ id: string; fullName: string; role: string }>(
      db,
      sql`select id, full_name as "fullName", role from users where active and role in ('vet', 'admin') order by full_name`,
    )
    return {
      workHours: settings.workHours,
      slotMinutes: settings.appointmentSlotMinutes,
      types: types.map(mapType),
      holidays,
      vets,
    } satisfies AppointmentConfigDto
  })

  /* Liste: gün / hafta / aralık */
  app.get('/api/appointments', async (req) => {
    requirePerm(req, 'appointments.read')
    const f = parse(
      z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        vetId: z.string().optional(),
        status: z.string().optional(),
        animalId: uuid('Hayvan geçersiz.').optional(),
      }),
      req.query,
    )
    const from = f.from ?? today()
    const to = f.to ?? from
    if (to < from) throw new AppError(400, 'Bitiş tarihi başlangıçtan önce olamaz.', 'VALIDATION')
    if (!f.animalId && addDaysIso(from, 92) < to) throw new AppError(400, 'En fazla 3 aylık aralık listelenebilir.', 'VALIDATION')
    const where: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    if (f.animalId) where.push(`ap.animal_id = ${p(f.animalId)}`)
    if (f.from || f.to || !f.animalId) {
      where.push(`(ap.starts_at at time zone 'Europe/Istanbul')::date between ${p(from)}::date and ${p(to)}::date`)
    }
    if (f.vetId) {
      const ids = f.vetId.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      const none = f.vetId.split(',').includes('none')
      where.push(`(ap.vet_id = any(${p(ids)}::uuid[])${none ? ' or ap.vet_id is null' : ''})`)
    }
    if (f.status) {
      const st = f.status.split(',').filter((x) => (APPOINTMENT_STATUSES as readonly string[]).includes(x))
      where.push(`ap.status = any(${p(st)}::text[])`)
    }
    return listAppts(where, params)
  })

  /* Bekleme salonu: bugünün randevuları + kapıdan gelenler */
  app.get('/api/waiting-room', async (req) => {
    requirePerm(req, 'appointments.read')
    const t = today()
    const items = await listAppts([`(ap.starts_at at time zone 'Europe/Istanbul')::date = $1::date`, `ap.status <> 'cancelled'`], [t])
    return { today: t, now: now().toISOString(), items } satisfies WaitingRoomDto
  })

  app.get('/api/appointments/:id', async (req) => {
    requirePerm(req, 'appointments.read')
    const { id } = parse(idParam, req.params)
    const r = await loadAppt(db, id)
    if (!r) throw new AppError(404, 'Randevu bulunamadı.', 'NOT_FOUND')
    return mapAppt(r, now())
  })

  /* Kaydetmeden önce uyarıları göster (form) */
  app.post('/api/appointments/check', async (req) => {
    requirePerm(req, 'appointments.read')
    const b = parse(checkSchema, req.body)
    const s = new Date(b.startsAt)
    const e = new Date(s.getTime() + b.durationMinutes * 60000)
    return computeWarnings(db, now(), s, e, b.vetId, b.excludeId ?? null)
  })

  /* Yeni randevu */
  app.post('/api/appointments', async (req) => {
    const u = requirePerm(req, 'appointments.write')
    const b = parse(createSchema, req.body)
    const startsAt = new Date(b.startsAt)
    const endsAt = new Date(startsAt.getTime() + b.durationMinutes * 60000)
    const n = now()
    return db.transaction(async (tx) => {
      await assertVet(tx, b.vetId)
      await assertType(tx, b.typeId)
      let ownerId: string | null = null
      let np: ReturnType<typeof newPatientFields> | null = null
      if (b.animalId) ownerId = (await resolveAnimal(tx, b.animalId)).ownerId
      else np = newPatientFields(b.newPatient!)
      const { warnings, overlap } = await computeWarnings(tx, n, startsAt, endsAt, b.vetId, null)
      const [row] = await rowsOf<{ id: string; version: number }>(
        tx,
        sql`insert into appointments (animal_id, owner_id, owner_name, owner_phone, animal_name, animal_species,
              vet_id, type_id, starts_at, ends_at, reason, reminder, created_by)
            values (${b.animalId ?? null}, ${ownerId}, ${np?.ownerName ?? null}, ${np?.phone ?? null}, ${np?.animalName ?? null},
              ${np?.species ?? null}, ${b.vetId}, ${b.typeId}, ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
              ${b.reason || null}, ${b.reminder}, ${u.id})
            returning id, version`,
      )
      const full = (await loadAppt(tx, row.id))!
      await planReminders(tx, full, n, { immediate: b.sendConfirmation ? 'appointment_confirm' : undefined })
      await writeAudit(tx, {
        userId: u.id,
        action: 'create',
        entity: 'appointment',
        entityId: row.id,
        summary: `Randevu: ${full.x_animal_name}, ${formatDateTr(full.l_date)} ${full.l_time}, ${full.x_vet_name ?? ''}${overlap ? ' (çift kayıt)' : ''}`,
      })
      return { id: row.id, version: row.version, overlap, warnings } satisfies AppointmentSaveResult
    })
  })

  /* Randevuyu düzenle (iyimser kilit) */
  app.put('/api/appointments/:id', async (req) => {
    const u = requirePerm(req, 'appointments.write')
    const { id } = parse(idParam, req.params)
    const b = parse(updateSchema, req.body)
    const startsAt = new Date(b.startsAt)
    const endsAt = new Date(startsAt.getTime() + b.durationMinutes * 60000)
    const n = now()
    return db.transaction(async (tx) => {
      const old = await loadAppt(tx, id)
      if (!old) throw new AppError(404, 'Randevu bulunamadı.', 'NOT_FOUND')
      if (old.version !== b.version) versionConflict()
      if (old.status === 'cancelled' || old.status === 'done' || old.status === 'no_show') {
        throw new AppError(409, `${APPOINTMENT_STATUS_LABEL[old.status]} durumundaki randevu düzenlenemez.`, 'INVALID_STATE')
      }
      await assertVet(tx, b.vetId)
      await assertType(tx, b.typeId)
      let ownerId: string | null = null
      let np: ReturnType<typeof newPatientFields> | null = null
      if (b.animalId) ownerId = b.animalId === old.animal_id ? old.owner_id : (await resolveAnimal(tx, b.animalId)).ownerId
      else np = newPatientFields(b.newPatient!)
      const { warnings, overlap } = await computeWarnings(tx, n, startsAt, endsAt, b.vetId, id)
      const upd = await rowsOf<{ version: number }>(
        tx,
        sql`update appointments set animal_id = ${b.animalId ?? null}, owner_id = ${ownerId}, owner_name = ${np?.ownerName ?? null},
              owner_phone = ${np?.phone ?? null}, animal_name = ${np?.animalName ?? null}, animal_species = ${np?.species ?? null},
              vet_id = ${b.vetId}, type_id = ${b.typeId}, starts_at = ${startsAt.toISOString()}::timestamptz,
              ends_at = ${endsAt.toISOString()}::timestamptz, reason = ${b.reason || null}, reminder = ${b.reminder},
              version = version + 1, updated_at = now()
            where id = ${id} and version = ${b.version} returning version`,
      )
      if (!upd.length) versionConflict()
      const full = (await loadAppt(tx, id))!
      const timeChanged = new Date(old.starts_at).getTime() !== startsAt.getTime()
      if (timeChanged || old.reminder !== b.reminder || old.owner_id !== ownerId || old.vet_id !== b.vetId) {
        await cancelReminders(tx, 'appointment', id, 'Randevu değiştirildi')
        await planReminders(tx, full, n, { immediate: timeChanged && b.notifyOwner ? 'appointment_confirm' : undefined, extraVars: { degisiklik: '1' } })
      }
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'appointment',
        entityId: id,
        summary: `Randevu düzenlendi: ${full.x_animal_name}, ${formatDateTr(full.l_date)} ${full.l_time}`,
        diff: { from: { startsAt: iso(old.starts_at), vetId: old.vet_id, typeId: old.type_id }, to: { startsAt: startsAt.toISOString(), vetId: b.vetId, typeId: b.typeId } },
      })
      return { id, version: upd[0].version, overlap, warnings } satisfies AppointmentSaveResult
    })
  })

  /* Sürükle-bırak ile taşı / süre uzat / hekim değiştir */
  app.patch('/api/appointments/:id/move', async (req) => {
    const u = requirePerm(req, 'appointments.write')
    const { id } = parse(idParam, req.params)
    const b = parse(moveSchema, req.body)
    const startsAt = new Date(b.startsAt)
    const endsAt = new Date(b.endsAt)
    if (endsAt.getTime() - startsAt.getTime() < 5 * 60000) throw new AppError(400, 'Süre en az 5 dakika olmalı.', 'VALIDATION')
    if (endsAt.getTime() - startsAt.getTime() > 480 * 60000) throw new AppError(400, 'Süre en fazla 8 saat olabilir.', 'VALIDATION')
    const n = now()
    return db.transaction(async (tx) => {
      const old = await loadAppt(tx, id)
      if (!old) throw new AppError(404, 'Randevu bulunamadı.', 'NOT_FOUND')
      if (old.version !== b.version) versionConflict()
      if (old.status !== 'planned' && old.status !== 'confirmed') {
        throw new AppError(409, `${APPOINTMENT_STATUS_LABEL[old.status]} durumundaki randevu taşınamaz.`, 'INVALID_STATE')
      }
      await assertVet(tx, b.vetId)
      const { warnings, overlap } = await computeWarnings(tx, n, startsAt, endsAt, b.vetId, id)
      const upd = await rowsOf<{ version: number }>(
        tx,
        sql`update appointments set starts_at = ${startsAt.toISOString()}::timestamptz, ends_at = ${endsAt.toISOString()}::timestamptz,
              vet_id = ${b.vetId}, version = version + 1, updated_at = now()
            where id = ${id} and version = ${b.version} returning version`,
      )
      if (!upd.length) versionConflict()
      const full = (await loadAppt(tx, id))!
      const timeChanged = new Date(old.starts_at).getTime() !== startsAt.getTime()
      await cancelReminders(tx, 'appointment', id, 'Randevu taşındı')
      await planReminders(tx, full, n, { immediate: timeChanged && b.notifyOwner ? 'appointment_confirm' : undefined, extraVars: { degisiklik: '1' } })
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'appointment',
        entityId: id,
        summary: `Randevu taşındı: ${full.x_animal_name}, ${formatDateTr(old.l_date)} ${old.l_time} -> ${formatDateTr(full.l_date)} ${full.l_time}`,
        diff: { from: { startsAt: iso(old.starts_at), endsAt: iso(old.ends_at), vetId: old.vet_id }, to: { startsAt: b.startsAt, endsAt: b.endsAt, vetId: b.vetId } },
      })
      return { id, version: upd[0].version, overlap, warnings } satisfies AppointmentSaveResult
    })
  })

  /* Durum değiştir: geldi, muayenede, tamamlandı, gelmedi, iptal... */
  app.post('/api/appointments/:id/status', async (req) => {
    const u = requirePerm(req, 'appointments.write')
    const { id } = parse(idParam, req.params)
    const b = parse(statusSchema, req.body)
    const n = now()
    return db.transaction(async (tx) => {
      const [old] = await rowsOf<{ status: AppointmentStatus; version: number; vet_id: string | null }>(
        tx,
        sql`select status, version, vet_id from appointments where id = ${id} for update`,
      )
      if (!old) throw new AppError(404, 'Randevu bulunamadı.', 'NOT_FOUND')
      if (b.version !== undefined && b.version !== old.version) versionConflict()
      if (old.status === b.status) throw new AppError(409, `Randevu zaten "${APPOINTMENT_STATUS_LABEL[b.status]}" durumunda.`, 'INVALID_TRANSITION')
      if (!canTransition(old.status, b.status)) {
        throw new AppError(
          409,
          `"${APPOINTMENT_STATUS_LABEL[old.status]}" durumundaki randevu "${APPOINTMENT_STATUS_LABEL[b.status]}" yapılamaz.`,
          'INVALID_TRANSITION',
        )
      }
      if (b.status === 'cancelled' && !b.cancelReason) throw new AppError(400, 'İptal nedenini yazın.', 'VALIDATION')
      const ts = n.toISOString()
      let set: SQL
      switch (b.status) {
        case 'planned':
        case 'confirmed':
          set = sql`arrived_at = null, started_at = null`
          break
        case 'arrived':
          set =
            old.status === 'in_exam' || old.status === 'done'
              ? sql`started_at = null, finished_at = null`
              : sql`arrived_at = coalesce(arrived_at, ${ts}::timestamptz), started_at = null`
          break
        case 'in_exam':
          // Hekim atanmamışsa (kapıdan gelen) muayeneye alan hekimi ata
          set = sql`started_at = coalesce(started_at, ${ts}::timestamptz), finished_at = null,
                    arrived_at = coalesce(arrived_at, ${ts}::timestamptz),
                    room = coalesce(${b.room || null}, room),
                    vet_id = coalesce(vet_id, ${!old.vet_id && (u.role === 'vet' || u.role === 'admin') ? u.id : null}::uuid)`
          break
        case 'done':
          set = sql`finished_at = ${ts}::timestamptz, started_at = coalesce(started_at, ${ts}::timestamptz)`
          break
        case 'no_show':
          set = sql`arrived_at = null`
          break
        case 'cancelled':
          set = sql`cancel_reason = ${b.cancelReason ?? null}, cancelled_by_side = ${b.cancelledBySide ?? null}, cancelled_at = ${ts}::timestamptz`
          break
      }
      await tx.execute(
        sql`update appointments set status = ${b.status}, ${set}, version = version + 1, updated_at = now() where id = ${id}`,
      )
      const full = (await loadAppt(tx, id))!
      if (b.status === 'cancelled' || b.status === 'no_show') {
        await cancelReminders(tx, 'appointment', id, b.status === 'cancelled' ? 'Randevu iptal edildi' : 'Hasta gelmedi')
        if (b.status === 'cancelled' && b.notifyOwner) await planReminders(tx, full, n, { immediate: 'appointment_cancel' })
      }
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'appointment',
        entityId: id,
        summary: `Randevu durumu: ${full.x_animal_name}, ${APPOINTMENT_STATUS_LABEL[old.status]} -> ${APPOINTMENT_STATUS_LABEL[b.status]}${
          b.status === 'cancelled' ? ` (${b.cancelledBySide === 'owner' ? 'sahip' : 'klinik'}: ${b.cancelReason})` : ''
        }`,
      })
      return mapAppt(full, n)
    })
  })

  /* Randevusuz (kapıdan) gelen hasta: doğrudan "Geldi" */
  app.post('/api/appointments/walk-in', async (req) => {
    const u = requirePerm(req, 'appointments.write')
    const b = parse(walkInSchema, req.body)
    const n = now()
    return db.transaction(async (tx) => {
      if (b.vetId) await assertVet(tx, b.vetId)
      let minutes = 30
      if (b.typeId) {
        const [t] = await rowsOf<{ default_minutes: number }>(tx, sql`select default_minutes from appointment_types where id = ${b.typeId}`)
        if (!t) throw new AppError(400, 'Randevu türü bulunamadı.', 'VALIDATION')
        minutes = t.default_minutes
      }
      let ownerId: string | null = null
      let np: ReturnType<typeof newPatientFields> | null = null
      if (b.animalId) ownerId = (await resolveAnimal(tx, b.animalId)).ownerId
      else np = newPatientFields(b.newPatient!)
      const start = new Date(Math.floor(n.getTime() / 60000) * 60000)
      const end = new Date(start.getTime() + minutes * 60000)
      const [row] = await rowsOf<{ id: string }>(
        tx,
        sql`insert into appointments (animal_id, owner_id, owner_name, owner_phone, animal_name, animal_species,
              vet_id, type_id, starts_at, ends_at, reason, status, arrived_at, walk_in, reminder, created_by)
            values (${b.animalId ?? null}, ${ownerId}, ${np?.ownerName ?? null}, ${np?.phone ?? null}, ${np?.animalName ?? null},
              ${np?.species ?? null}, ${b.vetId ?? null}, ${b.typeId ?? null}, ${start.toISOString()}::timestamptz,
              ${end.toISOString()}::timestamptz, ${b.reason || null}, 'arrived', ${n.toISOString()}::timestamptz, true, false, ${u.id})
            returning id`,
      )
      const full = (await loadAppt(tx, row.id))!
      await writeAudit(tx, {
        userId: u.id,
        action: 'create',
        entity: 'appointment',
        entityId: row.id,
        summary: `Randevusuz hasta: ${full.x_animal_name}`,
      })
      return mapAppt(full, n)
    })
  })

  /* ---------- Randevu türleri ---------- */

  app.get('/api/appointment-types', async (req) => {
    requirePerm(req, 'appointments.read')
    const rows = await rowsOf<Record<string, unknown>>(db, sql`select * from appointment_types order by sort, name`)
    return rows.map(mapType)
  })

  app.post('/api/appointment-types', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(typeSchema, req.body)
    return db.transaction(async (tx) => {
      const [dup] = await rowsOf<{ id: string }>(tx, sql`select id from appointment_types where pk_norm(name) = pk_norm(${b.name}) and active`)
      if (dup) throw new AppError(409, 'Bu adla bir randevu türü zaten var.', 'DUPLICATE')
      const [r] = await rowsOf<Record<string, unknown>>(
        tx,
        sql`insert into appointment_types (name, color, default_minutes, active, sort)
            values (${b.name}, ${b.color.toUpperCase()}, ${b.defaultMinutes}, ${b.active ?? true},
              coalesce(${b.sort ?? null}::int, (select coalesce(max(sort), 0) + 1 from appointment_types)))
            returning *`,
      )
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'appointment_type', entityId: r.id as string, summary: `Randevu türü: ${b.name}` })
      return mapType(r)
    })
  })

  app.put('/api/appointment-types/:id', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { id } = parse(idParam, req.params)
    const b = parse(typeSchema, req.body)
    return db.transaction(async (tx) => {
      const [dup] = await rowsOf<{ id: string }>(
        tx,
        sql`select id from appointment_types where pk_norm(name) = pk_norm(${b.name}) and active and id <> ${id}`,
      )
      if (dup) throw new AppError(409, 'Bu adla bir randevu türü zaten var.', 'DUPLICATE')
      const [r] = await rowsOf<Record<string, unknown>>(
        tx,
        sql`update appointment_types set name = ${b.name}, color = ${b.color.toUpperCase()}, default_minutes = ${b.defaultMinutes},
              active = coalesce(${b.active ?? null}::boolean, active), sort = coalesce(${b.sort ?? null}::int, sort), updated_at = now()
            where id = ${id} returning *`,
      )
      if (!r) throw new AppError(404, 'Randevu türü bulunamadı.', 'NOT_FOUND')
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'appointment_type', entityId: id, summary: `Randevu türü: ${b.name}` })
      return mapType(r)
    })
  })

  /* Silme = pasifleştirme (geçmiş randevular türünü korur) */
  app.delete('/api/appointment-types/:id', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { id } = parse(idParam, req.params)
    return db.transaction(async (tx) => {
      const [r] = await rowsOf<{ name: string }>(tx, sql`update appointment_types set active = false, updated_at = now() where id = ${id} returning name`)
      if (!r) throw new AppError(404, 'Randevu türü bulunamadı.', 'NOT_FOUND')
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'appointment_type', entityId: id, summary: `Randevu türü pasif: ${r.name}` })
      return { ok: true }
    })
  })

  /* ---------- Tatiller ---------- */

  app.get('/api/holidays', async (req) => {
    requirePerm(req, 'appointments.read')
    const f = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query)
    return rowsOf<HolidayDto>(
      db,
      sql`select id, date::text as date, name from holidays
          where date >= ${f.from ?? addDaysIso(today(), -400)}::date and date <= ${f.to ?? addDaysIso(today(), 800)}::date order by date`,
    )
  })

  app.post('/api/holidays', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(holidaySchema, req.body)
    return db.transaction(async (tx) => {
      const [dup] = await rowsOf<{ id: string }>(tx, sql`select id from holidays where date = ${b.date}::date`)
      if (dup) throw new AppError(409, 'Bu tarih için zaten bir tatil tanımlı.', 'DUPLICATE')
      const [r] = await rowsOf<HolidayDto>(
        tx,
        sql`insert into holidays (date, name) values (${b.date}::date, ${b.name}) returning id, date::text as date, name`,
      )
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'holiday', entityId: r.id, summary: `Tatil: ${formatDateTr(b.date)} ${b.name}` })
      return r
    })
  })

  app.delete('/api/holidays/:id', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { id } = parse(idParam, req.params)
    return db.transaction(async (tx) => {
      const [r] = await rowsOf<{ date: string; name: string }>(tx, sql`delete from holidays where id = ${id} returning date::text as date, name`)
      if (!r) throw new AppError(404, 'Tatil bulunamadı.', 'NOT_FOUND')
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'holiday', entityId: id, summary: `Tatil silindi: ${formatDateTr(r.date)} ${r.name}` })
      return { ok: true }
    })
  })
}
