// Mesajlar modülü API'si (kuyruk, geçmiş, ayarlar, şablonlar)
import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { AppError, parse, requirePerm, type AppDeps } from '../context'
import { writeAudit } from '../audit'
import { getSettings, updateSettings } from '../settings'
import { todayIstanbul } from '../../../shared/petvet'
import { normalizeTrMobile } from '../../../shared/identity'
import { clinicVars, istanbulDateTime, renderReminder, setReminderClock } from '../services/reminders'
import { sendReminderNow } from '../services/messaging-job'
import { createProviders, hasSecret, SECRET_KEYS, setSecret } from '../services/sms'
import {
  fillTemplate,
  maskAddress,
  SAMPLE_VARS,
  smsSegments,
  unknownVariables,
  QUEUE_TABS,
  type BalanceDto,
  type MessageHistoryItem,
  type MessageHistoryResult,
  type MessageTemplateDto,
  type MessagingSettingsDto,
  type MessagingSummary,
  type QueueTab,
  type ReminderListItem,
  type ReminderListResult,
  type ReminderPreview,
} from '../../../shared/messaging'

const PAGE_SIZE = 50
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Saat SS:dd biçiminde olmalı.')
const channelSchema = z.enum(['sms', 'email'], { message: 'Kanal SMS ya da e-posta olmalı.' })

