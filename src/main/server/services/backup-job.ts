// Günlük otomatik yedek (Modül G): ayarlardaki saatte; bilgisayar kapalıydıysa ilk fırsatta.
// Kural: en son planlanan an (bugün SS:dd geçtiyse bugün, geçmediyse dün SS:dd) ile şimdi arasında
// başarılı bir yedek yoksa yedek alınır. Son deneme hata verdiyse 1 saat beklenir.
import type { Job } from './jobs'
import type { AppDeps } from '../context'
import { getSettings } from '../settings'
import { createBackup, getBackupConfig, isBackupRunning } from './backup'

/** Türkiye saatiyle (sabit UTC+3) en son planlanan yedek anı */
export function lastScheduledAt(now: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  const local = new Date(now.getTime() + 3 * 3600_000) // UTC alanları = İstanbul saati
  const cand = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - 3 * 3600_000
  return new Date(cand <= now.getTime() ? cand : cand - 24 * 3600_000)
}

export async function shouldRunDaily(deps: AppDeps): Promise<boolean> {
  const now = deps.now?.() ?? new Date()
  const s = await getSettings(deps.db)
  if (!(await getBackupConfig(deps)).passwordSet) return false
  const due = lastScheduledAt(now, s.backup.time || '03:00')
  const r = await deps.db.$client.query(
    `select
       (select max(finished_at) from backups where error is null and finished_at is not null) as ok_at,
       (select max(started_at) from backups where error is not null) as err_at`,
  )
  const okAt: Date | null = r.rows[0].ok_at ? new Date(r.rows[0].ok_at) : null
  const errAt: Date | null = r.rows[0].err_at ? new Date(r.rows[0].err_at) : null
  if (okAt && okAt >= due) return false
  if (errAt && errAt >= due && now.getTime() - errAt.getTime() < 3600_000) return false
  return true
}

export const backupJob: Job = {
  name: 'backup',
  everyMs: 10 * 60_000,
  async run(deps) {
    if (isBackupRunning()) return
    if (!(await shouldRunDaily(deps))) return
    deps.log?.('[backup] günlük yedek başlıyor')
    const r = await createBackup(deps, 'daily')
    const failed = r.targets.filter((t) => !t.ok)
    deps.log?.(`[backup] tamam: ${r.fileName} (${r.rowsTotal} satır)${failed.length ? `; başarısız hedef: ${failed.map((t) => t.path).join(', ')}` : ''}`)
  },
}
