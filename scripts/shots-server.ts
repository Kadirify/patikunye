// Ekran görüntüleri için: kurulu uygulamanın veritabanı üzerinde API'yi 47800'de açar, yönetici oturumu üretir.
// Oturum belirteci yalnızca verilen dosyaya yazılır (geçici). PostgreSQL kapatılmaz.
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startBackend } from '../src/main/backend'
import { electronSecrets } from './app-secrets'

const tokenFile = process.argv[2]
const userData = join(process.env.APPDATA ?? '', 'PatiKünye')
const backend = await startBackend({
  dataRoot: join(userData, 'data'),
  migrationsFolder: resolve('drizzle'),
  moduleMigrationsFolder: resolve('migrations'),
  secrets: electronSecrets(userData),
  port: 47800,
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  jobs: false,
  network: false,
})
const q = await backend.db.$client.query(`select id, full_name from users where role = 'admin' and active order by created_at limit 1`)
const token = backend.sessions.create({ id: q.rows[0].id, role: 'admin', fullName: q.rows[0].full_name })
writeFileSync(tokenFile, token)
console.log('[shots] API hazır')
const stop = async () => {
  await backend.db.$client.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
