// Kurulu uygulamanın (veya .dev-data'nın) veritabanına örnek veri basar.
//   npx tsx scripts/seed-demo.ts --dev          → ./.dev-data
//   npx tsx scripts/seed-demo.ts --app [--size 60] → %APPDATA%\PatiKünye\data (uygulama açıkken de çalışır)
// Anahtarlar yalnızca bellekte çözülür; hiçbir yere yazılmaz/yazdırılmaz. Çalışan PostgreSQL durdurulmaz.
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startBackend } from '../src/main/backend'
import { FileSecretStore } from '../src/main/secrets-file'
import { electronSecrets } from './app-secrets'
import { seedDemoData } from '../src/main/demo-data'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const sizeArg = args.indexOf('--size')
const size = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 60

const userData = join(process.env.APPDATA ?? '', 'PatiKünye')
const dataRoot = dev ? resolve('.dev-data') : join(userData, 'data')
const secrets = dev ? new FileSecretStore(resolve(dataRoot, 'secrets.json')) : electronSecrets(userData)

const backend = await startBackend({
  dataRoot,
  migrationsFolder: resolve('drizzle'),
  moduleMigrationsFolder: resolve('migrations'),
  secrets,
  port: 0,
  allowedOrigins: [],
  jobs: false,
  network: false,
  log: (m) => console.log(m),
})

try {
  const admins = await backend.db.$client.query(`select id, full_name from users where role = 'admin' and active order by created_at limit 1`)
  if (!admins.rows[0]) throw new Error('Yönetici kullanıcı bulunamadı (kurulum tamamlanmamış).')
  const token = backend.sessions.create({ id: admins.rows[0].id, role: 'admin', fullName: admins.rows[0].full_name })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date())
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await backend.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-request-id': randomUUID() },
      payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let data: any = null
    try {
      data = res.json()
    } catch {
      data = res.body
    }
    return { status: res.statusCode, data }
  }
  const sum = await seedDemoData(call, { today, size, log: (m) => console.log(m) })
  console.log(JSON.stringify(sum, null, 2))
} finally {
  // Yalnızca bu betiğin API'si ve bağlantı havuzu kapanır; PostgreSQL çalışmaya devam eder
  await backend.network.stop().catch(() => undefined)
  await backend.db.$client.end().catch(() => undefined)
  // Geliştirme kümesini bu betik başlattıysa kapat (kullanıcının kümesine dokunulmaz)
  if (dev) await backend.supervisor.stop().catch(() => undefined)
}
process.exit(0)
