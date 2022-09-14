import type { FastifyInstance } from 'fastify'
import { hash, verify } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import { count, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { clinic, users } from '../../db/schema'
import { AppError, parse, requireUser, type AppDeps, type SessionUser } from '../context'
import { writeAudit } from '../audit'
import { getSettings } from '../settings'
import type { Role, SessionDto, UserDto } from '../../../shared/api-types'
import type { LoginResult, LoginUserCard, ProfileDto, UserPrefs } from '../../../shared/admin'
import { trTitleCase } from '../../../shared/identity'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_FAILS = 5
const LOCK_MS = 5 * 60 * 1000
const CHANGE_TOKEN_TTL_MS = 15 * 60 * 1000

interface Session extends SessionUser {
  expires: number
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  private fails = new Map<string, { n: number; until: number }>()
  /** Zorunlu parola değişikliği için kısa ömürlü anahtarlar (tam oturum değildir) */
  private changeTokens = new Map<string, { userId: string; expires: number }>()

  create(u: SessionUser): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { ...u, expires: Date.now() + SESSION_TTL_MS })
    return token
  }
  get(token: string): SessionUser | undefined {
    const s = this.sessions.get(token)
    if (!s) return undefined
    if (s.expires < Date.now()) {
      this.sessions.delete(token)
      return undefined
    }
    s.expires = Date.now() + SESSION_TTL_MS
    return s
  }
  delete(token: string) {
    this.sessions.delete(token)
  }
  /** Kullanıcının tüm oturumlarını kapatır (hariç tutulan anahtar dışında). Kapatılan sayıyı döner. */
  revokeUser(userId: string, exceptToken?: string): number {
    let n = 0
    for (const [t, s] of this.sessions) {
      if (s.id === userId && t !== exceptToken) {
        this.sessions.delete(t)
        n++
      }
    }
    for (const [t, c] of this.changeTokens) if (c.userId === userId) this.changeTokens.delete(t)
    return n
  }
  isLocked(username: string) {
    const f = this.fails.get(username)
    return !!f && f.until > Date.now()
  }
  /** Hatalı denemeyi sayar; kilitlendiyse true döner */
  fail(username: string): boolean {
    const f = this.fails.get(username) ?? { n: 0, until: 0 }
    f.n += 1
    let locked = false
    if (f.n >= MAX_FAILS) {
      f.until = Date.now() + LOCK_MS
      f.n = 0
      locked = true
    }
    this.fails.set(username, f)
    return locked
  }
  clearFails(username: string) {
    this.fails.delete(username)
  }
  createChangeToken(userId: string): string {
    const token = randomBytes(32).toString('base64url')
    this.changeTokens.set(token, { userId, expires: Date.now() + CHANGE_TOKEN_TTL_MS })
    return token
  }
  takeChangeToken(token: string): string | undefined {
    const c = this.changeTokens.get(token)
    if (!c || c.expires < Date.now()) {
      this.changeTokens.delete(token)
      return undefined
    }
    return c.userId
  }
  dropChangeToken(token: string) {
    this.changeTokens.delete(token)
  }
}

// Ayarlar modülü (admin.ts) oturum deposuna buradan ulaşır (app.ts değiştirilmeden)
const storeByApp = new WeakMap<FastifyInstance, SessionStore>()
export function sessionsFor(app: FastifyInstance): SessionStore | undefined {
  return storeByApp.get(app)
}

export const password = z.string().min(10, 'Parola en az 10 karakter olmalı.').max(200)
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, 'Kullanıcı adı 3–40 karakter; harf, rakam, nokta, tire içerebilir.')
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN 4–6 haneli rakam olmalı.')

const setupSchema = z.object({
  clinicName: z.string().trim().min(2, 'Klinik adı gerekli.'),
  city: z.string().trim().min(2, 'İl gerekli.'),
  district: z.string().trim().min(2, 'İlçe gerekli.'),
  phone: z.string().trim().optional(),
  admin: z.object({
    fullName: z.string().trim().min(3, 'Ad soyad gerekli.'),
    username,
    password,
    chamberRegNo: z.string().trim().min(1, 'Oda sicil no gerekli.'),
  }),
})

const loginSchema = z.object({ username, password: z.string().min(1).max(200) })
const pinLoginSchema = z.object({ username, pin: z.string().min(1, 'PIN girin.').max(12) })
const firstPasswordSchema = z.object({ changeToken: z.string().min(10), newPassword: password })
const changePasswordSchema = z.object({ currentPassword: z.string().min(1, 'Mevcut parolayı girin.').max(200), newPassword: password })
const unlockSchema = z
  .object({ password: z.string().max(200).optional(), pin: z.string().max(12).optional() })
  .refine((v) => !!v.password || !!v.pin, 'Parola veya PIN girin.')
