// Şifreli ek dosyalar: içerik AES-256-GCM ile filesDir altına yazılır, meta veriler attachments tablosunda.
import type { FastifyInstance } from 'fastify'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError, parse, requireUser, type AppDeps } from './context'
import { writeAudit } from './audit'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'text/plain']

/** Dosya içeriğinin gerçekten beyan edilen türde olduğunu ilk baytlardan kontrol eder */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.subarray(4, 12).toString('latin1').startsWith('ftyphei')) return 'image/heic'
  return null
}

export interface SavedFile {
  id: string
  fileName: string
  mime: string
  size: number
  createdAt: string
}

export async function saveAttachment(
  deps: AppDeps,
  input: { ownerType: string; ownerId: string; fileName: string; mime: string; data: Buffer; note?: string; userId: string },
): Promise<SavedFile> {
  if (input.data.length > MAX_FILE_BYTES) throw new AppError(413, 'Dosya 25 MB sınırını aşıyor.', 'TOO_LARGE')
  const sniffed = sniffMime(input.data)
  const mime = sniffed ?? (input.mime === 'text/plain' ? 'text/plain' : null)
  if (!mime || !ALLOWED.includes(mime)) throw new AppError(415, 'Bu dosya türü kabul edilmiyor (PDF, JPG, PNG, WEBP, HEIC).', 'BAD_TYPE')

  mkdirSync(deps.filesDir, { recursive: true })
  const key = randomUUID() + '.bin'
  const fileKey = Buffer.from(deps.crypto.hash('file-key'), 'base64url').subarray(0, 32)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', fileKey, iv)
  const enc = Buffer.concat([c.update(input.data), c.final()])
  await writeFile(join(deps.filesDir, key), Buffer.concat([iv, c.getAuthTag(), enc]))

  const sha = createHash('sha256').update(input.data).digest('hex')
  const r = await deps.db.$client.query(
    `insert into attachments (owner_type, owner_id, file_name, mime, size, storage_key, sha256, note, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, created_at`,
    [input.ownerType, input.ownerId, input.fileName.slice(0, 200), mime, input.data.length, key, sha, input.note ?? null, input.userId],
  )
  await writeAudit(deps.db, { userId: input.userId, action: 'create', entity: 'attachment', entityId: r.rows[0].id, summary: `${input.ownerType}: ${input.fileName}` })
  return { id: r.rows[0].id, fileName: input.fileName, mime, size: input.data.length, createdAt: new Date(r.rows[0].created_at).toISOString() }
}

export async function readAttachment(deps: AppDeps, id: string): Promise<{ data: Buffer; mime: string; fileName: string }> {
  const r = await deps.db.$client.query('select storage_key, mime, file_name from attachments where id = $1 and deleted_at is null', [id])
  if (!r.rowCount) throw new AppError(404, 'Dosya bulunamadı.', 'NOT_FOUND')
  const raw = await readFile(join(deps.filesDir, r.rows[0].storage_key))
  const fileKey = Buffer.from(deps.crypto.hash('file-key'), 'base64url').subarray(0, 32)
  const d = createDecipheriv('aes-256-gcm', fileKey, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return { data: Buffer.concat([d.update(raw.subarray(28)), d.final()]), mime: r.rows[0].mime, fileName: r.rows[0].file_name }
}

export async function listAttachments(deps: AppDeps, ownerType: string, ownerId: string): Promise<SavedFile[]> {
  const r = await deps.db.$client.query(
    `select id, file_name, mime, size, created_at from attachments where owner_type = $1 and owner_id = $2 and deleted_at is null order by created_at desc`,
    [ownerType, ownerId],
  )
  return r.rows.map((x) => ({ id: x.id, fileName: x.file_name, mime: x.mime, size: x.size, createdAt: new Date(x.created_at).toISOString() }))
}

/**
 * POST /api/files  { ownerType, ownerId, fileName, mime, dataBase64, note? }
 * GET  /api/files?ownerType=&ownerId=
 * GET  /api/files/:id  → dosyanın kendisi
 */
export function fileRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/api/files', { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) }, async (req) => {
    const u = requireUser(req)
    const b = parse(
      z.object({
        ownerType: z.enum(['animal', 'owner', 'visit', 'petvet_task', 'kvkk_request']),
        ownerId: z.string().uuid(),
        fileName: z.string().min(1).max(200),
        mime: z.string().max(100),
        dataBase64: z.string().min(1),
        note: z.string().max(300).optional(),
      }),
      req.body,
    )
    return saveAttachment(deps, { ...b, data: Buffer.from(b.dataBase64, 'base64'), userId: u.id })
  })

  app.get('/api/files', async (req) => {
    requireUser(req)
    const q = parse(z.object({ ownerType: z.string(), ownerId: z.string().uuid() }), req.query)
    return listAttachments(deps, q.ownerType, q.ownerId)
  })

  app.get('/api/files/:id', async (req, reply) => {
    requireUser(req)
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const f = await readAttachment(deps, id)
    reply.header('Content-Type', f.mime)
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`)
    return reply.send(f.data)
  })
}
