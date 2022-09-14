import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client'
import type { FieldCrypto } from '../crypto'
import type { Role } from '../../shared/api-types'
import { can, type Permission } from '../../shared/permissions'

export interface AppDeps {
  db: Db
  crypto: FieldCrypto
  /** Şifreli ek dosyaların klasörü (dataRoot/files) */
  filesDir: string
  /** Uygulama veri kökü (yedekler, loglar) */
  dataRoot: string
  /** Test ve geliştirmede bugünün tarihini sabitlemek için */
  today?: () => string
  /** Testlerde saati sabitlemek için (hatırlatma zamanlayıcısı vb.) */
  now?: () => Date
  log?: (msg: string) => void
}

export interface SessionUser {
  id: string
  role: Role
  fullName: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser
  }
}

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    const first = r.error.issues[0]
    throw new AppError(400, first?.message ?? 'Geçersiz istek', 'VALIDATION', r.error.issues)
  }
  return r.data
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new AppError(401, 'Oturum açmanız gerekiyor.', 'UNAUTHENTICATED')
  return req.user
}

/** İzin kontrolü (shared/permissions.ts matrisi) */
export function requirePerm(req: FastifyRequest, ...perms: Permission[]): SessionUser {
  const u = requireUser(req)
  if (!perms.every((p) => can(u.role, p))) throw new AppError(403, 'Bu işlem için yetkiniz yok.', 'FORBIDDEN')
  return u
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const u = requireUser(req)
  if (!roles.includes(u.role)) throw new AppError(403, 'Bu işlem için yetkiniz yok.', 'FORBIDDEN')
  return u
}

export type Reply = FastifyReply
