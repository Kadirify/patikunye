// Modül migration'ları: migrations/*.sql dosyaları ada göre sırayla, bir kez çalıştırılır.
// (drizzle/ klasöründeki ilk şema drizzle'ın kendi migrator'ıyla çalışır; modüller buraya ekler.)
// Dosya adı biçimi: NNN_modul_aciklama.sql — NNN modül bloğu: 100 temel, 200 sahip/hayvan, 300 muayene,
// 400 aşı, 500 mesaj, 600 randevu, 700 ayarlar/kvkk, 800 yedek, 900 rapor, 950 ağ.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './client'

export async function runModuleMigrations(db: Db, folder: string, log?: (m: string) => void) {
  if (!existsSync(folder)) return
  const client = await db.$client.connect()
  try {
    await client.query(`create table if not exists pk_migrations (name text primary key, applied_at timestamptz not null default now())`)
    const done = new Set((await client.query<{ name: string }>('select name from pk_migrations')).rows.map((r) => r.name))
    const files = readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files) {
      if (done.has(f)) continue
      const sqlText = readFileSync(join(folder, f), 'utf8')
      log?.(`[migrate] ${f}`)
      await client.query('begin')
      try {
        await client.query(sqlText)
        await client.query('insert into pk_migrations(name) values ($1)', [f])
        await client.query('commit')
      } catch (e) {
        await client.query('rollback')
        throw new Error(`Migration başarısız: ${f}: ${(e as Error).message}`, { cause: e })
      }
    }
  } finally {
    client.release()
  }
}
