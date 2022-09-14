// Arka plan işleri: ana bilgisayarda uygulama açıkken dakikada bir çalışır.
// Modüller iş fonksiyonlarını kendi dosyalarında tanımlar; burada yalnızca kayıt edilir.
import type { AppDeps } from '../context'
import { messagingJob } from './messaging-job'
import { backupJob } from './backup-job'

export interface Job {
  name: string
  everyMs: number
  run(deps: AppDeps): Promise<void>
}

const JOBS: Job[] = [messagingJob, backupJob]

export function startJobs(deps: AppDeps) {
  const timers: NodeJS.Timeout[] = []
  const running = new Set<string>()
  for (const job of JOBS) {
    const tick = async () => {
      if (running.has(job.name)) return
      running.add(job.name)
      try {
        await job.run(deps)
      } catch (e) {
        deps.log?.(`[job:${job.name}] ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        running.delete(job.name)
      }
    }
    // Açılıştan kısa süre sonra bir kez (kaçırılan hatırlatmalar), sonra düzenli aralıkla
    timers.push(setTimeout(tick, 5_000))
    timers.push(setInterval(tick, job.everyMs))
  }
  return () => timers.forEach((t) => clearInterval(t))
}
