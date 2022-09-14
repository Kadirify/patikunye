// Modül M — mesajlar ve hatırlatmalar testleri
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestBackend, type TestBackend } from './test-helpers'
import { cancelAnimalReminders, cancelReminders, computeSendTimes, scheduleReminder } from './server/services/reminders'
import { processDueReminders, RETRY_DELAYS_MS } from './server/services/messaging-job'
import type { MessageProvider } from './server/services/sms'
import { fillTemplate, isQuietTime, maskAddress, smsSegments } from '../shared/messaging'

// Saat sabit: 27.10.2026 12:00 İstanbul (09:00 UTC)
let clock = new Date('2026-10-27T12:00:00+03:00')
const at = (s: string) => new Date(s)
let t: TestBackend

const settingsBody = (smsProvider: string) => ({
  quietStart: '21:00',
  quietEnd: '09:00',
  vaccineOffsetsDays: [7, 1, -3],
  appointmentOffsetHours: 24,
  sms: { provider: smsProvider, username: '', header: '' },
  email: { enabled: false, host: '', port: null, secure: false, user: '', from: '' },
})

async function rows(sourceId: string) {
  const r = await t.backend.db.$client.query(
    `select * from reminders where source_id = $1 and status <> 'cancelled' order by send_at`,
    [sourceId],
  )
  return r.rows
}

let seq = 0
const src = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

beforeAll(async () => {
  t = await startTestBackend({ now: () => clock })
}, 120_000)
afterAll(async () => {
  await t?.stop()
})

describe('saf yardımcılar', () => {
  it('şablon doldurma', () => {
    expect(fillTemplate('Sayın {sahip_ad}, {hayvan_ad} için {asi_ad} {tarih}.', { sahip_ad: 'Ayşe', hayvan_ad: 'Pamuk', asi_ad: 'Kuduz', tarih: '03.11.2026' })).toBe(
      'Sayın Ayşe, Pamuk için Kuduz 03.11.2026.',
    )
    // Eksik değişken boş kalır, fazla boşluk toplanır
    expect(fillTemplate('{hayvan_ad} {asi_ad} aşısı', { hayvan_ad: 'Pamuk' })).toBe('Pamuk aşısı')
  })

  it('SMS segment sayacı: Türkçe karakter 70/67, değilse 160/153', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ segments: 1, unicode: false, single: 160 })
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2, perSegment: 153 })
    expect(smsSegments('ş' + 'a'.repeat(69))).toMatchObject({ segments: 1, unicode: true, chars: 70 })
    expect(smsSegments('ş' + 'a'.repeat(70))).toMatchObject({ segments: 2, perSegment: 67 })
    expect(smsSegments('ğ'.repeat(135)).segments).toBe(3)
    expect(smsSegments('{}').chars).toBe(4) // genişletilmiş GSM karakterleri 2 sayılır
    expect(smsSegments('').segments).toBe(0)
  })

  it('sessiz saat ve maskeleme', () => {
    expect(isQuietTime(at('2026-10-27T22:00:00+03:00'), '21:00', '09:00')).toBe(true)
    expect(isQuietTime(at('2026-10-27T08:59:00+03:00'), '21:00', '09:00')).toBe(true)
    expect(isQuietTime(at('2026-10-27T09:00:00+03:00'), '21:00', '09:00')).toBe(false)
    expect(isQuietTime(at('2026-10-27T13:00:00+03:00'), '12:00', '14:00')).toBe(true)
    expect(maskAddress('+905321234567')).toBe('0532 *** ** 67')
  })

  it('ofset hesabı: geçmişte kalan zaman üretilmez', () => {
    const cfg = { vaccineOffsetsDays: [7, 1, -3], appointmentOffsetHours: 24 }
    const r = computeSendTimes('vaccine', at('2026-10-29T00:00:00+03:00'), clock, cfg)
    expect(r.map((x) => x.sendAt.toISOString())).toEqual([at('2026-10-28T10:00:00+03:00').toISOString(), at('2026-11-01T10:00:00+03:00').toISOString()])
    expect(r.map((x) => x.templateKey)).toEqual(['vaccine_reminder', 'vaccine_overdue'])
  })
})

