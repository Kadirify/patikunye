// Hatırlatma servisi - diğer modüller (aşı, randevu, muayene kontrolü) bu fonksiyonları çağırır.
// İmzalar sabittir. Gövdeler Mesajlaşma modülüne aittir.
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { getSettings } from '../settings'
import { formatDateTr, todayIstanbul } from '../../../shared/petvet'
import { fillTemplate, type MessageChannel } from '../../../shared/messaging'
import { formatTrPhone } from '../../../shared/identity'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type ReminderKind = 'vaccine' | 'appointment' | 'appointment_confirm' | 'appointment_cancel' | 'control' | 'custom'

export interface ScheduleReminderInput {
  kind: ReminderKind
  ownerId: string
  animalId?: string | null
  /** Hatırlatmayı doğuran kayıt: 'vaccination_plan' | 'appointment' | 'visit' ... */
  sourceType: string
  sourceId: string
  /** Olayın zamanı (aşı vadesi / randevu saati). Gönderim zamanları ayarlardaki ofsetlerle hesaplanır. */
  eventAt: Date
  /** Şablon değişkenleri: hayvan_ad, asi_ad, tarih, saat, hekim_ad ... */
  vars: Record<string, string>
  /** true ise ofset uygulanmaz, hemen kuyruğa girer (randevu onayı/iptali gibi) */
  immediate?: boolean
  /** Testlerde/özel durumlarda "şimdi" (verilmezse gerçek saat) */
  now?: Date
}

// "Şimdi" kaynağı: mesajlaşma API'si kaydedilirken deps.now'a bağlanır (testlerde sabit saat).
let clock: () => Date = () => new Date()
export function setReminderClock(fn: () => Date) {
  clock = fn
}

/** Gün bazlı hatırlatmaların gönderim saati (Europe/Istanbul) */
export const DAY_REMINDER_HOUR = '10:00'
const ALWAYS_IMMEDIATE: ReminderKind[] = ['appointment_confirm', 'appointment_cancel', 'custom']
const APPOINTMENT_KINDS = ['appointment', 'appointment_confirm', 'appointment_cancel']

/** Türkiye 2016'dan beri sabit UTC+3 (yaz saati yok). YYYY-MM-DD + SS:dd -> Date */
export function istanbulDateTime(dateIso: string, hhmm: string): Date {
  return new Date(`${dateIso}T${hhmm}:00+03:00`)
}

function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function istanbulTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
}

/** Varsayılan şablon anahtarı */
function templateFor(kind: ReminderKind, overdue: boolean): string {
  switch (kind) {
    case 'vaccine':
      return overdue ? 'vaccine_overdue' : 'vaccine_reminder'
    case 'appointment':
      return 'appointment_reminder'
    case 'appointment_confirm':
      return 'appointment_confirm'
    case 'appointment_cancel':
      return 'appointment_cancel'
    case 'control':
      return 'control_reminder'
    default:
      return 'custom'
  }
}

/** Gönderim zamanlarını hesaplar (geçmişte kalanlar elenir). Saf fonksiyon: test edilebilir. */
export function computeSendTimes(
  kind: ReminderKind,
  eventAt: Date,
  now: Date,
  cfg: { vaccineOffsetsDays: number[]; appointmentOffsetHours: number },
  immediate?: boolean,
): { sendAt: Date; templateKey: string }[] {
  if (immediate || ALWAYS_IMMEDIATE.includes(kind)) return [{ sendAt: now, templateKey: templateFor(kind, false) }]
  const out: { sendAt: Date; templateKey: string }[] = []
  if (kind === 'appointment') {
    out.push({ sendAt: new Date(eventAt.getTime() - cfg.appointmentOffsetHours * 3600_000), templateKey: templateFor(kind, false) })
  } else {
    // Aşı: [7, 1, -3] -> 7 gün önce, 1 gün önce, 3 gün sonra (gecikme). Kontrol: yalnızca önceki günler.
    const eventDay = todayIstanbul(eventAt)
    const offsets = kind === 'vaccine' ? cfg.vaccineOffsetsDays : cfg.vaccineOffsetsDays.filter((d) => d >= 0)
    for (const d of [...new Set(offsets)].sort((a, b) => b - a)) {
      out.push({ sendAt: istanbulDateTime(addDays(eventDay, -d), DAY_REMINDER_HOUR), templateKey: templateFor(kind, d < 0) })
    }
  }
  return out.filter((t) => t.sendAt.getTime() > now.getTime())
}

type OwnerRow = { id: string; first_name: string; last_name: string; phone: string | null; email: string | null; preferred_channel: string; reminder_consent: boolean }

/** Kanal seçimi: tercih edilen kanal, yoksa elde olan. Hiçbiri yoksa null. */
export function pickChannel(o: Pick<OwnerRow, 'phone' | 'email' | 'preferred_channel'>): { channel: MessageChannel; to: string } | null {
  const email = o.email?.trim() || null
  if (o.preferred_channel === 'email' && email) return { channel: 'email', to: email }
  if (o.phone) return { channel: 'sms', to: o.phone }
  if (email) return { channel: 'email', to: email }
  return null
}

