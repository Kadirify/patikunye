// Değiştirilemez denetim kaydı: her satır bir öncekinin özetini içerir (hash zinciri).
import { desc, sql } from 'drizzle-orm'
import { auditLogs } from '../db/schema'
import { sha256 } from '../crypto'
import type { Db } from '../db/client'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface AuditEntry {
  userId: string | null
  action:
    | 'create'
    | 'update'
    | 'delete'
    | 'view_sensitive'
    | 'export'
    | 'login'
    | 'login_failed'
    | 'setup'
    | 'petvet_done'
    | 'merge'
    | 'anonymize'
    | 'password_change'
    | 'restore'
    | 'backup'
  entity: string
  entityId?: string | null
  summary?: string
  diff?: unknown
}

/**
 * Kanonik biçim: nesne anahtarları özyinelemeli sıralı. PostgreSQL jsonb anahtar sırasını değiştirdiği için
 * hash bu biçim üzerinden hesaplanır; doğrulama (admin.ts) da aynı biçimi kullanır.
 */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export async function writeAudit(tx: Tx | Db, e: AuditEntry) {
  // Zincirin sırası bozulmasın diye aynı anda tek yazar
  await tx.execute(sql`select pg_advisory_xact_lock(7240001)`)
  const [last] = await tx.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.id)).limit(1)
  const prevHash = last?.hash ?? null
  const at = new Date().toISOString()
  const diff = e.diff === undefined || e.diff === null ? null : canonical(e.diff)
  const hash = sha256(JSON.stringify([prevHash, at, e.userId, e.action, e.entity, e.entityId ?? null, e.summary ?? null, diff]))
  await tx.insert(auditLogs).values({
    at: new Date(at),
    userId: e.userId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    summary: e.summary ?? null,
    diff: e.diff ?? null,
    prevHash,
    hash,
  })
}
