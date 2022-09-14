// Sağlayıcı seçimi + şifreli sır deposu (secrets_kv).
import { sql } from 'drizzle-orm'
import type { Db } from '../../../db/client'
import type { AppDeps } from '../../context'
import type { ClinicSettings } from '../../../../shared/settings'
import { logProvider } from './log'
import { netgsmProvider } from './netgsm'
import { iletimerkeziProvider } from './iletimerkezi'
import { smtpProvider } from './email'
import type { MessageProvider } from './types'

export type { MessageProvider, SendResult, BalanceResult } from './types'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Sır anahtarları (ayarlarda yalnızca bu adlar saklanır) */
export const SECRET_KEYS = { sms: 'messaging.sms.password', email: 'messaging.email.password' } as const

export async function setSecret(db: Db | Tx, crypto: AppDeps['crypto'], key: string, value: string | null): Promise<void> {
  if (!value) {
    await db.execute(sql`delete from secrets_kv where key = ${key}`)
    return
  }
  const enc = crypto.encrypt(value)
  await db.execute(sql`insert into secrets_kv (key, value_enc) values (${key}, ${enc})
    on conflict (key) do update set value_enc = excluded.value_enc, updated_at = now()`)
}

export async function getSecret(db: Db | Tx, crypto: AppDeps['crypto'], key: string | undefined | null): Promise<string | null> {
  if (!key) return null
  const r = await db.execute<{ value_enc: string }>(sql`select value_enc from secrets_kv where key = ${key}`)
  const row = r.rows[0]
  return row ? crypto.decrypt(row.value_enc) : null
}

export async function hasSecret(db: Db | Tx, key: string | undefined | null): Promise<boolean> {
  if (!key) return false
  const r = await db.execute(sql`select 1 from secrets_kv where key = ${key}`)
  return r.rows.length > 0
}

export interface Providers {
  sms: MessageProvider | null
  email: MessageProvider | null
  /** Neden yok (arayüz/hata için) */
  smsReason?: string
  emailReason?: string
}

/** Ayarlara göre sağlayıcıları kurar. Eksik ayar varsa ilgili kanal null döner. */
export async function createProviders(deps: Pick<AppDeps, 'db' | 'crypto' | 'log'>, settings: ClinicSettings): Promise<Providers> {
  const m = settings.messaging
  const out: Providers = { sms: null, email: null }

  const sms = m.sms
  if (sms.provider === 'log') out.sms = logProvider(deps.log, 'sms')
  else if (sms.provider === 'none') out.smsReason = 'SMS sağlayıcı seçilmemiş.'
  else {
    const secret = await getSecret(deps.db, deps.crypto, sms.secretRef)
    if (!sms.username || !secret || !sms.header) out.smsReason = 'SMS sağlayıcı bilgileri eksik (kullanıcı, parola/anahtar, başlık).'
    else if (sms.provider === 'netgsm') out.sms = netgsmProvider({ username: sms.username, password: secret, header: sms.header })
    else if (sms.provider === 'iletimerkezi') out.sms = iletimerkeziProvider({ apiKey: sms.username, apiHash: secret, header: sms.header })
  }

  const em = m.email
  if (!em.enabled) out.emailReason = 'E-posta gönderimi kapalı.'
  else if (em.host === 'log') out.email = logProvider(deps.log, 'email')
  else if (!em.host || !em.from) out.emailReason = 'SMTP sunucusu ya da gönderen adresi eksik.'
  else {
    const pass = await getSecret(deps.db, deps.crypto, em.secretRef)
    out.email = smtpProvider({ host: em.host, port: em.port ?? 587, secure: em.secure ?? false, user: em.user, password: pass ?? undefined, from: em.from })
  }
  return out
}