/** Hatırlatma(lar)ı planlar. Sahibin izni yoksa ya da iletişim bilgisi yoksa sessizce "izin yok" olarak kaydeder. */
export async function scheduleReminder(tx: Tx | Db, input: ScheduleReminderInput): Promise<void> {
  const now = input.now ?? clock()
  const settings = await getSettings(tx)

  const owner = (
    await tx.execute<OwnerRow>(sql`select id, first_name, last_name, phone, email, preferred_channel, reminder_consent
      from owners where id = ${input.ownerId} and deleted_at is null`)
  ).rows[0]
  if (!owner) return

  let animalName: string | undefined
  if (input.animalId) {
    const a = (
      await tx.execute<{ name: string; status: string; deleted_at: string | null; is_owner: boolean }>(sql`
        select a.name, a.status, a.deleted_at,
          exists(select 1 from animal_owners ao where ao.animal_id = a.id and ao.owner_id = ${input.ownerId} and ao.to_date is null) as is_owner
        from animals a where a.id = ${input.animalId}`)
    ).rows[0]
    // Hayvan yok/silinmiş, ölü ya da sahibi değişmiş: mesaj üretilmez
    if (!a || a.deleted_at || a.status === 'dead' || !a.is_owner) return
    animalName = a.name
  }

  const times = computeSendTimes(input.kind, input.eventAt, now, settings.messaging, input.immediate)

  // Aynı kaynak + tür için bekleyen eski planı kaldır (yeniden planlama: tarih değişti)
  if (!input.immediate && !ALWAYS_IMMEDIATE.includes(input.kind)) {
    await tx.execute(sql`update reminders set status = 'cancelled', cancelled_reason = 'Yeniden planlandı', updated_at = now()
      where source_type = ${input.sourceType} and source_id = ${input.sourceId} and kind = ${input.kind}
        and status in ('planned', 'queued', 'failed')`)
  }
  if (times.length === 0) return

  const isAppt = APPOINTMENT_KINDS.includes(input.kind)
  const vars: Record<string, string> = {
    sahip_ad: `${owner.first_name} ${owner.last_name}`.trim(),
    ...(animalName ? { hayvan_ad: animalName } : {}),
    tarih: formatDateTr(todayIstanbul(input.eventAt)),
    ...(isAppt ? { saat: istanbulTime(input.eventAt) } : {}),
    ...input.vars,
  }

  const target = pickChannel(owner)
  const noConsentReason =
    !owner.reminder_consent || owner.preferred_channel === 'none'
      ? 'Sahip hatırlatma mesajı almak istemiyor.'
      : !target
        ? 'Sahibin telefonu ya da e-postası yok.'
        : null

  const rows = noConsentReason ? times.slice(0, 1) : times
  for (const t of rows) {
    const status = noConsentReason ? 'no_consent' : t.sendAt.getTime() <= now.getTime() ? 'queued' : 'planned'
    await tx.execute(sql`insert into reminders
      (kind, owner_id, animal_id, source_type, source_id, channel, to_address, template_key, vars, event_at, send_at, status, cancelled_reason)
      values (${input.kind}, ${owner.id}, ${input.animalId ?? null}, ${input.sourceType}, ${input.sourceId},
        ${target?.channel ?? (owner.preferred_channel === 'email' ? 'email' : 'sms')}, ${target?.to ?? null}, ${t.templateKey},
        ${JSON.stringify(vars)}::jsonb, ${input.eventAt.toISOString()}, ${t.sendAt.toISOString()}, ${status}, ${noConsentReason})`)
  }
}

/** Kaynağa bağlı bekleyen hatırlatmaları iptal eder (aşı uygulandı, randevu iptal edildi, hayvan öldü...). */
export async function cancelReminders(tx: Tx | Db, sourceType: string, sourceId: string, reason?: string): Promise<void> {
  await tx.execute(sql`update reminders set status = 'cancelled', cancelled_reason = ${reason ?? 'İptal edildi'}, updated_at = now()
    where source_type = ${sourceType} and source_id = ${sourceId} and status in ('planned', 'queued', 'failed')`)
}

/** Bir hayvanın tüm bekleyen hatırlatmalarını iptal eder (ölüm, devir). */
export async function cancelAnimalReminders(tx: Tx | Db, animalId: string, reason?: string): Promise<void> {
  await tx.execute(sql`update reminders set status = 'cancelled', cancelled_reason = ${reason ?? 'Hayvan durumu değişti'}, updated_at = now()
    where animal_id = ${animalId} and status in ('planned', 'queued', 'failed')`)
}

/* ---------- Metin üretimi (gönderim motoru ve önizleme ortak kullanır) ---------- */

export interface ReminderForRender {
  template_key: string
  channel: MessageChannel
  vars: Record<string, string>
  body_override: string | null
}

export async function clinicVars(db: Tx | Db): Promise<Record<string, string>> {
  const c = (await db.execute<{ name: string; phone: string | null }>(sql`select name, phone from clinic limit 1`)).rows[0]
  return { klinik_ad: c?.name ?? '', klinik_tel: c?.phone ? formatTrPhone(c.phone) : '' }
}

/** Hatırlatmanın gönderilecek metnini üretir (şablon + değişkenler; "Düzenle" ile yazılmış metin varsa o). */
export async function renderReminder(db: Tx | Db, r: ReminderForRender): Promise<{ subject: string | null; body: string; templateBody: string }> {
  const vars = { ...(await clinicVars(db)), ...(r.vars ?? {}) }
  const tpl = (
    await db.execute<{ subject: string | null; body: string }>(
      sql`select subject, body from message_templates where key = ${r.template_key} and channel = ${r.channel}`,
    )
  ).rows[0]
  // Özel (custom) hatırlatma: metin vars.metin içinde gelir
  const templateBody = tpl ? fillTemplate(tpl.body, vars) : fillTemplate(vars.metin ?? '', vars)
  const subject = tpl?.subject ? fillTemplate(tpl.subject, vars) : r.channel === 'email' ? `${vars.klinik_ad} - bilgilendirme` : null
  const body = r.body_override ? fillTemplate(r.body_override, vars) : templateBody
  return { subject, body, templateBody }
}
