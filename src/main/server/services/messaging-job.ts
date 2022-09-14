// Gönderim motoru (S-80): kuyruktaki hatırlatmaları sessiz saatlere uyarak gönderir.
// Arka plan işi 5 dakikada bir çalışır; test ve "Şimdi gönder" için fonksiyonlar dışa aktarılır.
import { sql } from 'drizzle-orm'
import type { Job } from './jobs'
import type { AppDeps } from '../context'
import { getSettings } from '../settings'
import { renderReminder } from './reminders'
import { createProviders, type MessageProvider, type Providers } from './sms'
import { isQuietTime, smsSegments, type MessageChannel, type ProcessResult } from '../../../shared/messaging'

/** Hata sonrası tekrar deneme aralıkları: 5 dk, 30 dk, 2 sa (3 tekrar → sonra kalıcı başarısız) */
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000]
/** Bu süreden eski kaçırılmış randevu hatırlatması gönderilmez */
export const APPOINTMENT_EXPIRE_MS = 24 * 3600_000
const BATCH = 100

type Deps = Pick<AppDeps, 'db' | 'crypto' | 'log' | 'now'>

export interface ProcessOptions {
  /** Testlerde sahte sağlayıcı */
  providers?: Partial<Record<MessageChannel, MessageProvider | null>>
}

type ReminderRow = {
  id: string
  kind: string
  owner_id: string
  animal_id: string | null
  channel: MessageChannel
  to_address: string | null
  template_key: string
  vars: Record<string, string>
  body_override: string | null
  attempts: number
  reminder_consent: boolean
  preferred_channel: string
  animal_status: string | null
}

async function resolveProviders(deps: Deps, opts?: ProcessOptions): Promise<Providers> {
  const settings = await getSettings(deps.db)
  const real = await createProviders(deps, settings)
  if (!opts?.providers) return real
  return {
    ...real,
    sms: opts.providers.sms !== undefined ? opts.providers.sms : real.sms,
    email: opts.providers.email !== undefined ? opts.providers.email : real.email,
  }
}

const SELECT_REMINDER = sql`select r.id, r.kind, r.owner_id, r.animal_id, r.channel, r.to_address, r.template_key, r.vars,
    r.body_override, r.attempts, o.reminder_consent, o.preferred_channel, a.status as animal_status
  from reminders r join owners o on o.id = r.owner_id left join animals a on a.id = r.animal_id`

export type SendOutcome = { status: 'sent' | 'failed' | 'permanent_failed' | 'cancelled' | 'no_consent' | 'skipped'; error?: string | null }

/** Tek bir hatırlatmayı gönderir, messages kaydını ve hatırlatma durumunu günceller. */
export async function sendReminder(deps: Deps, r: ReminderRow, providers: Providers, userId: string | null = null): Promise<SendOutcome> {
  const { db } = deps
  const now = deps.now?.() ?? new Date()

  // Gönderim anında yeniden kontrol: izin geri çekildi mi, hayvan öldü mü?
  if (!r.reminder_consent || r.preferred_channel === 'none') {
    await db.execute(sql`update reminders set status = 'no_consent', cancelled_reason = 'Sahip hatırlatma mesajı almak istemiyor.', updated_at = now() where id = ${r.id}`)
    return { status: 'no_consent' }
  }
  if (r.animal_status === 'dead') {
    await db.execute(sql`update reminders set status = 'cancelled', cancelled_reason = 'Hayvan ölü olarak kayıtlı.', updated_at = now() where id = ${r.id}`)
    return { status: 'cancelled' }
  }
  if (!r.to_address) {
    await db.execute(sql`update reminders set status = 'no_consent', cancelled_reason = 'Alıcı adresi yok.', updated_at = now() where id = ${r.id}`)
    return { status: 'no_consent' }
  }
  const provider = r.channel === 'sms' ? providers.sms : providers.email
  if (!provider) {
    // Sağlayıcı ayarlanmamış: deneme hakkı yakılmaz, ayar yapılınca gönderilir
    const error = (r.channel === 'sms' ? providers.smsReason : providers.emailReason) ?? 'Sağlayıcı ayarlı değil.'
    await db.execute(sql`update reminders set last_error = ${error}, updated_at = now() where id = ${r.id}`)
    return { status: 'skipped', error }
  }

  const { subject, body } = await renderReminder(db, r)
  const res = await provider.send(r.to_address, body, { subject })
  const units = r.channel === 'sms' ? Math.max(1, smsSegments(body).segments) : 1
  await db.execute(sql`insert into messages (reminder_id, owner_id, channel, to_address, body, status, provider, provider_msg_id, error, sent_at, cost_units, sent_by)
    values (${r.id}, ${r.owner_id}, ${r.channel}, ${r.to_address}, ${body}, ${res.ok ? 'sent' : 'failed'}, ${provider.name},
      ${res.providerMsgId}, ${res.error}, ${now.toISOString()}, ${res.ok ? units : 0}, ${userId})`)

  if (res.ok) {
    await db.execute(sql`update reminders set status = 'sent', sent_at = ${now.toISOString()}, provider_msg_id = ${res.providerMsgId},
      attempts = attempts + 1, last_error = null, next_attempt_at = null, updated_at = now() where id = ${r.id}`)
    return { status: 'sent' }
  }
  const attempts = r.attempts + 1
  const delay = RETRY_DELAYS_MS[attempts - 1]
  if (res.permanent || delay === undefined) {
    await db.execute(sql`update reminders set status = 'permanent_failed', attempts = ${attempts}, last_error = ${res.error},
      next_attempt_at = null, updated_at = now() where id = ${r.id}`)
    return { status: 'permanent_failed', error: res.error }
  }
  await db.execute(sql`update reminders set status = 'failed', attempts = ${attempts}, last_error = ${res.error},
    next_attempt_at = ${new Date(now.getTime() + delay).toISOString()}, updated_at = now() where id = ${r.id}`)
  return { status: 'failed', error: res.error }
}