describe('scheduleReminder', () => {
  it('aşı: 7 gün önce, 1 gün önce, 3 gün sonra (10:00 İstanbul)', async () => {
    const reg = await t.registerAnimal({ name: 'Boncuk' })
    const sid = src()
    await scheduleReminder(t.backend.db, {
      kind: 'vaccine',
      ownerId: reg.ownerId,
      animalId: reg.animalId,
      sourceType: 'vaccination_plan',
      sourceId: sid,
      eventAt: at('2026-11-10T00:00:00+03:00'),
      vars: { asi_ad: 'Karma' },
    })
    const r = await rows(sid)
    expect(r.map((x) => new Date(x.send_at).toISOString())).toEqual([
      at('2026-11-03T10:00:00+03:00').toISOString(),
      at('2026-11-09T10:00:00+03:00').toISOString(),
      at('2026-11-13T10:00:00+03:00').toISOString(),
    ])
    expect(r.map((x) => x.status)).toEqual(['planned', 'planned', 'planned'])
    expect(r[2].template_key).toBe('vaccine_overdue')
    expect(r[0].channel).toBe('sms')
    expect(r[0].vars).toMatchObject({ hayvan_ad: 'Boncuk', asi_ad: 'Karma', tarih: '10.11.2026', sahip_ad: 'Deneme Sahip' })

    // Yeniden planlama eski bekleyenleri iptal eder
    await scheduleReminder(t.backend.db, {
      kind: 'vaccine', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'vaccination_plan', sourceId: sid,
      eventAt: at('2026-11-20T00:00:00+03:00'), vars: {},
    })
    expect((await rows(sid)).length).toBe(3)
  })

  it('randevu: ayardaki saat kadar önce; onay hemen kuyruğa', async () => {
    const reg = await t.registerAnimal()
    const sid = src()
    const eventAt = at('2026-10-30T14:30:00+03:00')
    await scheduleReminder(t.backend.db, { kind: 'appointment', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'appointment', sourceId: sid, eventAt, vars: { hekim_ad: 'Dr. Ali' } })
    await scheduleReminder(t.backend.db, { kind: 'appointment_confirm', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'appointment', sourceId: sid, eventAt, vars: {}, immediate: true })
    const r = await rows(sid)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ kind: 'appointment_confirm', status: 'queued' })
    expect(new Date(r[1].send_at).toISOString()).toBe(at('2026-10-29T14:30:00+03:00').toISOString())
    expect(r[1].vars.saat).toBe('14:30')
  })

  it('izin yoksa tek "no_consent" kaydı; ölü hayvana hiç üretilmez', async () => {
    const reg = await t.registerAnimal()
    await t.backend.db.$client.query('update owners set reminder_consent = false where id = $1', [reg.ownerId])
    const sid = src()
    await scheduleReminder(t.backend.db, {
      kind: 'vaccine', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'vaccination_plan', sourceId: sid,
      eventAt: at('2026-11-10T00:00:00+03:00'), vars: {},
    })
    const r = await rows(sid)
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('no_consent')

    const dead = await t.registerAnimal()
    await t.backend.db.$client.query(`update animals set status = 'dead' where id = $1`, [dead.animalId])
    const sid2 = src()
    await scheduleReminder(t.backend.db, {
      kind: 'vaccine', ownerId: dead.ownerId, animalId: dead.animalId, sourceType: 'vaccination_plan', sourceId: sid2,
      eventAt: at('2026-11-10T00:00:00+03:00'), vars: {},
    })
    expect(await rows(sid2)).toHaveLength(0)
  })

  it('cancelReminders / cancelAnimalReminders bekleyenleri iptal eder', async () => {
    const reg = await t.registerAnimal()
    const a = src()
    const b = src()
    for (const sid of [a, b]) {
      await scheduleReminder(t.backend.db, {
        kind: 'vaccine', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'vaccination_plan', sourceId: sid,
        eventAt: at('2026-11-10T00:00:00+03:00'), vars: {},
      })
    }
    await cancelReminders(t.backend.db, 'vaccination_plan', a, 'Aşı uygulandı')
    expect(await rows(a)).toHaveLength(0)
    const c = await t.backend.db.$client.query(`select cancelled_reason from reminders where source_id = $1`, [a])
    expect(c.rows.every((x) => x.cancelled_reason === 'Aşı uygulandı')).toBe(true)
    await cancelAnimalReminders(t.backend.db, reg.animalId, 'Ölüm')
    expect(await rows(b)).toHaveLength(0)
  })
})

