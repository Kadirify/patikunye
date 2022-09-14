// Sistem: kurulum sihirbazının son adımı, sistem bilgisi, yerel ağ
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { hash } from '@node-rs/argon2'
import { z } from 'zod'
import { clinic, users } from '../../db/schema'
import { AppError, parse, requirePerm, requireUser, type AppDeps } from '../context'
import type { NetworkController } from '../../network'
import { writeAudit } from '../audit'
import { getSettings, updateSettings } from '../settings'
import { createBackup, setBackupPassword } from '../services/backup'

export interface SystemInfo {
  setupCompletedAt: string | null
  /** Kabuğun ihtiyaç duyduğu, her kullanıcının okuyabileceği ayarlar */
  shell: { lockMinutes: number; readerMaxGapMs: number; readerSound: boolean; tarbilUrl: string }
}

export function systemRoutes(app: FastifyInstance, deps: AppDeps & { network?: NetworkController }) {
  const { db, crypto } = deps
  const net = () => {
    if (!deps.network) throw new AppError(409, 'Yerel ağ yalnızca ana bilgisayarda yönetilir.', 'NO_NETWORK')
    return deps.network
  }

  /* S-109 Ağ ve cihazlar */
  app.get('/api/network/status', async (req) => {
    requirePerm(req, 'settings.manage')
    if (!deps.network) return { host: false }
    return { host: true, ...(await deps.network.status()) }
  })
  app.post('/api/network/enable', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535).optional() }), req.body)
    const st = await net().setEnabled(b.enabled, b.port)
    await writeAudit(db, { userId: u.id, action: 'update', entity: 'network', summary: b.enabled ? `Yerel ağ açıldı (${st.port})` : 'Yerel ağ kapatıldı' })
    return st
  })
  app.post('/api/network/pairing-code', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const c = await net().newPairingCode()
    await writeAudit(db, { userId: u.id, action: 'create', entity: 'pairing_code', summary: 'Eşleştirme kodu üretildi' })
    return c
  })
  app.get('/api/network/devices', async (req) => {
    requirePerm(req, 'settings.manage')
    const r = await db.$client.query(
      `select id, name, paired_at, last_seen_at, last_ip, app_version, revoked_at from devices order by revoked_at nulls first, last_seen_at desc nulls last`,
    )
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      pairedAt: x.paired_at,
      lastSeenAt: x.last_seen_at,
      lastIp: x.last_ip,
      appVersion: x.app_version,
      revokedAt: x.revoked_at,
    }))
  })
  app.post('/api/network/devices/:id/revoke', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const r = await db.$client.query('update devices set revoked_at = now() where id = $1 and revoked_at is null returning name', [id])
    if (!r.rowCount) throw new AppError(404, 'Cihaz bulunamadı.', 'NOT_FOUND')
    deps.network?.forgetDevices()
    await writeAudit(db, { userId: u.id, action: 'update', entity: 'device', entityId: id, summary: `Bağlantı kesildi: ${r.rows[0].name}` })
    return { ok: true }
  })

  app.get('/api/system/info', async (req) => {
    requireUser(req)
    const st = await getSettings(db)
    const s = st as unknown as Record<string, unknown>
    return {
      setupCompletedAt: (s.setupCompletedAt as string) ?? null,
      shell: {
        lockMinutes: st.security.lockMinutes,
        readerMaxGapMs: st.reader.maxGapMs,
        readerSound: st.reader.sound,
        tarbilUrl: st.petvet.tarbilUrl,
      },
    } satisfies SystemInfo
  })

  // Kurulum sihirbazının son adımı ("Başla")
  app.post('/api/system/setup-complete', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(
      z.object({
        recoveryCode: z.string().trim().min(20, 'Kurtarma kodu geçersiz.'),
        backup: z.object({ folder: z.string().trim().nullable(), time: z.string().regex(/^\d{2}:\d{2}$/) }),
        readerMaxGapMs: z.number().int().min(10).max(500).nullable(),
        address: z.string().trim().max(300).nullable(),
        diplomaNo: z.string().trim().max(60).nullable(),
      }),
      req.body,
    )
    const current = await getSettings(db)
    await db.transaction(async (tx) => {
      if (b.address) {
        const [c] = await tx.select({ id: clinic.id }).from(clinic).limit(1)
        await tx.update(clinic).set({ address: b.address }).where(eq(clinic.id, c.id))
      }
      if (b.diplomaNo) await tx.update(users).set({ diplomaNo: b.diplomaNo }).where(eq(users.id, u.id))
      await updateSettings(tx, {
        reader: { ...current.reader, ...(b.readerMaxGapMs ? { maxGapMs: b.readerMaxGapMs } : {}) },
        backup: { ...current.backup, time: b.backup.time, targets: b.backup.folder ? [b.backup.folder] : current.backup.targets },
        // Bilinmeyen anahtarlar mergeSettings ile korunur
        ...({
          setupCompletedAt: new Date().toISOString(),
          // Kurtarma kodu: doğrulayıcı (argon2) + yedekleme modülünün otomatik yedek için kullanacağı şifreli kopya
          recovery: { hash: await hash(b.recoveryCode), createdAt: new Date().toISOString() },
        } as object),
      })
      await writeAudit(tx, { userId: u.id, action: 'setup', entity: 'clinic', summary: 'Kurulum sihirbazı tamamlandı' })
    })
    // Kurtarma kodu = yedek parolası; ilk yedek hemen alınır (yedekleme düzeneği çalışıyor mu)
    await setBackupPassword(deps, b.recoveryCode, { userId: u.id, force: true })
    let firstBackup: { ok: boolean; error?: string } = { ok: true }
    try {
      const r = await createBackup(deps, 'manual')
      const failed = r.targets.filter((x) => !x.ok)
      if (failed.length) firstBackup = { ok: false, error: failed.map((x) => `${x.path}: ${x.error ?? 'yazılamadı'}`).join('; ') }
    } catch (e) {
      firstBackup = { ok: false, error: (e as Error).message }
    }
    return { ok: true, firstBackup }
  })
}