export function messagingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps
  const now = () => deps.now?.() ?? new Date()
  setReminderClock(now)

  /** Sekme koşulları. "Bugün" = gün sonuna kadar zamanı gelen bekleyenler (gecikmiş olanlar dahil). */
  function tabWhere(tab: QueueTab): SQL {
    const endOfToday = istanbulDateTime(todayIstanbul(now()), '23:59').toISOString()
    switch (tab) {
      case 'planned':
        return sql`r.status in ('planned', 'queued') and r.send_at > ${endOfToday}`
      case 'today':
        return sql`((r.status in ('planned', 'queued') and r.send_at <= ${endOfToday}) or (r.status = 'failed'))`
      case 'sent':
        return sql`r.status in ('sent', 'delivered')`
      case 'failed':
        return sql`r.status in ('failed', 'permanent_failed')`
      case 'cancelled':
        return sql`r.status in ('cancelled', 'no_consent', 'expired')`
    }
  }

  async function loadReminder(id: string) {
    const r = (
      await db.execute<{ id: string; status: string; template_key: string; channel: 'sms' | 'email'; vars: Record<string, string>; body_override: string | null }>(
        sql`select id, status, template_key, channel, vars, body_override from reminders where id = ${id}`,
      )
    ).rows[0]
    if (!r) throw new AppError(404, 'Hatırlatma bulunamadı.', 'NOT_FOUND')
    return r
  }

  /* ---------- kuyruk ---------- */

  app.get('/api/messaging/summary', async (req) => {
    requirePerm(req, 'messages.send')
    const tabs = {} as Record<QueueTab, number>
    for (const t of QUEUE_TABS) {
      const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from reminders r where ${tabWhere(t)}`)
      tabs[t] = r.rows[0].n
    }
    const monthStart = istanbulDateTime(todayIstanbul(now()).slice(0, 8) + '01', '00:00').toISOString()
    const m = (
      await db.execute<{ n: number; units: number }>(sql`select count(*)::int as n, coalesce(sum(cost_units) filter (where channel = 'sms'), 0)::int as units
        from messages where status in ('sent', 'delivered') and not is_test and sent_at >= ${monthStart}`)
    ).rows[0]
    const s = await getSettings(db)
    return {
      tabs,
      sentThisMonth: m.n,
      smsUnitsThisMonth: m.units,
      provider: s.messaging.sms.provider,
      emailEnabled: s.messaging.email.enabled,
    } satisfies MessagingSummary
  })

  app.get('/api/messaging/reminders', async (req) => {
    requirePerm(req, 'messages.send')
    const q = parse(
      z.object({
        tab: z.enum(QUEUE_TABS).default('today'),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    )
    const conds: SQL[] = [tabWhere(q.tab)]
    if (q.q) {
      const like = `%${q.q}%`
      const digits = q.q.replace(/\D/g, '')
      conds.push(sql`(pk_norm(o.first_name || ' ' || o.last_name) like pk_norm(${like}) or pk_norm(coalesce(a.name, '')) like pk_norm(${like})
        ${digits.length >= 3 ? sql`or r.to_address like ${'%' + digits.replace(/^0/, '') + '%'}` : sql``})`)
    }
    const where = sql.join(conds, sql` and `)
    const order = q.tab === 'planned' || q.tab === 'today' ? sql`r.send_at asc` : sql`coalesce(r.sent_at, r.updated_at) desc`
    const from = sql`from reminders r join owners o on o.id = r.owner_id left join animals a on a.id = r.animal_id where ${where}`
    const total = (await db.execute<{ n: number }>(sql`select count(*)::int as n ${from}`)).rows[0].n
    const rows = await db.execute<{
      id: string; kind: string; channel: 'sms' | 'email'; to_address: string | null; owner_id: string; owner_name: string
      animal_id: string | null; animal_name: string | null; template_key: string; status: ReminderListItem['status']
      send_at: Date; event_at: Date | null; attempts: number; next_attempt_at: Date | null; last_error: string | null
      cancelled_reason: string | null; sent_at: Date | null; body_override: string | null
    }>(sql`select r.id, r.kind, r.channel, r.to_address, r.owner_id, o.first_name || ' ' || o.last_name as owner_name,
        r.animal_id, a.name as animal_name, r.template_key, r.status, r.send_at, r.event_at, r.attempts, r.next_attempt_at,
        r.last_error, r.cancelled_reason, r.sent_at, r.body_override
      ${from} order by ${order} limit ${PAGE_SIZE} offset ${(q.page - 1) * PAGE_SIZE}`)
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        channel: r.channel,
        toMasked: maskAddress(r.to_address),
        ownerId: r.owner_id,
        ownerName: r.owner_name,
        animalId: r.animal_id,
        animalName: r.animal_name,
        templateKey: r.template_key,
        status: r.status,
        sendAt: iso(r.send_at)!,
        eventAt: iso(r.event_at),
        attempts: r.attempts,
        nextAttemptAt: iso(r.next_attempt_at),
        lastError: r.last_error,
        cancelledReason: r.cancelled_reason,
        sentAt: iso(r.sent_at),
        hasOverride: !!r.body_override,
      })),
      total,
      page: q.page,
      pageSize: PAGE_SIZE,
    } satisfies ReminderListResult
  })

  app.get('/api/messaging/reminders/:id/preview', async (req) => {
    requirePerm(req, 'messages.send')
    const { id } = parse(z.object({ id: z.string().uuid('Geçersiz kimlik.') }), req.params)
    const r = await loadReminder(id)
    const out = await renderReminder(db, r)
    return {
      id,
      channel: r.channel,
      subject: out.subject,
      body: out.body,
      templateBody: out.templateBody,
      hasOverride: !!r.body_override,
      count: smsSegments(out.body),
    } satisfies ReminderPreview
  })

  app.post('/api/messaging/reminders/:id/send-now', async (req) => {
    const u = requirePerm(req, 'messages.send')
    const { id } = parse(z.object({ id: z.string().uuid('Geçersiz kimlik.') }), req.params)
    const r = await loadReminder(id)
    if (!['planned', 'queued', 'failed', 'permanent_failed'].includes(r.status)) {
      throw new AppError(409, 'Bu hatırlatma gönderilemez (zaten gönderilmiş ya da iptal edilmiş).', 'INVALID_STATE')
    }
    if (r.status === 'permanent_failed') await db.execute(sql`update reminders set attempts = 0 where id = ${id}`)
    const out = await sendReminderNow(deps, id, u.id)
    await writeAudit(db, { userId: u.id, action: 'update', entity: 'reminder', entityId: id, summary: `Hatırlatma elle gönderildi: ${out?.status}` })
    if (out?.status === 'skipped') throw new AppError(409, out.error ?? 'Sağlayıcı ayarlı değil.', 'PROVIDER_NOT_CONFIGURED')
    return { status: out?.status, error: out?.error ?? null }
  })

  app.post('/api/messaging/reminders/:id/retry', async (req) => {
    const u = requirePerm(req, 'messages.send')
    const { id } = parse(z.object({ id: z.string().uuid('Geçersiz kimlik.') }), req.params)
    const r = await loadReminder(id)
    if (!['failed', 'permanent_failed', 'expired'].includes(r.status)) {
      throw new AppError(409, 'Yalnızca başarısız ya da süresi geçmiş hatırlatmalar yeniden denenebilir.', 'INVALID_STATE')
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`update reminders set status = 'queued', attempts = 0, next_attempt_at = null, send_at = ${now().toISOString()},
        cancelled_reason = null, updated_at = now() where id = ${id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'reminder', entityId: id, summary: 'Hatırlatma yeniden kuyruğa alındı' })
    })
    return { ok: true }
  })

  app.post('/api/messaging/reminders/:id/cancel', async (req) => {
    const u = requirePerm(req, 'messages.send')
    const { id } = parse(z.object({ id: z.string().uuid('Geçersiz kimlik.') }), req.params)
    const body = parse(z.object({ reason: z.string().trim().max(200).optional() }), req.body ?? {})
    const r = await loadReminder(id)
    if (!['planned', 'queued', 'failed'].includes(r.status)) throw new AppError(409, 'Bu hatırlatma artık iptal edilemez.', 'INVALID_STATE')
    await db.transaction(async (tx) => {
      await tx.execute(sql`update reminders set status = 'cancelled', cancelled_reason = ${body.reason || 'Elle iptal edildi'}, updated_at = now() where id = ${id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'reminder', entityId: id, summary: `Hatırlatma iptal edildi${body.reason ? ': ' + body.reason : ''}` })
    })
    return { ok: true }
  })

  /** "Düzenle": yalnızca bu mesaj için metin (null -> şablona dön) */
  app.put('/api/messaging/reminders/:id/body', async (req) => {
    const u = requirePerm(req, 'messages.send')
    const { id } = parse(z.object({ id: z.string().uuid('Geçersiz kimlik.') }), req.params)
    const body = parse(z.object({ body: z.string().trim().min(1, 'Mesaj metni boş olamaz.').max(1000, 'Mesaj en fazla 1000 karakter olabilir.').nullable() }), req.body)
    const r = await loadReminder(id)
    if (!['planned', 'queued', 'failed'].includes(r.status)) throw new AppError(409, 'Gönderilmiş ya da iptal edilmiş mesaj düzenlenemez.', 'INVALID_STATE')
    await db.transaction(async (tx) => {
      await tx.execute(sql`update reminders set body_override = ${body.body}, updated_at = now() where id = ${id}`)
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'reminder', entityId: id, summary: body.body ? 'Mesaj metni düzenlendi' : 'Mesaj metni şablona döndürüldü' })
    })
    return { ok: true }
  })

  /* ---------- mesaj geçmişi ---------- */

  app.get('/api/messaging/messages', async (req) => {
    requirePerm(req, 'messages.send')
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG olmalı.').optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG olmalı.').optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    )
    const conds: SQL[] = [sql`true`]
    if (q.q) {
      const digits = q.q.replace(/\D/g, '')
      const phone = digits.length >= 3 ? (normalizeTrMobile(q.q) ?? digits.replace(/^0/, '')) : null
      conds.push(sql`(pk_norm(coalesce(o.first_name || ' ' || o.last_name, '')) like pk_norm(${'%' + q.q + '%'})
        or m.to_address ilike ${'%' + q.q + '%'} ${phone ? sql`or m.to_address like ${'%' + phone.replace(/^\+90/, '') + '%'}` : sql``})`)
    }
    if (q.from) conds.push(sql`m.sent_at >= ${istanbulDateTime(q.from, '00:00').toISOString()}`)
    if (q.to) conds.push(sql`m.sent_at < ${new Date(istanbulDateTime(q.to, '00:00').getTime() + 86400_000).toISOString()}`)
    const from = sql`from messages m left join owners o on o.id = m.owner_id where ${sql.join(conds, sql` and `)}`
    const total = (await db.execute<{ n: number }>(sql`select count(*)::int as n ${from}`)).rows[0].n
    const rows = await db.execute<{
      id: string; reminder_id: string | null; owner_id: string | null; owner_name: string | null; channel: 'sms' | 'email'
      to_address: string; body: string; status: string; provider: string; provider_msg_id: string | null; error: string | null
      sent_at: Date; cost_units: number; is_test: boolean
    }>(sql`select m.id, m.reminder_id, m.owner_id, o.first_name || ' ' || o.last_name as owner_name, m.channel, m.to_address, m.body,
        m.status, m.provider, m.provider_msg_id, m.error, m.sent_at, m.cost_units, m.is_test
      ${from} order by m.sent_at desc limit ${PAGE_SIZE} offset ${(q.page - 1) * PAGE_SIZE}`)
    return {
      items: rows.rows.map(
        (m): MessageHistoryItem => ({
          id: m.id,
          reminderId: m.reminder_id,
          ownerId: m.owner_id,
          ownerName: m.owner_name,
          channel: m.channel,
          to: m.to_address,
          body: m.body,
          status: m.status,
          provider: m.provider,
          providerMsgId: m.provider_msg_id,
          error: m.error,
          sentAt: new Date(m.sent_at).toISOString(),
          costUnits: m.cost_units,
          isTest: m.is_test,
        }),
      ),
      total,
      page: q.page,
      pageSize: PAGE_SIZE,
    } satisfies MessageHistoryResult
  })

  /* ---------- şablonlar ---------- */

  const mapTpl = (t: { key: string; channel: 'sms' | 'email'; subject: string | null; body: string; builtin: boolean; updated_at: Date }): MessageTemplateDto => ({
    key: t.key,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    builtin: t.builtin,
    updatedAt: new Date(t.updated_at).toISOString(),
  })
  const tplParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Şablon anahtarı küçük harf, rakam ve _ içermeli.'), channel: channelSchema })
  const tplBody = z.object({
    subject: z.string().trim().max(200, 'Konu en fazla 200 karakter olabilir.').nullable().optional(),
    body: z.string().trim().min(1, 'Şablon metni boş olamaz.').max(2000, 'Şablon en fazla 2000 karakter olabilir.'),
  })
  function checkVars(body: string, subject?: string | null) {
    const bad = unknownVariables(`${body} ${subject ?? ''}`)
    if (bad.length) throw new AppError(400, `Bilinmeyen değişken: ${bad.map((b) => `{${b}}`).join(', ')}`, 'UNKNOWN_VARIABLE', bad)
  }

  app.get('/api/messaging/templates', async (req) => {
    requirePerm(req, 'messages.send')
    const r = await db.execute<Parameters<typeof mapTpl>[0]>(sql`select key, channel, subject, body, builtin, updated_at from message_templates order by builtin desc, key, channel`)
    return r.rows.map(mapTpl)
  })

  app.post('/api/messaging/templates', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(tplParams.extend(tplBody.shape), req.body)
    checkVars(b.body, b.subject)
    return db.transaction(async (tx) => {
      const r = await tx.execute(sql`insert into message_templates (key, channel, subject, body) values (${b.key}, ${b.channel}, ${b.subject ?? null}, ${b.body})
        on conflict (key, channel) do nothing returning key`)
      if (!r.rows.length) throw new AppError(409, 'Bu anahtar ve kanal için şablon zaten var.', 'DUPLICATE')
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'message_template', entityId: `${b.key}/${b.channel}`, summary: 'Mesaj şablonu eklendi' })
      return { ok: true }
    })
  })

  app.put('/api/messaging/templates/:key/:channel', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const p = parse(tplParams, req.params)
    const b = parse(tplBody, req.body)
    checkVars(b.body, b.subject)
    return db.transaction(async (tx) => {
      const old = (await tx.execute<{ body: string; subject: string | null }>(sql`select body, subject from message_templates where key = ${p.key} and channel = ${p.channel}`)).rows[0]
      if (!old) throw new AppError(404, 'Şablon bulunamadı.', 'NOT_FOUND')
      await tx.execute(sql`update message_templates set body = ${b.body}, subject = ${b.subject ?? null}, updated_at = now() where key = ${p.key} and channel = ${p.channel}`)
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'message_template',
        entityId: `${p.key}/${p.channel}`,
        summary: 'Mesaj şablonu güncellendi',
        diff: { before: old, after: { body: b.body, subject: b.subject ?? null } },
      })
      return { ok: true }
    })
  })

  app.delete('/api/messaging/templates/:key/:channel', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const p = parse(tplParams, req.params)
    return db.transaction(async (tx) => {
      const t = (await tx.execute<{ builtin: boolean }>(sql`select builtin from message_templates where key = ${p.key} and channel = ${p.channel}`)).rows[0]
      if (!t) throw new AppError(404, 'Şablon bulunamadı.', 'NOT_FOUND')
      if (t.builtin) throw new AppError(409, 'Uygulamayla gelen şablonlar silinemez, yalnızca düzenlenebilir.', 'BUILTIN')
      await tx.execute(sql`delete from message_templates where key = ${p.key} and channel = ${p.channel}`)
      await writeAudit(tx, { userId: u.id, action: 'delete', entity: 'message_template', entityId: `${p.key}/${p.channel}`, summary: 'Mesaj şablonu silindi' })
      return { ok: true }
    })
  })

  /** Önizleme: örnek değişkenlerle doldurulmuş metin + SMS sayacı */
  app.post('/api/messaging/templates/preview', async (req) => {
    requirePerm(req, 'messages.send')
    const b = parse(z.object({ body: z.string().max(2000), subject: z.string().max(200).nullable().optional() }), req.body)
    const vars = { ...SAMPLE_VARS, ...(await clinicVars(db)) }
    const body = fillTemplate(b.body, vars)
    return { body, subject: b.subject ? fillTemplate(b.subject, vars) : null, count: smsSegments(body), unknown: unknownVariables(b.body) }
  })

  /* ---------- ayarlar ---------- */

  async function settingsDto(): Promise<MessagingSettingsDto> {
    const m = (await getSettings(db)).messaging
    return {
      quietStart: m.quietStart,
      quietEnd: m.quietEnd,
      vaccineOffsetsDays: m.vaccineOffsetsDays,
      appointmentOffsetHours: m.appointmentOffsetHours,
      sms: { provider: m.sms.provider, username: m.sms.username ?? '', header: m.sms.header ?? '', secretSet: await hasSecret(db, m.sms.secretRef) },
      email: {
        enabled: m.email.enabled,
        host: m.email.host ?? '',
        port: m.email.port ?? null,
        secure: m.email.secure ?? false,
        user: m.email.user ?? '',
        from: m.email.from ?? '',
        secretSet: await hasSecret(db, m.email.secretRef),
      },
    }
  }

  app.get('/api/messaging/settings', async (req) => {
    requirePerm(req, 'settings.manage')
    return settingsDto()
  })

  app.put('/api/messaging/settings', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(
      z.object({
        quietStart: hhmm,
        quietEnd: hhmm,
        vaccineOffsetsDays: z
          .array(z.number().int().min(-60, 'Gecikme en fazla 60 gün olabilir.').max(90, 'En fazla 90 gün önce olabilir.'))
          .max(6, 'En fazla 6 hatırlatma zamanı girilebilir.'),
        appointmentOffsetHours: z.number().int().min(1, 'Randevu hatırlatması en az 1 saat önce olmalı.').max(168, 'En fazla 168 saat (7 gün) önce olabilir.'),
        sms: z.object({
          provider: z.enum(['none', 'netgsm', 'iletimerkezi', 'log'], { message: 'Geçersiz SMS sağlayıcı.' }),
          username: z.string().trim().max(100),
          header: z.string().trim().max(11, 'Mesaj başlığı en fazla 11 karakter olabilir.'),
        }),
        email: z.object({
          enabled: z.boolean(),
          host: z.string().trim().max(200),
          port: z.number().int().min(1).max(65535, 'Port 1-65535 arasında olmalı.').nullable(),
          secure: z.boolean(),
          user: z.string().trim().max(200),
          from: z.string().trim().max(200),
        }),
      }),
      req.body,
    )
    if (b.email.enabled && (!b.email.host || !b.email.from)) throw new AppError(400, 'E-posta açıkken SMTP sunucusu ve gönderen adresi zorunludur.', 'VALIDATION')
    if ((b.sms.provider === 'netgsm' || b.sms.provider === 'iletimerkezi') && (!b.sms.username || !b.sms.header)) {
      throw new AppError(400, 'SMS sağlayıcı için kullanıcı adı / API anahtarı ve mesaj başlığı zorunludur.', 'VALIDATION')
    }
    await db.transaction(async (tx) => {
      const cur = (await getSettings(tx)).messaging
      const next = {
        ...cur,
        quietStart: b.quietStart,
        quietEnd: b.quietEnd,
        vaccineOffsetsDays: [...new Set(b.vaccineOffsetsDays)].sort((x, y) => y - x),
        appointmentOffsetHours: b.appointmentOffsetHours,
        // Sır referansları korunur; ayarlarda hiçbir zaman parola saklanmaz
        sms: { ...b.sms, secretRef: cur.sms.secretRef },
        email: { ...b.email, port: b.email.port ?? undefined, secretRef: cur.email.secretRef },
      }
      await updateSettings(tx, { messaging: next })
      await writeAudit(tx, { userId: u.id, action: 'update', entity: 'messaging_settings', summary: 'Mesajlaşma ayarları güncellendi', diff: { before: { ...cur }, after: next } })
    })
    return settingsDto()
  })

  /** Sırlar ayrı uçla yazılır; değer asla geri döndürülmez. Boş değer -> sırrı siler. */
  app.put('/api/messaging/secrets/:kind', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const { kind } = parse(z.object({ kind: channelSchema }), req.params)
    const b = parse(z.object({ value: z.string().max(500, 'Değer çok uzun.') }), req.body)
    const key = SECRET_KEYS[kind]
    await db.transaction(async (tx) => {
      await setSecret(tx, deps.crypto, key, b.value || null)
      const s = await getSettings(tx)
      const m = s.messaging
      const next = kind === 'sms' ? { ...m, sms: { ...m.sms, secretRef: b.value ? key : undefined } } : { ...m, email: { ...m.email, secretRef: b.value ? key : undefined } }
      await updateSettings(tx, { messaging: next })
      await writeAudit(tx, {
        userId: u.id,
        action: 'update',
        entity: 'messaging_settings',
        entityId: kind,
        summary: b.value ? `${kind === 'sms' ? 'SMS API parolası' : 'SMTP parolası'} değiştirildi` : `${kind === 'sms' ? 'SMS API parolası' : 'SMTP parolası'} silindi`,
      })
    })
    return { secretSet: !!b.value }
  })

  /** Test SMS / e-posta: doğrudan gönderir, geçmişe "test" olarak yazar */
  app.post('/api/messaging/test', async (req) => {
    const u = requirePerm(req, 'settings.manage')
    const b = parse(z.object({ channel: channelSchema, to: z.string().trim().min(3, 'Alıcı girin.').max(200) }), req.body)
    let to = b.to
    if (b.channel === 'sms') {
      const n = normalizeTrMobile(b.to)
      if (!n) throw new AppError(400, 'Cep telefonu 5XX XXX XX XX biçiminde olmalı.', 'VALIDATION')
      to = n
    } else if (!z.email().safeParse(b.to).success) throw new AppError(400, 'Geçerli bir e-posta adresi girin.', 'VALIDATION')
    const providers = await createProviders(deps, await getSettings(db))
    const provider = b.channel === 'sms' ? providers.sms : providers.email
    if (!provider) throw new AppError(409, (b.channel === 'sms' ? providers.smsReason : providers.emailReason) ?? 'Sağlayıcı ayarlı değil.', 'PROVIDER_NOT_CONFIGURED')
    const cv = await clinicVars(db)
    const body = `${cv.klinik_ad} - PatiKünye test mesajı. Bu mesajı aldıysanız ayarlar doğru.`
    const res = await provider.send(to, body, { subject: 'PatiKünye test e-postası' })
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into messages (channel, to_address, body, status, provider, provider_msg_id, error, sent_at, cost_units, sent_by, is_test)
        values (${b.channel}, ${to}, ${body}, ${res.ok ? 'sent' : 'failed'}, ${provider.name}, ${res.providerMsgId}, ${res.error},
          ${now().toISOString()}, ${res.ok && b.channel === 'sms' ? smsSegments(body).segments : res.ok ? 1 : 0}, ${u.id}, true)`)
      await writeAudit(tx, { userId: u.id, action: 'create', entity: 'message', summary: `Test ${b.channel === 'sms' ? 'SMS' : 'e-posta'}: ${res.ok ? 'başarılı' : 'başarısız'}` })
    })
    return { ok: res.ok, providerMsgId: res.providerMsgId, error: res.error }
  })

  app.get('/api/messaging/balance', async (req) => {
    requirePerm(req, 'messages.send')
    const s = await getSettings(db)
    const providers = await createProviders(deps, s)
    const p = providers.sms
    const base = { provider: s.messaging.sms.provider, amount: null, credits: null }
    if (!p) return { ...base, supported: false, error: providers.smsReason ?? null } satisfies BalanceDto
    if (!p.balance) return { ...base, supported: false, error: null } satisfies BalanceDto
    try {
      const b = await p.balance()
      return { ...base, supported: true, amount: b.amount, credits: b.credits, error: null } satisfies BalanceDto
    } catch (e) {
      return { ...base, supported: true, error: `Bakiye okunamadı: ${(e as Error).message}` } satisfies BalanceDto
    }
  })
}
