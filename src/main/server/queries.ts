// Liste/arama sorguları (birden çok tabloyu birleştirenler düz SQL ile)
import type { Db } from '../db/client'
import type { AnimalListItem, PetvetTaskListItem, Sex, Species } from '../../shared/api-types'
import { petvetUrgency, type PetvetStatus, type PetvetTaskKind } from '../../shared/petvet'

const ANIMAL_SELECT = `
  select a.id, a.name, a.species, a.breed, a.sex, a.birth_date, a.status,
         mc.chip_no, o.id as owner_id, o.first_name || ' ' || o.last_name as owner_name, o.phone as owner_phone,
         pt.status as pt_status, pt.due_date as pt_due
  from animals a
  left join lateral (
    select chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1
  ) mc on true
  left join lateral (
    select o.* from animal_owners ao join owners o on o.id = ao.owner_id
    where ao.animal_id = a.id and ao.to_date is null order by ao.is_primary desc limit 1
  ) o on true
  left join lateral (
    select status, due_date from petvet_tasks t
    where t.animal_id = a.id and t.status in ('pending', 'missing_info') order by t.due_date limit 1
  ) pt on true
  where a.deleted_at is null`

type AnimalRow = {
  id: string
  name: string
  species: Species
  breed: string | null
  sex: Sex
  birth_date: string | null
  status: string
  chip_no: string | null
  owner_id: string | null
  owner_name: string | null
  owner_phone: string | null
  pt_status: PetvetStatus | null
  pt_due: string | null
}

function mapAnimal(r: AnimalRow, today: string): AnimalListItem {
  return {
    id: r.id,
    name: r.name,
    species: r.species,
    breed: r.breed,
    sex: r.sex,
    birthDate: r.birth_date,
    status: r.status,
    chipNo: r.chip_no,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    ownerPhone: r.owner_phone,
    petvet: r.pt_status && r.pt_due ? { status: r.pt_status, dueDate: r.pt_due, ...petvetUrgency(r.pt_due, today) } : null,
  }
}

export interface AnimalFilter {
  q?: string
  status?: string
  ids?: string[]
  chipless?: boolean
  limit?: number
}

export async function listAnimals(db: Db, today: string, f: AnimalFilter): Promise<AnimalListItem[]> {
  const where: string[] = []
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  if (f.ids) where.push(`a.id = any(${p(f.ids)}::uuid[])`)
  if (f.status && f.status !== 'all') where.push(`a.status = ${p(f.status)}`)
  if (f.chipless) where.push(`mc.chip_no is null`)
  const q = f.q?.trim()
  if (q) {
    const digits = q.replace(/\D/g, '')
    if (digits.length >= 4 && digits.length === q.replace(/[\s()+-]/g, '').length) {
      where.push(`(mc.chip_no like ${p('%' + digits + '%')} or o.phone like ${p('%' + digits.replace(/^0/, '') + '%')})`)
    } else {
      const like = p('%' + q + '%')
      where.push(`(pk_norm(a.name) like pk_norm(${like}) or pk_norm(o.first_name || ' ' || o.last_name) like pk_norm(${like}))`)
    }
  }
  const sql = `${ANIMAL_SELECT} ${where.length ? 'and ' + where.join(' and ') : ''}
    order by a.updated_at desc limit ${Math.min(f.limit ?? 50, 200)}`
  const r = await db.$client.query<AnimalRow>(sql, params)
  return r.rows.map((x) => mapAnimal(x, today))
}

const TASK_SELECT = `
  select t.id, t.kind, t.status, t.event_date, t.due_date, t.missing_fields, t.done_at, t.petvet_ref,
         a.id as animal_id, a.name as animal_name, a.species,
         mc.chip_no, o.first_name || ' ' || o.last_name as owner_name, u.full_name as vet_name
  from petvet_tasks t
  join animals a on a.id = t.animal_id
  left join owners o on o.id = t.owner_id
  left join users u on u.id = t.vet_id
  left join lateral (
    select chip_no from microchips m where m.animal_id = a.id and m.status = 'active' order by m.created_at desc limit 1
  ) mc on true`

type TaskRow = {
  id: string
  kind: PetvetTaskKind
  status: PetvetStatus
  event_date: string
  due_date: string
  missing_fields: string[]
  done_at: Date | null
  petvet_ref: string | null
  animal_id: string
  animal_name: string
  species: Species
  chip_no: string | null
  owner_name: string | null
  vet_name: string | null
}

function mapTask(r: TaskRow, today: string): PetvetTaskListItem {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    eventDate: r.event_date,
    dueDate: r.due_date,
    ...petvetUrgency(r.due_date, today),
    animalId: r.animal_id,
    animalName: r.animal_name,
    species: r.species,
    chipNo: r.chip_no,
    ownerName: r.owner_name,
    vetName: r.vet_name,
    missingFields: r.missing_fields,
    doneAt: r.done_at ? r.done_at.toISOString() : null,
    petvetRef: r.petvet_ref,
  }
}

export type TaskFilter = 'overdue' | 'today' | 'week' | 'open' | 'missing' | 'done' | 'all'

export async function listTasks(
  db: Db,
  today: string,
  opt: { filter?: TaskFilter; kind?: string; vetId?: string; animalId?: string; id?: string; limit?: number },
): Promise<PetvetTaskListItem[]> {
  const where: string[] = []
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const open = `t.status in ('pending','missing_info')`
  switch (opt.filter ?? 'open') {
    case 'overdue':
      where.push(open, `t.due_date < ${p(today)}::date`)
      break
    case 'today':
      where.push(open, `t.due_date = ${p(today)}::date`)
      break
    case 'week':
      where.push(open, `t.due_date between ${p(today)}::date and ${p(today)}::date + 7`)
      break
    case 'open':
      where.push(open)
      break
    case 'missing':
      where.push(`t.status = 'missing_info'`)
      break
    case 'done':
      where.push(`t.status = 'done'`)
      break
  }
  if (opt.kind) where.push(`t.kind = ${p(opt.kind)}`)
  if (opt.vetId) where.push(`t.vet_id = ${p(opt.vetId)}`)
  if (opt.animalId) where.push(`t.animal_id = ${p(opt.animalId)}`)
  if (opt.id) where.push(`t.id = ${p(opt.id)}`)
  const order = opt.filter === 'done' ? 't.done_at desc' : 't.due_date asc, t.created_at asc'
  const sql = `${TASK_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit ${Math.min(opt.limit ?? 100, 500)}`
  const r = await db.$client.query<TaskRow>(sql, params)
  return r.rows.map((x) => mapTask(x, today))
}

export async function petvetSummary(db: Db, today: string) {
  const r = await db.$client.query<Record<string, string>>(
    `select
       count(*) filter (where status in ('pending','missing_info') and due_date < $1::date) as overdue,
       count(*) filter (where status in ('pending','missing_info') and due_date = $1::date) as today,
       count(*) filter (where status in ('pending','missing_info') and due_date between $1::date and $1::date + 7) as week,
       count(*) filter (where status in ('pending','missing_info')) as open,
       count(*) filter (where status = 'missing_info') as missing,
       count(*) filter (where status = 'done' and done_at >= date_trunc('month', $1::date)) as done_this_month
     from petvet_tasks`,
    [today],
  )
  const x = r.rows[0]
  return {
    overdue: Number(x.overdue),
    today: Number(x.today),
    week: Number(x.week),
    open: Number(x.open),
    missing: Number(x.missing),
    doneThisMonth: Number(x.done_this_month),
  }
}
