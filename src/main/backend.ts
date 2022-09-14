// Veritabanı + API'yi birlikte başlatır. Electron ana süreci, geliştirme sunucusu ve testler bunu kullanır.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DbSupervisor, type SecretStore } from './db/supervisor'
import { createDb, runMigrations } from './db/client'
import { runModuleMigrations } from './db/modules'
import { FieldCrypto } from './crypto'
import { buildServer } from './server/app'
import { startJobs } from './server/services/jobs'
import type { AppDeps } from './server/context'
import { SessionStore } from './server/routes/auth'
import { NetworkController } from './network'

export interface BackendOptions {
  dataRoot: string
  /** drizzle/ klasörü (ilk şema). Modül migration'ları bunun yanındaki migrations/ klasöründen okunur. */
  migrationsFolder: string
  moduleMigrationsFolder?: string
  secrets: SecretStore
  port?: number
  host?: string
  allowedOrigins: string[]
  log?: (msg: string) => void
  /** Testlerde bugünün tarihini sabitlemek için */
  today?: () => string
  now?: () => Date
  /** Arka plan işleri (hatırlatma gönderimi, otomatik yedek). Testlerde kapalı. */
  jobs?: boolean
  /** Yerel ağ dinleyicisi (ayarlarda açıksa). Testlerde kapalı. */
  network?: boolean
  appVersion?: string
  /** PostgreSQL paylaşımlı bellek (testlerde küçük) */
  sharedBuffers?: string
  /** Veritabanı kurulum adımlarını arayüze bildirmek için */
  onProgress?: (step: string, state: 'start' | 'done' | 'error', detail?: string) => void
}

export async function startBackend(o: BackendOptions) {
  mkdirSync(o.dataRoot, { recursive: true })
  const progress = o.onProgress ?? (() => undefined)
  const supervisor = new DbSupervisor({
    dataDir: join(o.dataRoot, 'pgdata'),
    logFile: join(o.dataRoot, 'postgres.log'),
    secrets: o.secrets,
    log: o.log,
    onProgress: progress,
    sharedBuffers: o.sharedBuffers,
  })
  const { connectionString, secrets } = await supervisor.start()
  const db = createDb(connectionString)
  try {
    return await finishStart(o, supervisor, db, secrets, progress)
  } catch (e) {
    await db.$client.end().catch(() => undefined)
    await supervisor.stop().catch(() => undefined)
    throw e
  }
}

async function finishStart(
  o: BackendOptions,
  supervisor: DbSupervisor,
  db: ReturnType<typeof createDb>,
  secrets: Awaited<ReturnType<DbSupervisor['start']>>['secrets'],
  progress: NonNullable<BackendOptions['onProgress']>,
) {
  progress('migrate', 'start')
  await runMigrations(db, o.migrationsFolder)
  await runModuleMigrations(db, o.moduleMigrationsFolder ?? join(o.migrationsFolder, '..', 'migrations'), o.log)
  progress('migrate', 'done')
  const crypto = new FieldCrypto(secrets.dataKey, secrets.hashKey)
  const deps: AppDeps = {
    db,
    crypto,
    filesDir: join(o.dataRoot, 'files'),
    dataRoot: o.dataRoot,
    log: o.log,
    today: o.today,
    now: o.now,
  }
  const sessions = new SessionStore()
  const network = new NetworkController(deps, sessions, { allowedOrigins: o.allowedOrigins, appVersion: o.appVersion ?? '0.0.0', log: o.log })
  const app = buildServer({ ...deps, allowedOrigins: o.allowedOrigins, sessions, network })
  const address = await app.listen({ host: o.host ?? '127.0.0.1', port: o.port ?? 0 })
  o.log?.(`[api] ${address}`)
  const stopJobs = o.jobs === false ? () => undefined : startJobs(deps)
  if (o.network !== false) await network.startIfEnabled()

  return {
    apiBase: address,
    db,
    deps,
    supervisor,
    network,
    async stop() {
      stopJobs()
      await network.stop()
      await app.close()
      await db.$client.end()
      await supervisor.stop()
    },
  }
}
