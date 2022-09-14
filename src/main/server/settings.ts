import { eq } from 'drizzle-orm'
import { clinic } from '../db/schema'
import { mergeSettings, type ClinicSettings } from '../../shared/settings'
import type { Db } from '../db/client'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function getSettings(db: Db | Tx): Promise<ClinicSettings> {
  const [c] = await db.select({ settings: clinic.settings }).from(clinic).limit(1)
  return mergeSettings(c?.settings ?? {})
}

/** Kısmi güncelleme: verilen üst düzey anahtarları değiştirir */
export async function updateSettings(db: Db | Tx, patch: Partial<ClinicSettings>): Promise<ClinicSettings> {
  const [c] = await db.select({ id: clinic.id, settings: clinic.settings }).from(clinic).limit(1)
  if (!c) throw new Error('Klinik kaydı yok')
  const next = mergeSettings({ ...(c.settings as object), ...patch })
  await db.update(clinic).set({ settings: next }).where(eq(clinic.id, c.id))
  return next
}
