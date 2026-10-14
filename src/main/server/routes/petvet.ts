import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { animals, microchips, owners, petvetTasks } from '../../db/schema'
import { AppError, parse, requireRole, requireUser, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { listAnimals, listTasks, petvetSummary, type TaskFilter } from '../queries'
import { formatDateTr, todayIstanbul } from '../../../shared/petvet'
import { isValidTckn, phoneForPetvet, trUpper } from '../../../shared/identity'
import { SEX_LABEL, SPECIES_LABEL, type DashboardDto, type PetvetTaskDetail, type Sex, type Species } from '../../../shared/api-types'

export function petvetRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, crypto } = deps
  const today = () => deps.today?.() ?? todayIstanbul()

  app.get('/api/petvet/summary', async (req) => {
    requireUser(req)
    return petvetSummary(db, today())
  })

  app.get('/api/petvet/tasks', async (req) => {
    requireUser(req)
    const q = parse(
      z.object({
        filter: z.enum(['overdue', 'today', 'week', 'open', 'missing', 'done', 'all']).optional(),
        kind: z.string().optional(),
        vetId: z.string().uuid().optional(),
      }),
      req.query,
    )
    return listTasks(db, today(), { filter: q.filter as TaskFilter, kind: q.kind, vetId: q.vetId })
  })

  app.get('/api/petvet/tasks/:id', async (req) => {
    const u = requireRole(req, 'admin', 'vet', 'secretary')
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const [item] = await listTasks(db, today(), { filter: 'all', id })
    if (!item) throw new AppError(404, 'Görev bulunamadı.', 'NOT_FOUND')
    const [t] = await db.select().from(petvetTasks).where(eq(petvetTasks.id, id)).limit(1)
    const [a] = await db.select().from(animals).where(eq(animals.id, t.animalId)).limit(1)
    const [o] = t.ownerId ? await db.select().from(owners).where(eq(owners.id, t.ownerId)).limit(1) : []
    const [mc] = await db
      .select()
      .from(microchips)
      .where(and(eq(microchips.animalId, a.id), eq(microchips.status, 'active')))
      .orderBy(sql`${microchips.createdAt} desc`)
      .limit(1)

    const tckn = o?.tcknEnc ? crypto.decrypt(o.tcknEnc) : ''
    if (tckn) {
      await writeAudit(db, { userId: u.id, action: 'view_sensitive', entity: 'owner', entityId: o!.id, summary: 'PETVET görevi: TCKN görüntülendi' })
    }
    const f = (group: 'owner' | 'animal', key: string, label: string, value: string | null | undefined) => ({
      group,
      key,
      label,
      value: value ?? '',
    })
    const copyFields: PetvetTaskDetail['copyFields'] = [
      f('owner', 'tckn', 'TCKN', tckn),
      f('owner', 'firstName', 'Ad', o ? trUpper(o.firstName) : ''),
      f('owner', 'lastName', 'Soyad', o ? trUpper(o.lastName) : ''),
      f('owner', 'birthDate', 'Doğum tarihi', formatDateTr(o?.birthDate)),
      f('owner', 'phone', 'Cep telefonu', phoneForPetvet(o?.phone)),
      f('owner', 'cityDistrict', 'İl / ilçe', o?.city ? trUpper(`${o.city} / ${o.district ?? ''}`) : ''),
      f('owner', 'address', 'Adres', o?.address),
      f('owner', 'emergency', 'Acil durum', o?.emergencyName ? `${o.emergencyName} - ${phoneForPetvet(o.emergencyPhone)}` : ''),
      f('animal', 'chipNo', 'Çip no', mc?.chipNo),
      f('animal', 'name', 'Adı', trUpper(a.name)),
      f('animal', 'speciesBreed', 'Tür / ırk', trUpper(`${SPECIES_LABEL[a.species as Species]}${a.breed ? ' / ' + a.breed : ''}`)),
      f('animal', 'sex', 'Cinsiyet', trUpper(SEX_LABEL[a.sex as Sex])),
      f('animal', 'color', 'Renk', a.color ? trUpper(a.color) : ''),
      f('animal', 'birthDate', 'Doğum tarihi', formatDateTr(a.birthDate)),
      f('animal', 'passportNo', 'Pasaport', a.passportNo),
      f('animal', 'implant', 'Uygulama', mc ? `${formatDateTr(mc.implantedAt)} - ${mc.bodySite ?? ''}` : ''),
    ]
    return { ...item, copyFields, note: t.note, vetId: t.vetId, ownerId: t.ownerId } satisfies PetvetTaskDetail
  })

  app.post('/api/petvet/tasks/:id/done', async (req) => {
    const u = requireRole(req, 'admin', 'vet', 'secretary')
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const body = parse(z.object({ petvetRef: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional() }), req.body ?? {})
    await db.transaction(async (tx) => {
      const [t] = await tx.select().from(petvetTasks).where(eq(petvetTasks.id, id)).for('update').limit(1)
      if (!t) throw new AppError(404, 'Görev bulunamadı.', 'NOT_FOUND')
      if (t.status === 'missing_info') throw new AppError(409, 'Önce eksik bilgiyi tamamlayın.', 'MISSING_INFO')
      if (t.status !== 'pending') throw new AppError(409, 'Görev zaten kapatılmış.', 'NOT_OPEN')
      await tx
        .update(petvetTasks)
        .set({ status: 'done', doneAt: new Date(), doneBy: u.id, petvetRef: body.petvetRef || null, note: body.note || null, updatedAt: new Date() })
        .where(eq(petvetTasks.id, id))
      await writeAudit(tx, { userId: u.id, action: 'petvet_done', entity: 'petvet_task', entityId: id, summary: body.petvetRef ?? undefined })
    })
    return { ok: true }
  })

  // Eksik TCKN tamamlanınca sahibin bekleyen görevleri tekrar "bekliyor" olur
  app.post('/api/owners/:id/tckn', async (req) => {
    const u = requireRole(req, 'admin', 'vet', 'secretary')
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const { tckn } = parse(z.object({ tckn: z.string().trim().refine(isValidTckn, 'TCKN geçersiz.') }), req.body)
    const tcknHash = crypto.hash(tckn)
    await db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(and(eq(owners.tcknHash, tcknHash), isNull(owners.deletedAt)))
        .limit(1)
      if (dup && dup.id !== id) throw new AppError(409, 'Bu TCKN başka bir sahipte kayıtlı.', 'DUPLICATE_TCKN', { ownerId: dup.id })
      const r = await tx
        .update(owners)
        .set({ tcknEnc: crypto.encrypt(tckn), tcknHash, tcknLast4: tckn.slice(-4), updatedAt: new Date(), version: sql`${owners.version} + 1` })
        .where(eq(owners.id, id))
        .returning({ id: owners.id })
      if (!r.length) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
      await tx
        .update(petvetTasks)
        .set({ status: 'pending', missingFields: sql`array_remove(${petvetTasks.missingFields}, 'owner.tckn')`, updatedAt: new Date() })
        .where(and(eq(petvetTasks.ownerId, id), inArray(petvetTasks.status, ['missing_info']), sql`${petvetTasks.missingFields} = array['owner.tckn']`))
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'owner', entityId: id, summary: 'TCKN eklendi' })
    })
    return { ok: true }
  })

  app.get('/api/dashboard', async (req) => {
    requireUser(req)
    const t = today()
    const [summary, urgentAll, recentAnimals, chips] = await Promise.all([
      petvetSummary(db, t),
      listTasks(db, t, { filter: 'week', limit: 10 }),
      listAnimals(db, t, { status: 'all', limit: 8 }),
      db.$client.query(`select count(*)::int as n from microchips where implanted_at >= date_trunc('month', $1::date)`, [t]),
    ])
    const overdue = await listTasks(db, t, { filter: 'overdue', limit: 10 })
    return {
      today: t,
      petvet: summary,
      urgentTasks: [...overdue, ...urgentAll].slice(0, 12),
      recentAnimals,
      chipsThisMonth: chips.rows[0].n,
    } satisfies DashboardDto
  })
}
