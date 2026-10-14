// Yedekleme ve veritabanı API'si
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verify as argonVerify } from '@node-rs/argon2'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppError, parse, requirePerm, requireUser, type AppDeps } from '../context'
import { getSettings, updateSettings } from '../settings'
import {
  auditSafe,
  createBackup,
  defaultTarget,
  findBackupFile,
  freeBytes,
  getBackupConfig,
  getBackupStatus,
  isBackupRunning,
  isSameDisk,
  restoreBackup,
  setBackupPassword,
  storedPasswordForVerify,
  targetKind,
  testTarget,
  verifyBackup,
} from '../services/backup'
import { dbStatus, diagnostics, runMaintenance } from '../services/backup/database'
import {
  BACKUP_PASSWORD_MIN,
  RESTORE_CONFIRM_TEXT,
  type BackupListItem,
  type BackupSettingsDto,
  type BackupTargetInfo,
  type BackupTargetResult,
  type TargetTestDto,
} from '../../../shared/backup'
import { can } from '../../../shared/permissions'

const pathSchema = z.string().trim().min(3, 'Klasör yolu girin.').max(400, 'Yol çok uzun.')
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

export function backupRoutes(app: FastifyInstance, deps: AppDeps) {
  const db = deps.db.$client

  // ---- durum (herkes: kenar çubuğu / Bugün ekranı)
  app.get('/api/backup/status', async (req) => {
    requireUser(req)
    return getBackupStatus(deps)
  })

  // ---- yedek listesi
  app.get('/api/backup/list', async (req): Promise<BackupListItem[]> => {
    requirePerm(req, 'backup.run')
    const r = await db.query(
      `select id, started_at, finished_at, reason, file_name, size, targets, rows_total, files_total, verified_at, verify_ok, verify_result, error
         from backups where pruned_at is null order by started_at desc limit 100`,
    )
    return r.rows.map((x) => ({
      id: x.id,
      startedAt: new Date(x.started_at).toISOString(),
      finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null,
      reason: x.reason,
      fileName: x.file_name,
      size: x.size === null ? null : Number(x.size),
      targets: (x.targets ?? []) as BackupTargetResult[],
      rowsTotal: x.rows_total,
      filesTotal: x.files_total,
      verifiedAt: x.verified_at ? new Date(x.verified_at).toISOString() : null,
      verifyOk: x.verify_ok,
      verifyResult: x.verify_result,
      error: x.error,
    }))
  })

  // ---- şimdi yedek al
  app.post('/api/backup/run', async (req) => {
    const u = requirePerm(req, 'backup.run')
    if (isBackupRunning()) throw new AppError(409, 'Şu anda bir yedekleme/geri yükleme sürüyor. Biraz sonra tekrar deneyin.', 'BACKUP_BUSY')
    return createBackup(deps, 'manual', { userId: u.id })
  })

  // ---- doğrula
  app.post('/api/backup/verify', async (req) => {
    const u = requirePerm(req, 'backup.run')
    const b = parse(
      z.object({ backupId: z.string().uuid().optional(), path: pathSchema.optional(), password: z.string().max(500).optional() }).refine((x) => !!x.backupId !== !!x.path, {
        message: 'Bir yedek seçin ya da dosya yolu girin.',
      }),
      req.body,
    )
    if (b.path && !can(u.role, 'backup.restore')) throw new AppError(403, 'Bu işlem için yetkiniz yok.', 'FORBIDDEN')
    const file = b.backupId ? await findBackupFile(deps, b.backupId) : b.path!
    const password = b.password || (await storedPasswordForVerify(deps))
    if (!password) throw new AppError(400, 'Yedek parolasını girin.', 'BACKUP_NO_PASSWORD')
    const now = deps.now?.() ?? new Date()
    try {
      const v = await verifyBackup(file, password)
      if (b.backupId) await db.query('update backups set verified_at = $2, verify_ok = true, verify_result = $3 where id = $1', [b.backupId, now, v.summary])
      await auditSafe(deps, { userId: u.id, action: 'update', entity: 'backup', entityId: b.backupId ?? null, summary: `Yedek doğrulandı: ${v.summary}` })
      return v
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (b.backupId && (e as AppError).code !== 'BACKUP_WRONG_PASSWORD')
        await db.query('update backups set verified_at = $2, verify_ok = false, verify_result = $3 where id = $1', [b.backupId, now, msg])
      await auditSafe(deps, { userId: u.id, action: 'update', entity: 'backup', entityId: b.backupId ?? null, summary: `Yedek doğrulanamadı: ${msg}` })
      throw e
    }
  })

  // ---- geri yükle
  app.post('/api/backup/restore', { bodyLimit: 64 * 1024 }, async (req) => {
    const u = requirePerm(req, 'backup.restore')
    const b = parse(
      z
        .object({
          backupId: z.string().uuid().optional(),
          path: pathSchema.optional(),
          password: z.string().min(1, 'Yedek parolasını girin.').max(500),
          confirm: z.string(),
          adminPassword: z.string().min(1, 'Yönetici parolanızı girin.').max(500),
        })
        .refine((x) => !!x.backupId !== !!x.path, { message: 'Bir yedek seçin ya da dosya yolu girin.' }),
      req.body,
    )
    if (b.confirm.trim() !== RESTORE_CONFIRM_TEXT)
      throw new AppError(400, `Onaylamak için "${RESTORE_CONFIRM_TEXT}" yazın.`, 'CONFIRM_REQUIRED')
    const me = await db.query('select password_hash from users where id = $1 and active', [u.id])
    const ok = !!me.rows[0] && (await argonVerify(me.rows[0].password_hash, b.adminPassword).catch(() => false))
    if (!ok) {
      await auditSafe(deps, { userId: u.id, action: 'login_failed', entity: 'backup', summary: 'Geri yükleme: yönetici parolası yanlış' })
      throw new AppError(400, 'Yönetici parolası yanlış.', 'ADMIN_PASSWORD')
    }
    if (isBackupRunning()) throw new AppError(409, 'Şu anda bir yedekleme/geri yükleme sürüyor. Biraz sonra tekrar deneyin.', 'BACKUP_BUSY')
    const file = b.backupId ? await findBackupFile(deps, b.backupId) : b.path!
    return restoreBackup(deps, file, b.password, { userId: u.id })
  })

  // ---- ayarlar
  app.get('/api/backup/settings', async (req): Promise<BackupSettingsDto> => {
    requirePerm(req, 'settings.manage')
    const s = await getSettings(deps.db)
    const cfg = await getBackupConfig(deps)
    return { ...s.backup, defaultTarget: defaultTarget(deps), passwordSet: cfg.passwordSet, passwordSetAt: cfg.passwordSetAt }
  })

  app.put('/api/backup/settings', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(
      z.object({
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Saat SS:dd biçiminde olmalı (ör. 03:00).'),
        keepDaily: z.number().int().min(1, 'En az 1 günlük yedek saklanmalı.').max(365, 'En fazla 365.'),
        keepMonthly: z.number().int().min(0).max(120, 'En fazla 120.'),
      }),
      req.body,
    )
    const s = await getSettings(deps.db)
    await updateSettings(deps.db, { backup: { ...s.backup, ...b } })
    await auditSafe(deps, { userId: u.id, action: 'update', entity: 'settings', entityId: 'backup', summary: `Yedek ayarları: ${b.time}, ${b.keepDaily} günlük, ${b.keepMonthly} aylık`, diff: { before: s.backup, after: b } })
    return { ok: true }
  })

  // ---- hedefler
  app.get('/api/backup/targets', async (req): Promise<BackupTargetInfo[]> => {
    requirePerm(req, 'settings.manage')
    const s = await getSettings(deps.db)
    const list = s.backup.targets.length ? s.backup.targets : [defaultTarget(deps)]
    const hist = await db.query<{ finished_at: Date; targets: BackupTargetResult[] }>(
      'select finished_at, targets from backups where finished_at is not null order by started_at desc limit 50',
    )
    const out: BackupTargetInfo[] = []
    for (const p of list) {
      let lastOkAt: string | null = null
      let lastError: string | null = null
      for (const h of hist.rows) {
        const t = (h.targets ?? []).find((x) => samePath(x.path, p))
        if (!t) continue
        if (t.ok) {
          lastOkAt = new Date(h.finished_at).toISOString()
          break
        }
        if (!lastError) lastError = t.error ?? 'Hata'
      }
      out.push({
        path: p,
        kind: targetKind(deps, p),
        freeBytes: await freeBytes(p),
        exists: existsSync(p),
        sameDisk: await isSameDisk(deps, p),
        lastOkAt,
        lastError,
        isDefault: !s.backup.targets.length,
      })
    }
    return out
  })

  const testOne = async (p: string): Promise<TargetTestDto> => {
    const t = await testTarget(p)
    return { path: p, ...t, freeBytes: await freeBytes(p), sameDisk: await isSameDisk(deps, p), kind: targetKind(deps, p) }
  }

  app.post('/api/backup/targets/test', async (req) => {
    requirePerm(req, 'settings.manage')
    const b = parse(z.object({ path: pathSchema }), req.body)
    return testOne(b.path)
  })

  app.post('/api/backup/targets', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(z.object({ path: pathSchema }), req.body)
    const t = await testOne(b.path)
    if (!t.writable) throw new AppError(400, `Bu klasöre yazılamıyor: ${t.error}`, 'TARGET_NOT_WRITABLE', t)
    const s = await getSettings(deps.db)
    if (s.backup.targets.some((x) => samePath(x, b.path))) throw new AppError(409, 'Bu hedef zaten ekli.', 'DUPLICATE')
    if (s.backup.targets.length >= 5) throw new AppError(400, 'En fazla 5 hedef eklenebilir.', 'TOO_MANY')
    await updateSettings(deps.db, { backup: { ...s.backup, targets: [...s.backup.targets, b.path] } })
    await auditSafe(deps, { userId: u.id, action: 'create', entity: 'backup_target', summary: b.path })
    return t
  })

  app.post('/api/backup/targets/remove', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(z.object({ path: pathSchema }), req.body)
    const s = await getSettings(deps.db)
    const next = s.backup.targets.filter((x) => !samePath(x, b.path))
    if (next.length === s.backup.targets.length) throw new AppError(404, 'Hedef bulunamadı.', 'NOT_FOUND')
    await updateSettings(deps.db, { backup: { ...s.backup, targets: next } })
    await auditSafe(deps, { userId: u.id, action: 'delete', entity: 'backup_target', summary: b.path })
    return { ok: true }
  })

  // ---- yedek parolası
  app.post('/api/backup/password', async (req) => {
    const u = requirePerm(req, 'backup.restore')
    const b = parse(
      z.object({
        newPassword: z.string().min(BACKUP_PASSWORD_MIN, `Yedek parolası en az ${BACKUP_PASSWORD_MIN} karakter olmalı.`).max(500),
        currentPassword: z.string().max(500).optional(),
      }),
      req.body,
    )
    await setBackupPassword(deps, b.newPassword, { currentPassword: b.currentPassword, userId: u.id })
    return { ok: true }
  })

  // ---- veritabanı
  app.get('/api/db/status', async (req) => {
    requirePerm(req, 'settings.manage')
    return dbStatus(deps)
  })

  app.post('/api/db/maintenance', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const r = await runMaintenance(deps)
    await auditSafe(deps, { userId: u.id, action: 'update', entity: 'database', summary: `Bakım (VACUUM ANALYZE) ${r.ms} ms` })
    return { ok: true, ms: r.ms }
  })

  app.get('/api/db/diagnostics', async (req, reply) => {
    const u = requirePerm(req, 'settings.manage')
    const d = await diagnostics(deps)
    await auditSafe(deps, { userId: u.id, action: 'export', entity: 'database', summary: 'Tanı paketi indirildi' })
    const stamp = d.generatedAt.slice(0, 10)
    reply.header('Content-Disposition', `attachment; filename="patikunye-tani-${stamp}.json"`)
    return d
  })
}