const setPinSchema = z.object({ currentPassword: z.string().min(1, 'Mevcut parolayı girin.').max(200), pin: pinSchema })
const prefsSchema = z.object({
  notifyPetvet: z.boolean().optional(),
  notifyKvkk: z.boolean().optional(),
  notifyBackup: z.boolean().optional(),
})

export const toUserDto = (u: typeof users.$inferSelect): UserDto => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  role: u.role as Role,
  chamberRegNo: u.chamberRegNo,
})

/** Modül F sütunları (migrations/700_admin.sql) drizzle şemasında olmadığı için düz SQL ile okunur */
interface UserExtra {
  pin_allowed: boolean
  must_change_password: boolean
  password_changed_at: Date | null
  prefs: UserPrefs
}
async function userExtra(deps: AppDeps, id: string): Promise<UserExtra> {
  const r = await deps.db.$client.query<UserExtra>(
    'select pin_allowed, must_change_password, password_changed_at, prefs from users where id = $1',
    [id],
  )
  return r.rows[0] ?? { pin_allowed: false, must_change_password: false, password_changed_at: null, prefs: {} }
}

export function authRoutes(app: FastifyInstance, deps: AppDeps, sessions: SessionStore) {
  const { db } = deps
  storeByApp.set(app, sessions)

  async function needsSetup() {
    const [r] = await db.select({ n: count() }).from(users)
    return r.n === 0
  }

  async function clinicName() {
    const [c] = await db.select({ name: clinic.name }).from(clinic).limit(1)
    return c?.name ?? ''
  }

  /** Başarılı kimlik doğrulamadan sonra oturum açar (ya da zorunlu parola değişikliği anahtarı verir) */
  async function finishLogin(u: typeof users.$inferSelect, method: 'password' | 'pin'): Promise<LoginResult> {
    sessions.clearFails(u.username)
    const extra = await userExtra(deps, u.id)
    if (extra.must_change_password) {
      // Tam oturum verilmez: önce parola değiştirilmeli
      await writeAudit(db, { userId: u.id, action: 'login', entity: 'user', entityId: u.id, summary: 'Parola değişikliği zorunlu' })
      return { mustChangePassword: true, changeToken: sessions.createChangeToken(u.id), fullName: u.fullName }
    }
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id))
    await writeAudit(db, { userId: u.id, action: 'login', entity: 'user', entityId: u.id, summary: method === 'pin' ? 'PIN ile' : undefined })
    const token = sessions.create({ id: u.id, role: u.role as Role, fullName: u.fullName })
    return { token, user: toUserDto(u), clinicName: await clinicName() }
  }

  async function failLogin(name: string, userId: string | null, what: string) {
    const locked = sessions.fail(name)
    await writeAudit(db, {
      userId,
      action: 'login_failed',
      entity: 'user',
      entityId: userId,
      summary: `${name}${what}${locked ? ' · 5 hatalı deneme, 5 dk kilitlendi' : ''}`,
    })
  }

  app.get('/api/setup/status', async () => ({ needsSetup: await needsSetup() }))

  app.post('/api/setup', async (req) => {
    const body = parse(setupSchema, req.body)
    const pwHash = await hash(body.admin.password)
    const result = await db.transaction(async (tx) => {
      // Yarış durumuna karşı: kilit + tekrar kontrol
      await tx.execute(sql`select pg_advisory_xact_lock(7240002)`)
      const [r] = await tx.select({ n: count() }).from(users)
      if (r.n > 0) throw new AppError(409, 'Kurulum zaten yapılmış.', 'ALREADY_SETUP')
      const [c] = await tx
        .insert(clinic)
        .values({ name: body.clinicName, city: body.city, district: body.district, phone: body.phone || null })
        .returning()
      const [u] = await tx
        .insert(users)
        .values({
          username: body.admin.username,
          fullName: trTitleCase(body.admin.fullName),
          role: 'admin',
          passwordHash: pwHash,
          chamberRegNo: body.admin.chamberRegNo,
        })
        .returning()
      await writeAudit(tx, { userId: u.id, action: 'setup', entity: 'clinic', entityId: c.id, summary: `Kurulum: ${c.name}` })
      return { c, u }
    })
    const token = sessions.create({ id: result.u.id, role: 'admin', fullName: result.u.fullName })
    return { token, user: toUserDto(result.u), clinicName: result.c.name } satisfies SessionDto
  })

  app.post('/api/auth/login', async (req) => {
    const body = parse(loginSchema, req.body)
    if (sessions.isLocked(body.username)) {
      throw new AppError(429, 'Çok fazla hatalı deneme. 5 dakika sonra tekrar deneyin.', 'LOCKED')
    }
    const [u] = await db.select().from(users).where(eq(users.username, body.username)).limit(1)
    const ok = !!u && u.active && (await verify(u.passwordHash, body.password))
    if (!ok) {
      await failLogin(body.username, u?.id ?? null, '')
      throw new AppError(401, 'Kullanıcı adı veya parola hatalı.', 'BAD_CREDENTIALS')
    }
    return finishLogin(u, 'password')
  })

  // S-04: PIN ile giriş (yönetici kullanıcıya PIN izni vermiş ve kullanıcı PIN belirlemiş olmalı)
  app.post('/api/auth/pin-login', async (req) => {
    const body = parse(pinLoginSchema, req.body)
    if (sessions.isLocked(body.username)) {
      throw new AppError(429, 'Çok fazla hatalı deneme. 5 dakika sonra tekrar deneyin.', 'LOCKED')
    }
    const [u] = await db.select().from(users).where(eq(users.username, body.username)).limit(1)
    if (u && u.active) {
      const extra = await userExtra(deps, u.id)
      if (!extra.pin_allowed || !u.pinHash) throw new AppError(403, 'Bu kullanıcı için PIN girişi açık değil. Parola ile giriş yapın.', 'PIN_NOT_ALLOWED')
    }
    const ok = !!u && u.active && !!u.pinHash && (await verify(u.pinHash, body.pin))
    if (!ok) {
      await failLogin(body.username, u?.id ?? null, ' (PIN)')
      throw new AppError(401, 'PIN hatalı.', 'BAD_CREDENTIALS')
    }
    return finishLogin(u, 'pin')
  })

  // Zorunlu parola değişikliği (geçici parola ile ilk giriş): yeni parola belirlenince oturum açılır
  app.post('/api/auth/first-password', async (req) => {
    const body = parse(firstPasswordSchema, req.body)
    const userId = sessions.takeChangeToken(body.changeToken)
    if (!userId) throw new AppError(401, 'Süre doldu. Lütfen yeniden giriş yapın.', 'CHANGE_TOKEN_EXPIRED')
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!u || !u.active) throw new AppError(401, 'Kullanıcı bulunamadı.', 'UNAUTHENTICATED')
    if (await verify(u.passwordHash, body.newPassword)) throw new AppError(400, 'Yeni parola geçici paroladan farklı olmalı.', 'SAME_PASSWORD')
    const pwHash = await hash(body.newPassword)
    await db.transaction(async (tx) => {
      await tx.execute(sql`update users set password_hash = ${pwHash}, must_change_password = false, password_changed_at = now(), last_login_at = now() where id = ${u.id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'user', entityId: u.id, summary: 'Parola değiştirildi (ilk giriş)' })
      await writeAudit(tx, { userId: u.id, action: 'login', entity: 'user', entityId: u.id })
    })
    sessions.dropChangeToken(body.changeToken)
    const token = sessions.create({ id: u.id, role: u.role as Role, fullName: u.fullName })
    return { token, user: toUserDto(u), clinicName: await clinicName() } satisfies SessionDto
  })

  // S-115: kendi parolasını değiştirme
  app.post('/api/auth/change-password', async (req) => {
    const s = requireUser(req)
    const body = parse(changePasswordSchema, req.body)
    const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1)
    if (!u || !(await verify(u.passwordHash, body.currentPassword))) {
      throw new AppError(400, 'Mevcut parola hatalı.', 'BAD_PASSWORD', [{ path: ['currentPassword'], message: 'Mevcut parola hatalı.' }])
    }
    if (body.currentPassword === body.newPassword) throw new AppError(400, 'Yeni parola eskisinden farklı olmalı.', 'SAME_PASSWORD')
    const pwHash = await hash(body.newPassword)
    await db.transaction(async (tx) => {
      await tx.execute(sql`update users set password_hash = ${pwHash}, must_change_password = false, password_changed_at = now() where id = ${u.id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'user', entityId: u.id, summary: 'Parola değiştirildi' })
    })
    // Diğer bilgisayarlardaki oturumlar kapatılır
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    sessions.revokeUser(u.id, token)
    return { ok: true }
  })

  // S-05 kilit ekranı: mevcut oturumun sahibi parola veya PIN ile doğrular
  app.post('/api/auth/unlock', async (req) => {
    const s = requireUser(req)
    const body = parse(unlockSchema, req.body)
    const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1)
    if (!u || !u.active) throw new AppError(401, 'Oturum açmanız gerekiyor.', 'UNAUTHENTICATED')
    if (sessions.isLocked(u.username)) throw new AppError(429, 'Çok fazla hatalı deneme. 5 dakika sonra tekrar deneyin.', 'LOCKED')
    let ok = false
    if (body.pin) {
      const extra = await userExtra(deps, u.id)
      if (!extra.pin_allowed || !u.pinHash) throw new AppError(403, 'PIN girişi açık değil. Parolanızı girin.', 'PIN_NOT_ALLOWED')
      ok = await verify(u.pinHash, body.pin)
    } else if (body.password) {
      ok = await verify(u.passwordHash, body.password)
    }
    if (!ok) {
      const locked = sessions.fail(u.username)
      await writeAudit(db, { userId: u.id, action: 'login_failed', entity: 'user', entityId: u.id, summary: `${u.username} (kilit açma)${locked ? ' · oturum kapatıldı' : ''}` })
      if (locked) {
        // 5 hatalı denemede oturum kapatılır; kullanıcı giriş ekranına döner
        sessions.revokeUser(u.id)
        throw new AppError(401, 'Çok fazla hatalı deneme. Oturum kapatıldı.', 'LOCKED')
      }
      throw new AppError(400, body.pin ? 'PIN hatalı.' : 'Parola hatalı.', 'BAD_CREDENTIALS')
    }
    sessions.clearFails(u.username)
    return { ok: true }
  })

  app.post('/api/auth/logout', async (req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (token) sessions.delete(token)
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const s = requireUser(req)
    const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1)
    const [c] = await db.select({ name: clinic.name }).from(clinic).limit(1)
    return { user: toUserDto(u), clinicName: c?.name ?? '' }
  })

  // S-115 Profilim
  app.get('/api/auth/profile', async (req) => {
    const s = requireUser(req)
    const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1)
    const extra = await userExtra(deps, s.id)
    return {
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      role: u.role as Role,
      pinAllowed: extra.pin_allowed,
      pinSet: !!u.pinHash,
      passwordChangedAt: extra.password_changed_at ? new Date(extra.password_changed_at).toISOString() : null,
      prefs: extra.prefs ?? {},
    } satisfies ProfileDto
  })

  app.put('/api/auth/pin', async (req) => {
    const s = requireUser(req)
    const body = parse(setPinSchema, req.body)
    const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1)
    if (!(await verify(u.passwordHash, body.currentPassword))) throw new AppError(400, 'Mevcut parola hatalı.', 'BAD_PASSWORD')
    const extra = await userExtra(deps, s.id)
    if (!extra.pin_allowed) throw new AppError(403, 'Klinik yöneticisi sizin için PIN girişine izin vermemiş.', 'PIN_NOT_ALLOWED')
    if (/^(\d)\1+$/.test(body.pin) || '0123456789'.includes(body.pin) || '9876543210'.includes(body.pin)) {
      throw new AppError(400, 'PIN çok kolay tahmin edilebilir (1111, 1234 gibi). Başka bir PIN seçin.', 'WEAK_PIN')
    }
    const pinHash = await hash(body.pin)
    await db.transaction(async (tx) => {
      await tx.update(users).set({ pinHash }).where(eq(users.id, s.id))
      await writeAudit(tx, { userId: s.id, action: 'update', entity: 'user', entityId: s.id, summary: 'PIN belirlendi' })
    })
    return { ok: true }
  })

  app.delete('/api/auth/pin', async (req) => {
    const s = requireUser(req)
    await db.transaction(async (tx) => {
      await tx.update(users).set({ pinHash: null }).where(eq(users.id, s.id))
      await writeAudit(tx, { userId: s.id, action: 'update', entity: 'user', entityId: s.id, summary: 'PIN kaldırıldı' })
    })
    return { ok: true }
  })

  app.put('/api/auth/prefs', async (req) => {
    const s = requireUser(req)
    const body = parse(prefsSchema, req.body)
    await db.$client.query('update users set prefs = prefs || $2::jsonb where id = $1', [s.id, JSON.stringify(body)])
    return { ok: true }
  })

  app.get('/api/login-users', async () => {
    // Giriş ekranındaki kullanıcı kartları (yalnızca ad, rol, PIN açık mı). Ayarlardan gizlenebilir.
    const settings = await getSettings(db)
    if (!settings.security.showUserCards) return [] as LoginUserCard[]
    const r = await db.$client.query<{ username: string; full_name: string; role: Role; pin_enabled: boolean; last_login_at: Date | null }>(
      `select username, full_name, role, (pin_allowed and pin_hash is not null) as pin_enabled, last_login_at
         from users where active order by last_login_at desc nulls last, full_name`,
    )
    return r.rows.map(
      (x): LoginUserCard => ({
        username: x.username,
        fullName: x.full_name,
        role: x.role,
        pinEnabled: x.pin_enabled,
        lastLoginAt: x.last_login_at ? new Date(x.last_login_at).toISOString() : null,
      }),
    )
  })

  app.get('/api/users', async (req) => {
    requireUser(req)
    const rows = await db.select().from(users).where(eq(users.active, true)).orderBy(users.fullName)
    return rows.map(toUserDto)
  })
}