describe('gönderim motoru', () => {
  it('sessiz saatte bekler, sonra "log" sağlayıcısıyla gönderir', async () => {
    expect((await t.api('PUT', '/api/messaging/settings', settingsBody('log'))).status).toBe(200)
    const reg = await t.registerAnimal({ name: 'Zeytin' })
    const sid = src()
    await scheduleReminder(t.backend.db, {
      kind: 'control', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'visit', sourceId: sid,
      eventAt: at('2026-10-29T00:00:00+03:00'), vars: {},
    })
    // 1 gün önce = 28.10 10:00. Saat 28.10 08:00 (sessiz) → gönderilmez
    clock = at('2026-10-28T08:00:00+03:00')
    const q = await processDueReminders(t.backend.deps)
    expect(q.quiet).toBe(true)
    expect((await rows(sid))[0].status).toBe('planned')

    clock = at('2026-10-28T10:05:00+03:00')
    const res = await processDueReminders(t.backend.deps)
    expect(res.sent).toBeGreaterThanOrEqual(1)
    const r = (await rows(sid))[0]
    expect(r.status).toBe('sent')
    expect(r.provider_msg_id).toMatch(/^log-/)
    const m = await t.backend.db.$client.query('select * from messages where reminder_id = $1', [r.id])
    expect(m.rows[0]).toMatchObject({ status: 'sent', provider: 'log', channel: 'sms' })
    expect(m.rows[0].body).toContain('Zeytin')
    expect(m.rows[0].body).toContain('Test Kliniği')
    expect(m.rows[0].body).toContain('29.10.2026')
  })

  it('hata → 5 dk, 30 dk, 2 sa sonra yeniden dener → kalıcı başarısız', async () => {
    const fail: MessageProvider = { name: 'sahte', send: async () => ({ ok: false, providerMsgId: null, error: 'Geçici hata' }) }
    const reg = await t.registerAnimal()
    const sid = src()
    clock = at('2026-10-28T11:00:00+03:00')
    await scheduleReminder(t.backend.db, {
      kind: 'appointment_confirm', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'appointment', sourceId: sid,
      eventAt: at('2026-11-05T10:00:00+03:00'), vars: {}, immediate: true,
    })
    const opts = { providers: { sms: fail } }
    await processDueReminders(t.backend.deps, opts)
    let r = (await rows(sid))[0]
    expect(r).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Geçici hata' })
    expect(new Date(r.next_attempt_at).getTime()).toBe(clock.getTime() + RETRY_DELAYS_MS[0])

    // Süre dolmadan tekrar denenmez
    await processDueReminders(t.backend.deps, opts)
    expect((await rows(sid))[0].attempts).toBe(1)

    for (const [i, d] of RETRY_DELAYS_MS.entries()) {
      clock = new Date(clock.getTime() + d)
      await processDueReminders(t.backend.deps, opts)
      r = (await rows(sid))[0]
      expect(r.attempts).toBe(i + 2)
    }
    expect(r.status).toBe('permanent_failed')
    const m = await t.backend.db.$client.query('select count(*)::int as n from messages where reminder_id = $1', [r.id])
    expect(m.rows[0].n).toBe(4)
  })

  it('24 saatten eski kaçırılmış randevu hatırlatması "süresi geçti" olur', async () => {
    const reg = await t.registerAnimal()
    const sid = src()
    clock = at('2026-10-28T11:00:00+03:00')
    await scheduleReminder(t.backend.db, {
      kind: 'appointment', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'appointment', sourceId: sid,
      eventAt: at('2026-11-02T15:00:00+03:00'), vars: {},
    })
    clock = at('2026-11-02T16:00:00+03:00') // uygulama kapalıydı; randevu da geçti
    const res = await processDueReminders(t.backend.deps)
    expect(res.expired).toBeGreaterThanOrEqual(1)
    const r = await t.backend.db.$client.query(`select status from reminders where source_id = $1`, [sid])
    expect(r.rows[0].status).toBe('expired')
  })
})

