// Hızlı kayıt: çip + sahip + hayvan + çip uygulama + PETVET görevi tek işlemde.
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import { animalOwners, animals, chipEvents, microchips, owners, petvetTasks, users } from '../../db/schema'
import { AppError, parse, requirePerm, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import { createOwner, ownerInputSchema } from './owners'
import { validateChip } from '../../../shared/chip'
import { petvetDueDate, todayIstanbul } from '../../../shared/petvet'
import { trTitleCase } from '../../../shared/identity'
import { BODY_SITES, PETVET_SPECIES, type QuickRegisterResult, type Species } from '../../../shared/api-types'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih geçersiz.')
const SPECIES = ['cat', 'dog', 'ferret', 'bird', 'rabbit', 'rodent', 'reptile', 'other'] as const

const schema = z
  .object({
    chipNo: z.string().min(1, 'Çip numarası gerekli.'),
    ownerId: z.string().uuid().optional(),
    owner: ownerInputSchema.optional(),
    animal: z.object({
      name: z.string().trim().min(1, 'Hayvan adı gerekli.').max(40),
      species: z.enum(SPECIES, { message: 'Tür seçin.' }),
      breed: z.string().trim().max(60).optional(),
      sex: z.enum(['male', 'female', 'unknown'], { message: 'Cinsiyet seçin.' }),
      neutered: z.boolean(),
      birthDate: isoDate,
      birthDateEstimated: z.boolean(),
      color: z.string().trim().max(60).optional(),
    }),
    implant: z.object({
      date: isoDate,
      vetId: z.string().uuid('Uygulayan hekimi seçin.'),
      bodySite: z.enum(BODY_SITES, { message: 'Vücut bölgesini seçin.' }),
      passportNo: z.string().trim().max(40).optional(),
      lotNo: z.string().trim().max(40).optional(),
      verified: z.boolean().refine((v) => v, 'Uygulamadan sonra çipin tekrar okutulduğunu onaylayın.'),
    }),
  })
  .refine((d) => !!d.ownerId !== !!d.owner, 'Bir sahip seçin ya da yeni sahip girin.')

function isUniqueViolation(e: unknown, constraint: string) {
  const err = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string })
  return err?.code === '23505' && err?.constraint === constraint
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, crypto } = deps
  const today = () => deps.today?.() ?? todayIstanbul()

  app.post('/api/quick-register', async (req) => {
    const user = requirePerm(req, 'animals.write')
    const body = parse(schema, req.body)

    const chip = validateChip(body.chipNo)
    if (!chip.ok) throw new AppError(400, chip.error, 'INVALID_CHIP')
    if (body.implant.date > today()) throw new AppError(400, 'Uygulama tarihi ileri bir tarih olamaz.', 'VALIDATION')
    if (body.animal.birthDate > body.implant.date) throw new AppError(400, 'Doğum tarihi uygulama tarihinden sonra olamaz.', 'VALIDATION')

    try {
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ animalId: microchips.animalId })
          .from(microchips)
          .where(and(eq(microchips.chipNo, chip.value), ne(microchips.status, 'corrected')))
          .limit(1)
        if (existing) {
          throw new AppError(409, 'Bu çip klinikte başka bir hayvana kayıtlı.', 'CHIP_EXISTS', { animalId: existing.animalId })
        }

        const [vet] = await tx
          .select({ id: users.id, active: users.active })
          .from(users)
          .where(and(eq(users.id, body.implant.vetId), inArray(users.role, ['vet', 'admin'])))
          .limit(1)
        if (!vet?.active) throw new AppError(400, 'Çipi yalnızca hekim uygulayabilir.', 'VALIDATION')

        let owner: typeof owners.$inferSelect | undefined
        if (body.ownerId) {
          ;[owner] = await tx.select().from(owners).where(eq(owners.id, body.ownerId)).limit(1)
          if (!owner || owner.deletedAt) throw new AppError(404, 'Sahip bulunamadı.', 'NOT_FOUND')
        } else {
          owner = await createOwner(tx, crypto, body.owner!, user.id)
        }

        const [animal] = await tx
          .insert(animals)
          .values({
            name: trTitleCase(body.animal.name),
            species: body.animal.species,
            breed: body.animal.breed || null,
            sex: body.animal.sex,
            neutered: body.animal.neutered,
            birthDate: body.animal.birthDate,
            birthDateEstimated: body.animal.birthDateEstimated,
            color: body.animal.color || null,
            passportNo: body.implant.passportNo || null,
            createdBy: user.id,
          })
          .returning()
        await tx.insert(animalOwners).values({ animalId: animal.id, ownerId: owner.id, isPrimary: true, fromDate: body.implant.date })

        const [mc] = await tx
          .insert(microchips)
          .values({
            chipNo: chip.value,
            format: chip.format,
            animalId: animal.id,
            implantedAt: body.implant.date,
            implantedBy: body.implant.vetId,
            bodySite: body.implant.bodySite,
            lotNo: body.implant.lotNo || null,
          })
          .returning()
        await tx.insert(chipEvents).values({
          microchipId: mc.id,
          kind: 'IMPLANT',
          data: { verified: true, warnings: chip.warnings },
          userId: user.id,
        })

        let task: typeof petvetTasks.$inferSelect | null = null
        if (PETVET_SPECIES.includes(body.animal.species as Species) && chip.format === 'iso' && chip.codeKind !== 'test') {
          const missing = owner.tcknHash ? [] : ['owner.tckn']
          ;[task] = await tx
            .insert(petvetTasks)
            .values({
              kind: 'CHIP_NEW',
              animalId: animal.id,
              ownerId: owner.id,
              vetId: body.implant.vetId,
              sourceType: 'microchip',
              sourceId: mc.id,
              eventDate: body.implant.date,
              dueDate: petvetDueDate('CHIP_NEW', body.implant.date, (await getSettings(tx)).petvet.days),
              status: missing.length ? 'missing_info' : 'pending',
              missingFields: missing,
            })
            .returning()
        }

        await writeAudit(tx, {
          userId: user.id,
          action: 'create',
          entity: 'animal',
          entityId: animal.id,
          summary: `Hızlı kayıt: ${animal.name}, çip ${chip.value}`,
        })
        return {
          animalId: animal.id,
          ownerId: owner.id,
          petvetTaskId: task?.id ?? null,
          petvetStatus: (task?.status as QuickRegisterResult['petvetStatus']) ?? null,
          dueDate: task?.dueDate ?? null,
        } satisfies QuickRegisterResult
      })
      return result
    } catch (e) {
      if (isUniqueViolation(e, 'microchips_chip_no_uq')) throw new AppError(409, 'Bu çip klinikte başka bir hayvana kayıtlı.', 'CHIP_EXISTS')
      if (isUniqueViolation(e, 'animals_passport_uq')) throw new AppError(409, 'Bu pasaport numarası başka bir hayvanda kayıtlı.', 'PASSPORT_EXISTS')
      throw e
    }
  })
}
