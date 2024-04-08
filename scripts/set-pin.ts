// Bir kullanıcının PIN'ini belirler (PIN izni de açılır). PIN ortam değişkeninden okunur, hiçbir yere yazılmaz.
//   $env:PK_PIN='....'; npx tsx scripts/set-pin.ts --user "Kadir Top"
import { join, resolve } from 'node:path'
import { hash } from '@node-rs/argon2'
import { startBackend } from '../src/main/backend'
import { pinSchema } from '../src/main/server/routes/auth'
import { electronSecrets } from './app-secrets'
import { eq, sql } from 'drizzle-orm'
import { users } from '../src/main/db/schema'
import { writeAudit } from '../src/main/server/audit'

const args = process.argv.slice(2)
const ui = args.indexOf('--user')
const who = ui >= 0 ? args[ui + 1] : null
const pin = pinSchema.parse(process.env.PK_PIN ?? '')
if (!who) throw new Error('--user "Ad Soyad" gerekli.')

const userData = join(process.env.APPDATA ?? '', 'PatiKünye')
const backend = await startBackend({
  dataRoot: join(userData, 'data'),
  migrationsFolder: resolve('drizzle'),
  moduleMigrationsFolder: resolve('migrations'),
  secrets: electronSecrets(userData),
  port: 0,
  allowedOrigins: [],
  jobs: false,
  network: false,
})
try {
  const db = backend.db.$client
  const q = await db.query(`select id, full_name, username from users where full_name ilike $1 and active`, [`%${who}%`])
  if (q.rows.length !== 1) throw new Error(`Tek kullanıcı bulunamadı (${q.rows.map((r) => r.full_name).join(', ') || 'yok'}).`)
  const u = q.rows[0]
  const pinHash = await hash(pin)
  await backend.db.transaction(async (tx) => {
    await tx.update(users).set({ pinHash }).where(eq(users.id, u.id))
    await tx.execute(sql`update users set pin_allowed = true where id = ${u.id}`)
    await writeAudit(tx, { userId: u.id, action: 'update', entity: 'user', entityId: u.id, summary: 'PIN belirlendi' })
  })
  console.log(`PIN belirlendi: ${u.full_name} (${u.username})`)
} finally {
  await backend.db.$client.end().catch(() => undefined)
}
process.exit(0)