describe('API', () => {
  it('kuyruk sekmeleri, önizleme, iptal ve şimdi gönder', async () => {
    clock = at('2026-10-28T12:00:00+03:00')
    const reg = await t.registerAnimal({ name: 'Tarçın' })
    const sid = src()
    await scheduleReminder(t.backend.db, {
      kind: 'vaccine', ownerId: reg.ownerId, animalId: reg.animalId, sourceType: 'vaccination_plan', sourceId: sid,
      eventAt: at('2026-11-15T00:00:00+03:00'), vars: { asi_ad: 'Kuduz' },
    })
    const list = await t.api('GET', '/api/messaging/reminders?tab=planned&q=Tarçın')
    expect(list.status).toBe(200)
    expect(list.data.items.length).toBe(3)
    expect(list.data.items[0].toMasked).toMatch(/\*\*\*/)
    const id = list.data.items[0].id

    const pv = await t.api('GET', `/api/messaging/reminders/${id}/preview`)
    expect(pv.data.body).toContain('Tarçın için Kuduz aşısının zamanı 15.11.2026')
    expect(pv.data.count.unicode).toBe(true)

    expect((await t.api('PUT', `/api/messaging/reminders/${id}/body`, { body: 'Özel metin {hayvan_ad}' })).status).toBe(200)
    expect((await t.api('GET', `/api/messaging/reminders/${id}/preview`)).data.body).toBe('Özel metin Tarçın')

    const sent = await t.api('POST', `/api/messaging/reminders/${id}/send-now`)
    expect(sent.data.status).toBe('sent')
    expect((await t.api('POST', `/api/messaging/reminders/${id}/cancel`, {})).status).toBe(409)

    const id2 = list.data.items[1].id
    expect((await t.api('POST', `/api/messaging/reminders/${id2}/cancel`, { reason: 'Sahip istemedi' })).status).toBe(200)
    const canc = await t.api('GET', '/api/messaging/reminders?tab=cancelled&q=Tarçın')
    expect(canc.data.items.map((x: { id: string }) => x.id)).toContain(id2)

    const hist = await t.api('GET', '/api/messaging/messages?q=Deneme')
    expect(hist.data.items.some((m: { body: string }) => m.body === 'Özel metin Tarçın')).toBe(true)

    const sum = await t.api('GET', '/api/messaging/summary')
    expect(sum.data.sentThisMonth).toBeGreaterThanOrEqual(1)
  })

  it('şablon düzenleme: bilinmeyen değişken reddedilir, önizleme doldurur', async () => {
    const tpl = await t.api('GET', '/api/messaging/templates')
    expect(tpl.data.filter((x: { builtin: boolean }) => x.builtin).length).toBe(12)
    const bad = await t.api('PUT', '/api/messaging/templates/vaccine_reminder/sms', { body: 'Merhaba {bilinmeyen}' })
    expect(bad.status).toBe(400)
    const ok = await t.api('PUT', '/api/messaging/templates/vaccine_reminder/sms', { body: '{hayvan_ad} aşı günü {tarih}. {klinik_ad}' })
    expect(ok.status).toBe(200)
    const pv = await t.api('POST', '/api/messaging/templates/preview', { body: '{hayvan_ad} - {klinik_ad}' })
    expect(pv.data.body).toBe('Pamuk - Test Kliniği')
    expect((await t.api('DELETE', '/api/messaging/templates/vaccine_reminder/sms')).status).toBe(409)
  })

  it('sırlar şifreli saklanır ve asla düz metin dönmez', async () => {
    const secret = 'cok-gizli-sms-parolasi-42'
    expect((await t.api('PUT', '/api/messaging/secrets/sms', { value: secret })).status).toBe(200)
    const s = await t.api('GET', '/api/messaging/settings')
    expect(s.data.sms.secretSet).toBe(true)
    expect(JSON.stringify(s.data)).not.toContain(secret)
    const put = await t.api('PUT', '/api/messaging/settings', { ...settingsBody('netgsm'), sms: { provider: 'netgsm', username: 'kullanici', header: 'KLINIK' } })
    expect(put.status).toBe(200)
    expect(JSON.stringify(put.data)).not.toContain(secret)
    const kv = await t.backend.db.$client.query('select value_enc from secrets_kv')
    expect(kv.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(kv.rows)).not.toContain(secret)
    const clinic = await t.backend.db.$client.query('select settings from clinic')
    expect(JSON.stringify(clinic.rows)).not.toContain(secret)
    const audit = await t.backend.db.$client.query('select summary, diff from audit_logs')
    expect(JSON.stringify(audit.rows)).not.toContain(secret)
    // Sağlayıcıyı tekrar 'log'a al
    await t.api('PUT', '/api/messaging/settings', settingsBody('log'))
  })

  it('test SMS ve doğrulama', async () => {
    const r = await t.api('POST', '/api/messaging/test', { channel: 'sms', to: '0532 123 45 67' })
    expect(r.data.ok).toBe(true)
    expect((await t.api('POST', '/api/messaging/test', { channel: 'sms', to: '123' })).status).toBe(400)
    expect((await t.api('POST', '/api/messaging/test', { channel: 'email', to: 'a@b.com' })).status).toBe(409) // e-posta kapalı
    const bad = await t.api('PUT', '/api/messaging/settings', { ...settingsBody('log'), quietStart: '25:00' })
    expect(bad.status).toBe(400)
  })

  it('izinler: teknisyen kuyruğu göremez, sekreter ayarları göremez', async () => {
    const tech = await t.loginAs('tech')
    expect((await t.api('GET', '/api/messaging/reminders', undefined, tech.token)).status).toBe(403)
    const sec = await t.loginAs('secretary')
    expect((await t.api('GET', '/api/messaging/reminders', undefined, sec.token)).status).toBe(200)
    expect((await t.api('GET', '/api/messaging/settings', undefined, sec.token)).status).toBe(403)
    expect((await t.api('PUT', '/api/messaging/secrets/sms', { value: 'x' }, sec.token)).status).toBe(403)
  })
})
