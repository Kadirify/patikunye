// Veritabanı katmanı duman testi: npx tsx scripts/db-smoke.ts
import { resolve } from 'node:path'
import { DbSupervisor } from '../src/main/db/supervisor'
import { FileSecretStore } from '../src/main/secrets-file'
import { createDb, runMigrations } from '../src/main/db/client'

const base = resolve('.dev-data')
const sup = new DbSupervisor({
  dataDir: resolve(base, 'pgdata'),
  logFile: resolve(base, 'postgres.log'),
  secrets: new FileSecretStore(resolve(base, 'secrets.json')),
  log: console.log,
})

const t0 = Date.now()
const { connectionString } = await sup.start()
console.log('başladı', Date.now() - t0, 'ms')
const db = createDb(connectionString)
await runMigrations(db, resolve('drizzle'))
const r = await db.$client.query(
  "select pk_norm('ŞÜKRÜ IŞIK') as a, pk_norm('İsmail Çağlar') as b, version() as v, current_setting('timezone') as tz",
)
console.log(r.rows[0])
const t = await db.$client.query("select table_name from information_schema.tables where table_schema='public' order by 1")
console.log(t.rows.map((x) => x.table_name).join(', '))
await db.$client.end()
await sup.stop()
console.log('durdu')
