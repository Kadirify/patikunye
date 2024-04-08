// 2020'den bugüne geçmiş kayıtlar ekler ve tüm örnek kayıtların zaman damgalarını gerçekçi hale getirir.
//   npx tsx scripts/seed-history.ts --dev [--count 40]
//   npx tsx scripts/seed-history.ts --app [--count 160] [--from 2020-02-03] [--rename "Dr. Kadir Top"]
// Anahtarlar yalnızca bellekte çözülür. Çalışan PostgreSQL durdurulmaz.
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { startBackend } from '../src/main/backend'
import { FileSecretStore } from '../src/main/secrets-file'
import type { DbSecrets, SecretStore } from '../src/main/db/supervisor'
import { seedHistory, closeOldPetvet } from '../src/main/demo-history'
import { electronSecrets } from './app-secrets'

const args = process.argv.slice(2)
const arg = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const dev = args.includes('--dev')
const count = Number(arg('--count') ?? (dev ? 40 : 160))
const from = arg('--from') ?? '2020-02-03'
const to = arg('--to')
const uniform = args.includes('--uniform')
const rename = arg('--rename')

const userData = join(process.env.APPDATA ?? '', 'PatiKünye')
const dataRoot = dev ? resolve('.dev-data') : join(userData, 'data')
const inner: SecretStore = dev ? new FileSecretStore(resolve(dataRoot, 'secrets.json')) : electronSecrets(userData)
// Süper kullanıcı parolası yalnızca bu süreçte, zaman damgası düzeltmesi için tutulur
let secretsMem: DbSecrets | null = null
const secrets: SecretStore = {
  async load() {
    secretsMem = (await inner.load()) ?? null
    return secretsMem
  },
  save: (s) => inner.save(s),
}

const backend = await startBackend({
  dataRoot,
  migrationsFolder: resolve('drizzle'),
  moduleMigrationsFolder: resolve('migrations'),
  secrets,
  port: 0,
  allowedOrigins: [],
  jobs: false,
  network: false,
  log: (m) => (m.startsWith('[migr') ? undefined : console.log(m)),
})

try {
  const q = await backend.db.$client.query(`select id, full_name from users where role = 'admin' and active order by created_at limit 1`)
  const admin = q.rows[0]
  if (!admin) throw new Error('Yönetici bulunamadı.')
  let token = backend.sessions.create({ id: admin.id, role: 'admin', fullName: admin.full_name })
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

  if (rename) {
    const r = await call('PATCH', `/api/admin/users/${admin.id}`, { fullName: rename })
    console.log(r.status === 200 ? `Ad değişti: ${admin.full_name} → ${r.data.fullName}` : `Ad değişmedi: ${r.status} ${JSON.stringify(r.data)}`)
    // Ad değişince oturumlar kapanır; yeni oturum aç
    token = backend.sessions.create({ id: admin.id, role: 'admin', fullName: r.data.fullName ?? admin.full_name })
  }

  if (count > 0) {
    const h = await seedHistory(call, { today, from, to, uniform, count, log: (m) => console.log(m) })
    console.log(JSON.stringify({ ...h, backdate: h.backdate.length }, null, 2))
  }

  console.log(`[PETVET] eski bekleyenler girildi: ${await closeOldPetvet(call, today, 45)}`)

  // Zaman damgaları: kayıtlar "bugün oluşturuldu" görünmesin. İmzalı muayene tetikleyicisi için
  // yalnızca bu işlemde replika rolüyle (tetikleyiciler kapalı) çalışılır.
  const cs = new URL((backend.db.$client.options as { connectionString: string }).connectionString)
  const su = new pg.Client({ host: '127.0.0.1', port: Number(cs.port), user: 'postgres', password: secretsMem!.superPassword, database: cs.pathname.slice(1) })
  await su.connect()
  try {
    await su.query('begin')
    await su.query(`set local session_replication_role = replica`)
    const fixes: [string, string][] = [
      [
        'çipler',
        `update microchips set created_at = implanted_at + time '10:00' + (random() * interval '7 hours')
          where implanted_at is not null and created_at::date > implanted_at`,
      ],
      [
        'çip olayları',
        `update chip_events e set created_at = m.created_at from microchips m where m.id = e.microchip_id and e.created_at::date > m.implanted_at`,
      ],
      [
        'hayvanlar',
        `update animals a set created_at = x.d, updated_at = greatest(x.d, coalesce(a.status_date + time '12:00', x.d))
           from (select animal_id, min(created_at) d from microchips group by animal_id) x
          where x.animal_id = a.id and a.created_at > x.d + interval '1 day'`,
      ],
      [
        'sahipler',
        `update owners o set created_at = x.d, updated_at = x.d, kvkk_notice_at = case when o.kvkk_notice_at is not null then x.d end,
                marketing_consent_at = case when o.marketing_consent_at is not null then x.d end
           from (select ao.owner_id, min(a.created_at) d from animal_owners ao join animals a on a.id = ao.animal_id group by ao.owner_id) x
          where x.owner_id = o.id and o.created_at > x.d + interval '1 day'`,
      ],
      [
        'PETVET',
        `update petvet_tasks set created_at = event_date + time '10:00',
                done_at = case when done_at is not null then event_date + time '11:00' + (floor(random() * 13) + 1) * interval '1 day' + random() * interval '6 hours' end,
                updated_at = coalesce(case when done_at is not null then event_date + time '11:00' + interval '3 days' end, event_date + time '10:00')
          where created_at::date > event_date + 1`,
      ],
      ['PETVET (gelecek tarih)', `update petvet_tasks set done_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where done_at > now()`],
      [
        'muayeneler',
        `update visits set created_at = visit_at, updated_at = visit_at + interval '35 minutes',
                signed_at = case when signed_at is not null then visit_at + interval '35 minutes' end
          where created_at > visit_at + interval '1 day'`,
      ],
      [
        'tedaviler',
        `update treatments t set created_at = v.visit_at from visits v where v.id = t.visit_id and t.created_at > v.visit_at + interval '1 day'`,
      ],
      [
        'aşılar',
        `update vaccinations set created_at = given_at + time '10:30' + random() * interval '6 hours', updated_at = given_at + time '17:00'
          where created_at::date > given_at + 1`,
      ],
      [
        'randevular',
        `update appointments set created_at = starts_at - (floor(random() * 10) + 1) * interval '1 day',
                arrived_at = case when arrived_at is not null then starts_at - interval '6 minutes' end,
                started_at = case when started_at is not null then starts_at + interval '4 minutes' end,
                finished_at = case when finished_at is not null then ends_at end,
                cancelled_at = case when cancelled_at is not null then starts_at - interval '1 day' end,
                updated_at = least(now(), ends_at)
          where starts_at < now() - interval '1 day' and created_at > starts_at`,
      ],
    ]
    for (const [label, sqlText] of fixes) {
      const r = await su.query(sqlText)
      console.log(`[tarih] ${label}: ${r.rowCount}`)
    }
    await su.query('commit')
  } catch (e) {
    await su.query('rollback').catch(() => undefined)
    throw e
  } finally {
    await su.end()
  }
} finally {
  await backend.db.$client.end().catch(() => undefined)
  if (dev) await backend.supervisor.stop().catch(() => undefined)
}
process.exit(0)
