// Veritabanı durumu, bakım ve tanı paketi (S-111, S-02 "Tanı paketini kaydet")
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppDeps } from '../../context'
import type { DbMigrationInfo, DbStatusDto, DbTableInfo, DiagnosticsDto } from '../../../../shared/backup'
import { APP_VERSION, getBackupStatus } from './index'

const qi = (s: string) => '"' + s.replace(/"/g, '""') + '"'
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

export async function tableStats(deps: AppDeps): Promise<DbTableInfo[]> {
  const db = deps.db.$client
  const r = await db.query<{ relname: string; total: string; last_vacuum: Date | null; last_analyze: Date | null }>(
    `select c.relname, pg_total_relation_size(c.oid)::text as total,
            greatest(s.last_vacuum, s.last_autovacuum) as last_vacuum,
            greatest(s.last_analyze, s.last_autoanalyze) as last_analyze
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition
      order by pg_total_relation_size(c.oid) desc, c.relname`,
  )
  const out: DbTableInfo[] = []
  for (const t of r.rows) {
    const c = await db.query(`select count(*)::bigint::text as n from public.${qi(t.relname)}`)
    out.push({ name: t.relname, rows: Number(c.rows[0].n), totalBytes: Number(t.total), lastVacuum: iso(t.last_vacuum), lastAnalyze: iso(t.last_analyze) })
  }
  return out
}

export async function migrationHistory(deps: AppDeps): Promise<DbMigrationInfo[]> {
  const db = deps.db.$client
  const out: DbMigrationInfo[] = []
  try {
    const d = await db.query<{ hash: string; created_at: string }>('select hash, created_at::text from drizzle.__drizzle_migrations order by id')
    d.rows.forEach((x, i) => out.push({ name: `drizzle #${i + 1} (${x.hash.slice(0, 10)})`, appliedAt: x.created_at ? new Date(Number(x.created_at)).toISOString() : null, kind: 'drizzle' }))
  } catch {
    /* yok */
  }
  try {
    const m = await db.query<{ name: string; applied_at: Date }>('select name, applied_at from pk_migrations order by name')
    for (const x of m.rows) out.push({ name: x.name, appliedAt: iso(x.applied_at), kind: 'module' })
  } catch {
    /* yok */
  }
  return out
}

export async function dbStatus(deps: AppDeps): Promise<DbStatusDto> {
  const db = deps.db.$client
  const v = await db.query<{ v: string; port: number | null; size: string }>(
    `select current_setting('server_version') as v, inet_server_port() as port, pg_database_size(current_database())::text as size`,
  )
  const tables = await tableStats(deps)
  const times = tables.flatMap((t) => [t.lastVacuum, t.lastAnalyze]).filter((x): x is string => !!x).sort()
  return {
    running: true,
    version: v.rows[0].v,
    port: v.rows[0].port,
    dataDir: join(deps.dataRoot, 'pgdata'),
    sizeBytes: Number(v.rows[0].size),
    tables,
    migrations: await migrationHistory(deps),
    lastMaintenanceAt: times.length ? times[times.length - 1] : null,
  }
}

/** VACUUM ANALYZE — transaction dışında (havuzdan tek komut, otomatik commit) */
export async function runMaintenance(deps: AppDeps): Promise<{ ms: number }> {
  const t0 = Date.now()
  await deps.db.$client.query('vacuum (analyze)')
  return { ms: Date.now() - t0 }
}

/** Log satırlarından kişisel veri olabilecek kısımları maskeler */
export function redactLogLine(line: string): string {
  return line
    .replace(/'(?:[^']|'')*'/g, "'***'")
    .replace(/=\((.*?)\)/g, '=(***)')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***')
    .replace(/\d{6,}/g, '***')
}

export async function tailLines(file: string, n: number, maxBytes = 512 * 1024): Promise<string[]> {
  try {
    const st = await stat(file)
    const len = Math.min(st.size, maxBytes)
    const fh = await open(file, 'r')
    const buf = Buffer.alloc(len)
    try {
      await fh.read(buf, 0, len, st.size - len)
    } finally {
      await fh.close()
    }
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (len < st.size) lines.shift() // yarım ilk satır
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-n)
  } catch {
    return []
  }
}

/** Kişisel veri içermeyen tanı paketi */
export async function diagnostics(deps: AppDeps): Promise<DiagnosticsDto> {
  const db = deps.db.$client
  const v = await db.query<{ v: string; size: string }>(`select version() as v, pg_database_size(current_database())::text as size`)
  const tables = await tableStats(deps)
  const st = await getBackupStatus(deps)
  return {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    appVersion: APP_VERSION,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    postgres: v.rows[0].v,
    dbSizeBytes: Number(v.rows[0].size),
    tables: tables.map((t) => ({ name: t.name, rows: t.rows })),
    migrations: (await migrationHistory(deps)).map((m) => m.name),
    backup: { lastSuccessAt: st.lastSuccessAt, state: st.state },
    postgresLog: (await tailLines(join(deps.dataRoot, 'postgres.log'), 500)).map(redactLogLine),
  }
}