/** Kuyruğu işler: süresi geçenleri işaretler, sessiz saat dışındaysa zamanı gelenleri gönderir. */
export async function processDueReminders(deps: Deps, opts?: ProcessOptions): Promise<ProcessResult> {
  const { db } = deps
  const now = deps.now?.() ?? new Date()
  const result: ProcessResult = { sent: 0, failed: 0, expired: 0, skipped: 0, quiet: false }

  // 24 saatten eski kaçırılmış randevu hatırlatması ya da randevu saati geçmişse: "süresi geçti"
  const cutoff = new Date(now.getTime() - APPOINTMENT_EXPIRE_MS).toISOString()
  const exp = await db.execute(sql`update reminders set status = 'expired', cancelled_reason = 'Gönderim zamanı kaçırıldı.', updated_at = now()
    where kind in ('appointment', 'appointment_confirm') and status in ('planned', 'queued', 'failed')
      and (send_at < ${cutoff} or (event_at is not null and event_at < ${now.toISOString()}))`)
  result.expired = exp.rowCount ?? 0

  const settings = await getSettings(db)
  if (isQuietTime(now, settings.messaging.quietStart, settings.messaging.quietEnd)) {
    result.quiet = true
    return result
  }

  const due = await db.execute<ReminderRow>(sql`${SELECT_REMINDER}
    where (r.status in ('planned', 'queued') and r.send_at <= ${now.toISOString()})
       or (r.status = 'failed' and coalesce(r.next_attempt_at, r.send_at) <= ${now.toISOString()})
    order by r.send_at limit ${BATCH}`)
  if (due.rows.length === 0) return result

  const providers = await resolveProviders(deps, opts)
  for (const r of due.rows) {
    try {
      const o = await sendReminder(deps, r, providers)
      if (o.status === 'sent') result.sent++
      else if (o.status === 'failed' || o.status === 'permanent_failed') result.failed++
      else result.skipped++
    } catch (e) {
      deps.log?.(`[mesaj] ${r.id}: ${(e as Error).message}`)
      result.failed++
    }
  }
  return result
}

/** "Şimdi gönder" (S-80): sessiz saatleri yok sayar, kullanıcı açıkça istemiştir. */
export async function sendReminderNow(deps: Deps, id: string, userId: string, opts?: ProcessOptions): Promise<SendOutcome | null> {
  const r = (await deps.db.execute<ReminderRow>(sql`${SELECT_REMINDER} where r.id = ${id}`)).rows[0]
  if (!r) return null
  const providers = await resolveProviders(deps, opts)
  return sendReminder(deps, r, providers, userId)
}

export const messagingJob: Job = {
  name: 'messaging',
  everyMs: 5 * 60_000,
  async run(deps) {
    const r = await processDueReminders(deps)
    if (r.sent || r.failed || r.expired) deps.log?.(`[mesaj] gönderildi ${r.sent}, başarısız ${r.failed}, süresi geçti ${r.expired}`)
  },
}
