// Yönetici parolasını sıfırlar: uygulamanın kendi sıfırlama uç noktasıyla geçici parola üretir (ilk girişte değiştirilir).
// Geçici parola ekrana yazılmaz; proje kökündeki admin-gecici-parola.txt dosyasına yazılır.
//   npx tsx scripts/reset-admin.ts [--user "Ad Soyad"]
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startBackend } from '../src/main/backend'
import { electronSecrets } from './app-secrets'

const args = process.argv.slice(2)
const ui = args.indexOf('--user')
const who = ui >= 0 ? args[ui + 1] : null
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
  const q = await backend.db.$client.query(
    who ? `select id, full_name, username from users where full_name ilike $1 and role = 'admin'` : `select id, full_name, username from users where role = 'admin' and active order by created_at`,
    who ? [`%${who}%`] : [],
  )
  if (q.rows.length !== 1) throw new Error(`Tek yönetici bulunamadı (${q.rows.map((r) => r.full_name).join(', ') || 'yok'}); --user ile belirtin.`)
  const target = q.rows[0]
  const token = backend.sessions.create({ id: target.id, role: 'admin', fullName: target.full_name })
  const res = await backend.inject({ method: 'POST', url: `/api/admin/users/${target.id}/reset-password`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: '{}' })
  if (res.statusCode !== 200) throw new Error(`Sıfırlama başarısız: ${res.statusCode} ${res.body}`)
  const file = resolve('admin-gecici-parola.txt')
  writeFileSync(file, `Kullanıcı adı: ${target.username}\nGeçici parola: ${res.json().tempPassword}\n(İlk girişte yeni parola istenir. Girdikten sonra bu dosyayı silin.)\n`, { mode: 0o600 })
  console.log(`Sıfırlandı: ${target.full_name} (${target.username}). Geçici parola: ${file}`)
} finally {
  await backend.db.$client.end().catch(() => undefined)
}
process.exit(0)
