// Mesajlar modülü: hatırlatma kuyruğu, mesaj geçmişi, mesajlaşma ayarları, şablonlar
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../api'
import { useCan } from '../session'
import { Field, useToast } from '../ui'
import { SettingsLayout } from '../components/SettingsNav'
import { formatTrPhone } from '@shared/identity'
import {
  CHANNEL_LABEL,
  QUEUE_TABS,
  QUEUE_TAB_LABEL,
  REMINDER_KIND_LABEL,
  REMINDER_STATUS_LABEL,
  SMS_PROVIDER_LABEL,
  TEMPLATE_LABEL,
  TEMPLATE_VARIABLES,
  smsSegments,
  type BalanceDto,
  type MessageHistoryResult,
  type MessageTemplateDto,
  type MessagingSettingsDto,
  type MessagingSummary,
  type QueueTab,
  type ReminderListItem,
  type ReminderListResult,
  type ReminderPreview,
  type ReminderStatus,
  type SmsCount,
  type SmsProviderName,
} from '@shared/messaging'

/* ---------- yardımcılar ---------- */

const dtFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtDateTime = (iso: string | null) => (iso ? dtFmt.format(new Date(iso)).replace(',', '') : '')

function statusClass(s: ReminderStatus | string) {
  if (s === 'sent' || s === 'delivered') return 's-ok'
  if (s === 'failed') return 's-amb'
  if (s === 'permanent_failed') return 's-red'
  if (s === 'planned' || s === 'queued') return 's-blu'
  return 's-gry'
}

function ReminderState({ status }: { status: ReminderStatus }) {
  return <span className={`st ${statusClass(status)}`}>{REMINDER_STATUS_LABEL[status] ?? status}</span>
}

function SmsCounter({ count, channel = 'sms' }: { count: SmsCount; channel?: 'sms' | 'email' }) {
  if (channel === 'email') return <span className="mut mono">{count.chars} karakter</span>
  return (
    <span className="mono" style={{ color: count.segments > 1 ? 'var(--amb)' : 'var(--muted)' }}>
      {count.chars} karakter - {count.segments} SMS - {count.unicode ? 'Türkçe (70/67)' : 'GSM (160/153)'} - kalan {count.remaining}
    </span>
  )
}

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="tfoot" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: '6px 12px' }}>
      <span className="mut">{total} kayıt</span>
      {pages > 1 && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Önceki</button>
          <span className="mono">{page} / {pages}</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Sonraki</button>
        </span>
      )}
    </div>
  )
}

/* -------------------- */

type PageTab = QueueTab | 'history'

export function MessagesPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('t') as PageTab) ?? 'today'
  const summary = useQuery({ queryKey: ['messaging-summary'], queryFn: () => api.get<MessagingSummary>('/api/messaging/summary') })
  const balance = useQuery({
    queryKey: ['messaging-balance'],
    queryFn: () => api.get<BalanceDto>('/api/messaging/balance'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const b = balance.data

  return (
    <>
      <div className="page-head">
        <h1>Mesajlar</h1>
        <span className="mut">Hatırlatma kuyruğu ve gönderilen mesajlar - sessiz saatlerde gönderim yapılmaz</span>
      </div>

      <div className="pnl" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 28px', padding: '10px 14px', alignItems: 'center' }}>
        <div>
          <div className="mut" style={{ fontSize: 12 }}>SMS sağlayıcı</div>
          <strong>{summary.data ? SMS_PROVIDER_LABEL[summary.data.provider as SmsProviderName] ?? summary.data.provider : '-'}</strong>
        </div>
        <div>
          <div className="mut" style={{ fontSize: 12 }}>Bakiye</div>
          {balance.isLoading ? (
            <span className="mut">okunuyor...</span>
          ) : b?.error ? (
            <span className="s-amb" title={b.error}>{b.error}</span>
          ) : b?.supported ? (
            <strong className="mono">{[b.amount && `${b.amount} TL`, b.credits && `${b.credits} SMS`].filter(Boolean).join(' - ') || '-'}</strong>
          ) : (
            <span className="mut">Sağlayıcı bakiye bildirmiyor</span>
          )}
        </div>
        <div>
          <div className="mut" style={{ fontSize: 12 }}>Bu ay gönderilen</div>
          <strong className="mono">{summary.data?.sentThisMonth ?? '-'}</strong>
          {summary.data ? <span className="mut"> mesaj - {summary.data.smsUnitsThisMonth} SMS birimi</span> : null}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Link to="/ayarlar/mesajlasma">Mesajlaşma ayarları</Link> - <Link to="/ayarlar/sablonlar">Şablonlar</Link>
        </div>
      </div>

      <nav aria-label="Kuyruk sekmeleri" className="pnl fstrip">
        {QUEUE_TABS.map((k) => (
          <button
            key={k}
            className={`fl${tab === k ? ' on' : ''}`}
            style={k === 'failed' && tab !== k && summary.data?.tabs.failed ? { color: 'var(--red)' } : undefined}
            onClick={() => setParams({ t: k })}
          >
            <span className="v">{summary.data ? summary.data.tabs[k] : '-'}</span>
            <span className="kx">{QUEUE_TAB_LABEL[k]}</span>
          </button>
        ))}
        <button className={`fl${tab === 'history' ? ' on' : ''}`} onClick={() => setParams({ t: 'history' })}>
          <span className="v">-</span>
          <span className="kx">Mesaj geçmişi</span>
        </button>
      </nav>

      {tab === 'history' ? <HistoryPanel /> : <QueuePanel tab={tab} />}
    </>
  )
}

function QueuePanel({ tab }: { tab: QueueTab }) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    setPage(1)
    setOpenId(null)
  }, [tab, q])
  const list = useQuery({
    queryKey: ['reminders', tab, q, page],
    queryFn: () => api.get<ReminderListResult>('/api/messaging/reminders' + qs({ tab, q, page })),
  })

  return (
    <section className="pnl">
      <div className="ph">
        <h2>{QUEUE_TAB_LABEL[tab]}</h2>
        <input className="inp" style={{ width: 260 }} placeholder="Ara: sahip, hayvan, telefon" aria-label="Kuyrukta ara" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>{tab === 'sent' ? 'Gönderim' : 'Planlanan zaman'}</th><th>Tür</th><th>Kanal</th><th>Alıcı</th><th>Hayvan</th><th>Şablon</th><th>Durum</th><th>Hata / not</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((r) => (
              <QueueRow key={r.id} r={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && <div className="empty">Bu sekmede hatırlatma yok.</div>}
        {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
      </div>
      {list.data && <Pager page={page} total={list.data.total} pageSize={list.data.pageSize} onPage={setPage} />}
    </section>
  )
}

function QueueRow({ r, open, onToggle }: { r: ReminderListItem; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`click${r.status === 'permanent_failed' ? ' hot' : ''}`} onClick={onToggle} aria-expanded={open}>
        <td className="mono">{fmtDateTime(r.sentAt ?? r.sendAt)}</td>
        <td>{REMINDER_KIND_LABEL[r.kind] ?? r.kind}</td>
        <td>{CHANNEL_LABEL[r.channel]}</td>
        <td>
          <Link to={`/sahipler/${r.ownerId}`} onClick={(e) => e.stopPropagation()}>{r.ownerName}</Link>
          <div className="mono mut" style={{ fontSize: 12 }}>{r.toMasked || '-'}</div>
        </td>
        <td>{r.animalId ? <Link to={`/hayvanlar/${r.animalId}`} onClick={(e) => e.stopPropagation()}>{r.animalName}</Link> : '-'}</td>
        <td>{TEMPLATE_LABEL[r.templateKey] ?? r.templateKey}{r.hasOverride && <span className="tag" style={{ marginLeft: 6 }}>düzenlendi</span>}</td>
        <td>
          <ReminderState status={r.status} />
          {r.status === 'failed' && r.nextAttemptAt && <div className="mut" style={{ fontSize: 12 }}>tekrar {fmtDateTime(r.nextAttemptAt)} - {r.attempts}. deneme</div>}
        </td>
        <td className="mut" style={{ maxWidth: 260 }}>{r.lastError ?? r.cancelledReason ?? ''}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: 'var(--head)' }}>
            <ReminderDetail r={r} />
          </td>
        </tr>
      )}
    </>
  )
}

function ReminderDetail({ r }: { r: ReminderListItem }) {
  const qc = useQueryClient()
  const toast = useToast()
  const can = useCan()
  const pv = useQuery({ queryKey: ['reminder-preview', r.id], queryFn: () => api.get<ReminderPreview>(`/api/messaging/reminders/${r.id}/preview`) })
  const [edit, setEdit] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const pending = r.status === 'planned' || r.status === 'queued' || r.status === 'failed'
  const done = (msg: string) => {
    qc.invalidateQueries()
    setErr('')
    toast(msg)
  }
  const onErr = (e: unknown) => setErr((e as Error).message)

  const sendNow = useMutation({
    mutationFn: () => api.post<{ status: string; error: string | null }>(`/api/messaging/reminders/${r.id}/send-now`),
    onSuccess: (x) => (x.status === 'sent' ? done('Mesaj gönderildi.') : (qc.invalidateQueries(), setErr(x.error ?? 'Gönderilemedi.'))),
    onError: onErr,
  })
  const retry = useMutation({ mutationFn: () => api.post(`/api/messaging/reminders/${r.id}/retry`), onSuccess: () => done('Yeniden kuyruğa alındı.'), onError: onErr })
  const cancel = useMutation({ mutationFn: () => api.post(`/api/messaging/reminders/${r.id}/cancel`, {}), onSuccess: () => done('Hatırlatma iptal edildi.'), onError: onErr })
  const save = useMutation({
    mutationFn: (body: string | null) => api.put(`/api/messaging/reminders/${r.id}/body`, { body }),
    onSuccess: () => {
      setEdit(null)
      done('Mesaj metni kaydedildi.')
    },
    onError: onErr,
  })
  const busy = sendNow.isPending || retry.isPending || cancel.isPending || save.isPending

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 2px' }}>
      {pv.data?.subject && <div><span className="mut">Konu:</span> {pv.data.subject}</div>}
      {edit === null ? (
        <div className="pnl" style={{ padding: '8px 10px', whiteSpace: 'pre-wrap' }}>{pv.isLoading ? 'Yükleniyor...' : pv.data?.body}</div>
      ) : (
        <Field label="Yalnızca bu mesaj için metin (değişkenler kullanılabilir)" htmlFor={`ed-${r.id}`}>
          <textarea
            id={`ed-${r.id}`}
            className="inp"
            rows={3}
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEdit(null)
              if (e.key === 's' && e.ctrlKey) {
                e.preventDefault()
                save.mutate(edit)
              }
            }}
            style={{ height: 'auto', padding: 6 }}
          />
        </Field>
      )}
      {pv.data && <SmsCounter count={edit !== null ? smsSegments(edit) : pv.data.count} channel={r.channel} />}
      {err && <div className="alert">{err}</div>}
      {can('messages.send') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {edit === null ? (
            <>
              {(pending || r.status === 'permanent_failed') && (
                <button className="btn p sm" disabled={busy} onClick={() => sendNow.mutate()}>Şimdi gönder</button>
              )}
              {(r.status === 'failed' || r.status === 'permanent_failed' || r.status === 'expired') && (
                <button className="btn sm" disabled={busy} onClick={() => retry.mutate()}>Yeniden dene</button>
              )}
              {pending && (
                <button className="btn sm" disabled={busy || !pv.data} onClick={() => setEdit(pv.data?.body ?? '')}>Düzenle</button>
              )}
              {pending && pv.data?.hasOverride && (
                <button className="btn sm" disabled={busy} onClick={() => save.mutate(null)}>Şablona döndür</button>
              )}
              {pending && (
                <button className="btn sm" disabled={busy} onClick={() => confirm('Bu hatırlatma iptal edilsin mi?') && cancel.mutate()}>İptal et</button>
              )}
            </>
          ) : (
            <>
              <button className="btn p sm" disabled={busy || !edit.trim()} onClick={() => save.mutate(edit)}>Kaydet</button>
              <button className="btn sm" onClick={() => setEdit(null)}>Vazgeç</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryPanel() {
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [q, from, to])
  const list = useQuery({
    queryKey: ['messages-history', q, from, to, page],
    queryFn: () => api.get<MessageHistoryResult>('/api/messaging/messages' + qs({ q, from, to, page })),
  })
  return (
    <section className="pnl">
      <div className="ph" style={{ height: 'auto', padding: '6px 12px', flexWrap: 'wrap' }}>
        <h2>Mesaj geçmişi</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="inp" style={{ width: 220 }} placeholder="Ara: telefon, sahip" aria-label="Geçmişte ara" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="mut" htmlFor="hf">Başlangıç</label>
          <input id="hf" type="date" className="inp" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label className="mut" htmlFor="ht">Bitiş</label>
          <input id="ht" type="date" className="inp" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Zaman</th><th>Kanal</th><th>Alıcı</th><th>Mesaj</th><th>Durum</th><th>Sağlayıcı / kimlik</th><th>Birim</th></tr>
          </thead>
          <tbody>
            {list.data?.items.map((m) => (
              <tr key={m.id}>
                <td className="mono">{fmtDateTime(m.sentAt)}</td>
                <td>{CHANNEL_LABEL[m.channel]}{m.isTest && <span className="tag" style={{ marginLeft: 6 }}>test</span>}</td>
                <td>
                  {m.ownerId ? <Link to={`/sahipler/${m.ownerId}`}>{m.ownerName}</Link> : <span className="mut">-</span>}
                  <div className="mono mut" style={{ fontSize: 12 }}>{m.channel === 'sms' ? formatTrPhone(m.to) : m.to}</div>
                </td>
                <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{m.body}</td>
                <td>
                  <span className={`st ${statusClass(m.status)}`}>{m.status === 'sent' ? 'Gönderildi' : m.status === 'delivered' ? 'Teslim edildi' : 'Başarısız'}</span>
                  {m.error && <div className="s-red" style={{ fontSize: 12 }}>{m.error}</div>}
                </td>
                <td className="mono mut" style={{ fontSize: 12 }}>{m.provider}{m.providerMsgId ? ` - ${m.providerMsgId}` : ''}</td>
                <td className="mono">{m.costUnits}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && <div className="empty">Gönderilmiş mesaj yok.</div>}
        {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
      </div>
      {list.data && <Pager page={page} total={list.data.total} pageSize={list.data.pageSize} onPage={setPage} />}
    </section>
  )
}

/* ---------- Mesajlaşma ayarları ---------- */

type SettingsForm = Omit<MessagingSettingsDto, 'vaccineOffsetsDays' | 'email' | 'sms'> & {
  offsetsText: string
  sms: Omit<MessagingSettingsDto['sms'], 'secretSet'>
  email: Omit<MessagingSettingsDto['email'], 'secretSet' | 'port'> & { port: string }
}

/** "7, 1, -3" -> [7, 1, -3] */
function parseOffsets(s: string): number[] | null {
  const parts = s.split(/[,\s;]+/).filter(Boolean)
  const n = parts.map(Number)
  return n.every((x) => Number.isInteger(x)) ? n : null
}

function offsetsHuman(list: number[] | null) {
  if (!list) return 'Geçersiz: virgülle ayrılmış tam sayılar girin.'
  return list
    .slice()
    .sort((a, b) => b - a)
    .map((d) => (d > 0 ? `${d} gün önce` : d === 0 ? 'vade günü' : `${-d} gün sonra (gecikme)`))
    .join(', ')
}

export function MessagingSettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const can = useCan()
  const q = useQuery({ queryKey: ['messaging-settings'], queryFn: () => api.get<MessagingSettingsDto>('/api/messaging/settings'), enabled: can('settings.manage') })
  const [f, setF] = useState<SettingsForm | null>(null)
  const [err, setErr] = useState('')
  const [smsSecret, setSmsSecret] = useState('')
  const [mailSecret, setMailSecret] = useState('')
  const [testTo, setTestTo] = useState({ sms: '', email: '' })
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!q.data) return
    const d = q.data
    setF({
      quietStart: d.quietStart,
      quietEnd: d.quietEnd,
      appointmentOffsetHours: d.appointmentOffsetHours,
      offsetsText: d.vaccineOffsetsDays.join(', '),
      sms: { provider: d.sms.provider, username: d.sms.username, header: d.sms.header },
      email: { enabled: d.email.enabled, host: d.email.host, port: d.email.port ? String(d.email.port) : '', secure: d.email.secure, user: d.email.user, from: d.email.from },
    })
  }, [q.data])

  const save = useMutation({
    mutationFn: (x: SettingsForm) =>
      api.put<MessagingSettingsDto>('/api/messaging/settings', {
        quietStart: x.quietStart,
        quietEnd: x.quietEnd,
        appointmentOffsetHours: Number(x.appointmentOffsetHours),
        vaccineOffsetsDays: parseOffsets(x.offsetsText) ?? [],
        sms: x.sms,
        email: { ...x.email, port: x.email.port ? Number(x.email.port) : null },
      }),
    onSuccess: () => {
      setErr('')
      qc.invalidateQueries()
      toast('Mesajlaşma ayarları kaydedildi.')
    },
    onError: (e) => setErr((e as Error).message),
  })
  const secret = useMutation({
    mutationFn: (x: { kind: 'sms' | 'email'; value: string }) => api.put<{ secretSet: boolean }>(`/api/messaging/secrets/${x.kind}`, { value: x.value }),
    onSuccess: (r, x) => {
      x.kind === 'sms' ? setSmsSecret('') : setMailSecret('')
      qc.invalidateQueries()
      toast(r.secretSet ? 'Parola şifrelenerek kaydedildi.' : 'Parola silindi.')
    },
    onError: (e) => toast((e as Error).message, 'err'),
  })
  const test = useMutation({
    mutationFn: (x: { channel: 'sms' | 'email'; to: string }) => api.post<{ ok: boolean; error: string | null }>('/api/messaging/test', x),
    onSuccess: (r) => (r.ok ? toast('Test mesajı gönderildi.') : toast(r.error ?? 'Test mesajı gönderilemedi.', 'err')),
    onError: (e) => toast((e as Error).message, 'err'),
  })

  if (!can('settings.manage')) return <SettingsLayout><div className="alert">Bu sayfa için yetkiniz yok.</div></SettingsLayout>
  if (q.isError) return <SettingsLayout><div className="alert">{(q.error as Error).message}</div></SettingsLayout>
  if (!f || !q.data) return <SettingsLayout><div className="mut">Yükleniyor...</div></SettingsLayout>

  const offsets = parseOffsets(f.offsetsText)
  const set = (p: Partial<SettingsForm>) => setF({ ...f, ...p })
  const submit = () => {
    if (!offsets) return setErr('Aşı hatırlatma günleri geçersiz.')
    save.mutate(f)
  }
  const needsCreds = f.sms.provider === 'netgsm' || f.sms.provider === 'iletimerkezi'

  return (
    <SettingsLayout>
      <div className="page-head">
        <h1>Mesajlaşma</h1>
        <span className="mut">SMS ve e-posta sağlayıcıları, sessiz saatler, varsayılan hatırlatma zamanları</span>
      </div>
      <form
        ref={formRef}
        className="pnl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 's' && e.ctrlKey) {
            e.preventDefault()
            submit()
          }
        }}
      >
        <fieldset className="sec">
          <legend>SMS sağlayıcı</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="g4">
              <Field label="Sağlayıcı" htmlFor="sp">
                <select id="sp" className="inp" value={f.sms.provider} onChange={(e) => set({ sms: { ...f.sms, provider: e.target.value as SmsProviderName } })}>
                  {(Object.keys(SMS_PROVIDER_LABEL) as SmsProviderName[]).map((k) => (
                    <option key={k} value={k}>{SMS_PROVIDER_LABEL[k]}</option>
                  ))}
                </select>
              </Field>
              {needsCreds && (
                <>
                  <Field label={f.sms.provider === 'iletimerkezi' ? 'API anahtarı (key) *' : 'Kullanıcı adı (abone no) *'} htmlFor="su">
                    <input id="su" className="inp" value={f.sms.username} autoComplete="off" onChange={(e) => set({ sms: { ...f.sms, username: e.target.value } })} />
                  </Field>
                  <Field label="Mesaj başlığı (gönderici adı) *" htmlFor="sh" error={f.sms.header.length > 11 ? 'En fazla 11 karakter' : undefined}>
                    <input id="sh" className="inp" value={f.sms.header} maxLength={11} onChange={(e) => set({ sms: { ...f.sms, header: e.target.value } })} />
                  </Field>
                </>
              )}
            </div>
            {needsCreds && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label={f.sms.provider === 'iletimerkezi' ? 'API hash' : 'API parolası'} htmlFor="ss" style={{ flex: '0 1 280px' }}>
                  <input id="ss" type="password" className="inp" autoComplete="new-password" placeholder={q.data.sms.secretSet ? '•••••••• (ayarlı - değiştirmek için yazın)' : 'Ayarlı değil'} value={smsSecret} onChange={(e) => setSmsSecret(e.target.value)} />
                </Field>
                <button type="button" className="btn" disabled={!smsSecret || secret.isPending} onClick={() => secret.mutate({ kind: 'sms', value: smsSecret })}>Parolayı kaydet</button>
                {q.data.sms.secretSet && (
                  <button type="button" className="btn" disabled={secret.isPending} onClick={() => confirm('SMS parolası silinsin mi?') && secret.mutate({ kind: 'sms', value: '' })}>Parolayı sil</button>
                )}
                <span className={`st ${q.data.sms.secretSet ? 's-ok' : 's-amb'}`}>{q.data.sms.secretSet ? 'Parola ayarlı (şifreli saklanıyor)' : 'Parola girilmedi'}</span>
              </div>
            )}
            {needsCreds && (
              <div className="alert amb">
                Hatirlatma mesajlari bilgilendirme amacli gonderilir (IYS filtresi kapali). Pazarlama/kampanya icerigi gondermeyin.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Test SMS - cep telefonu" htmlFor="ts" style={{ flex: '0 1 220px' }}>
                <input id="ts" className="inp" placeholder="05XX XXX XX XX" value={testTo.sms} onChange={(e) => setTestTo({ ...testTo, sms: e.target.value })} />
              </Field>
              <button type="button" className="btn" disabled={!testTo.sms || test.isPending} onClick={() => test.mutate({ channel: 'sms', to: testTo.sms })}>Test SMS gönder</button>
              <span className="mut">Önce ayarları kaydedin.</span>
            </div>
          </div>
        </fieldset>

        <fieldset className="sec">
          <legend>E-posta (SMTP)</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="ck"><input type="checkbox" checked={f.email.enabled} onChange={(e) => set({ email: { ...f.email, enabled: e.target.checked } })} /> E-posta ile hatırlatma gönder</label>
            {f.email.enabled && (
              <>
                <div className="g4">
                  <Field label="SMTP sunucusu *" htmlFor="eh"><input id="eh" className="inp" placeholder="smtp.ornek.com" value={f.email.host} onChange={(e) => set({ email: { ...f.email, host: e.target.value } })} /></Field>
                  <Field label="Port" htmlFor="ep"><input id="ep" className="inp mono" inputMode="numeric" placeholder="587" value={f.email.port} onChange={(e) => set({ email: { ...f.email, port: e.target.value.replace(/\D/g, '') } })} /></Field>
                  <Field label="Kullanıcı" htmlFor="eu"><input id="eu" className="inp" autoComplete="off" value={f.email.user} onChange={(e) => set({ email: { ...f.email, user: e.target.value } })} /></Field>
                  <Field label="Gönderen *" htmlFor="ef"><input id="ef" className="inp" placeholder='Klinik Adı <bilgi@ornek.com>' value={f.email.from} onChange={(e) => set({ email: { ...f.email, from: e.target.value } })} /></Field>
                </div>
                <label className="ck"><input type="checkbox" checked={f.email.secure} onChange={(e) => set({ email: { ...f.email, secure: e.target.checked } })} /> Doğrudan TLS (genellikle 465 numaralı port)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="SMTP parolası" htmlFor="es" style={{ flex: '0 1 280px' }}>
                    <input id="es" type="password" className="inp" autoComplete="new-password" placeholder={q.data.email.secretSet ? '•••••••• (ayarlı - değiştirmek için yazın)' : 'Ayarlı değil'} value={mailSecret} onChange={(e) => setMailSecret(e.target.value)} />
                  </Field>
                  <button type="button" className="btn" disabled={!mailSecret || secret.isPending} onClick={() => secret.mutate({ kind: 'email', value: mailSecret })}>Parolayı kaydet</button>
                  {q.data.email.secretSet && (
                    <button type="button" className="btn" disabled={secret.isPending} onClick={() => confirm('SMTP parolası silinsin mi?') && secret.mutate({ kind: 'email', value: '' })}>Parolayı sil</button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Test e-postası - alıcı" htmlFor="te" style={{ flex: '0 1 260px' }}>
                    <input id="te" type="email" className="inp" value={testTo.email} onChange={(e) => setTestTo({ ...testTo, email: e.target.value })} />
                  </Field>
                  <button type="button" className="btn" disabled={!testTo.email || test.isPending} onClick={() => test.mutate({ channel: 'email', to: testTo.email })}>Test e-postası gönder</button>
                </div>
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="sec">
          <legend>Zamanlama</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="g4">
              <Field label="Sessiz saat başlangıcı" htmlFor="qs"><input id="qs" type="time" className="inp mono" value={f.quietStart} onChange={(e) => set({ quietStart: e.target.value })} /></Field>
              <Field label="Sessiz saat bitişi" htmlFor="qe"><input id="qe" type="time" className="inp mono" value={f.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} /></Field>
              <Field label="Randevudan kaç saat önce" htmlFor="ao">
                <input id="ao" type="number" min={1} max={168} className="inp mono" value={f.appointmentOffsetHours} onChange={(e) => set({ appointmentOffsetHours: Number(e.target.value) })} />
              </Field>
              <Field label="Aşı hatırlatma günleri" htmlFor="vo" error={offsets ? undefined : 'Örn: 7, 1, -3'}>
                <input id="vo" className="inp mono" value={f.offsetsText} onChange={(e) => set({ offsetsText: e.target.value })} />
              </Field>
            </div>
            <span className="mut">
              Aşı: {offsetsHuman(offsets)} - saat 10:00'da. Eksi değer vadeden sonraki gecikme hatırlatmasıdır. Sessiz saatlerde planlanan mesajlar sessiz saat bitince gönderilir.
            </span>
          </div>
        </fieldset>

        {err && <div className="alert" style={{ margin: '10px 16px' }}>{err}</div>}
        <div className="form-foot">
          <span className="mut">Ctrl+S kaydeder. Parolalar ayrı kaydedilir ve hiçbir zaman ekranda gösterilmez.</span>
          <button type="submit" className="btn p" disabled={save.isPending}>Kaydet</button>
        </div>
      </form>
    </SettingsLayout>
  )
}

/* ---------- Mesaj şablonları ---------- */

export function TemplatesSettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const can = useCan()
  const editable = can('settings.manage')
  const list = useQuery({ queryKey: ['message-templates'], queryFn: () => api.get<MessageTemplateDto[]>('/api/messaging/templates') })
  const [sel, setSel] = useState<{ key: string; channel: 'sms' | 'email' } | null>(null)
  const current = useMemo(() => list.data?.find((t) => t.key === sel?.key && t.channel === sel?.channel) ?? list.data?.[0], [list.data, sel])
  const [body, setBody] = useState('')
  const [subject, setSubject] = useState('')
  const [err, setErr] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!current) return
    setBody(current.body)
    setSubject(current.subject ?? '')
    setErr('')
  }, [current])

  const preview = useQuery({
    queryKey: ['template-preview', body, subject],
    queryFn: () => api.post<{ body: string; subject: string | null; count: SmsCount; unknown: string[] }>('/api/messaging/templates/preview', { body, subject: subject || null }),
    enabled: !!body,
    placeholderData: (p) => p,
  })

  const save = useMutation({
    mutationFn: () => api.put(`/api/messaging/templates/${current!.key}/${current!.channel}`, { body, subject: current!.channel === 'email' ? subject || null : null }),
    onSuccess: () => {
      setErr('')
      qc.invalidateQueries({ queryKey: ['message-templates'] })
      toast('Şablon kaydedildi.')
    },
    onError: (e) => setErr((e as Error).message),
  })

  const insertVar = (k: string) => {
    const ta = taRef.current
    const token = `{${k}}`
    if (!ta) return setBody(body + token)
    const s = ta.selectionStart
    const e = ta.selectionEnd
    const next = body.slice(0, s) + token + body.slice(e)
    setBody(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(s + token.length, s + token.length)
    })
  }

  const dirty = current && (body !== current.body || (subject || null) !== (current.subject ?? null))
  const count = preview.data?.count ?? smsSegments(body)

  return (
    <SettingsLayout>
      <div className="page-head">
        <h1>Mesaj şablonları</h1>
        <span className="mut">Hatırlatma türlerine göre SMS ve e-posta metinleri</span>
      </div>
      {list.isError && <div className="alert">{(list.error as Error).message}</div>}
      <div className="row2">
        <section className="pnl" style={{ flex: '0 1 260px' }}>
          <div className="ph"><h2>Şablonlar</h2></div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {list.data?.map((t) => {
              const on = current?.key === t.key && current?.channel === t.channel
              return (
                <button
                  key={`${t.key}/${t.channel}`}
                  className="list-row"
                  aria-pressed={on}
                  style={{ textAlign: 'left', border: 0, borderBottom: '1px solid var(--line-3)', padding: '7px 12px', background: on ? 'var(--sel)' : 'transparent', cursor: 'pointer' }}
                  onClick={() => {
                    if (dirty && !confirm('Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?')) return
                    setSel({ key: t.key, channel: t.channel })
                  }}
                >
                  {TEMPLATE_LABEL[t.key] ?? t.key} <span className="mut">- {CHANNEL_LABEL[t.channel]}</span>
                </button>
              )
            })}
          </div>
        </section>

        {current && (
          <section className="pnl" style={{ flex: '1 1 480px', minWidth: 0 }}>
            <div className="ph">
              <h2>{TEMPLATE_LABEL[current.key] ?? current.key} - {CHANNEL_LABEL[current.channel]}</h2>
              <span className="mut" style={{ fontSize: 12 }}>son değişiklik {fmtDateTime(current.updatedAt)}</span>
            </div>
            <div
              style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}
              onKeyDown={(e) => {
                if (e.key === 's' && e.ctrlKey && editable) {
                  e.preventDefault()
                  save.mutate()
                }
              }}
            >
              {current.channel === 'email' && (
                <Field label="Konu" htmlFor="tsub">
                  <input id="tsub" className="inp" value={subject} readOnly={!editable} onChange={(e) => setSubject(e.target.value)} />
                </Field>
              )}
              <Field label="Metin" htmlFor="tbody" error={preview.data?.unknown.length ? `Bilinmeyen değişken: ${preview.data.unknown.map((u) => `{${u}}`).join(', ')}` : undefined}>
                <textarea
                  id="tbody"
                  ref={taRef}
                  className="inp"
                  rows={current.channel === 'email' ? 9 : 5}
                  style={{ height: 'auto', padding: 6, resize: 'vertical' }}
                  value={body}
                  readOnly={!editable}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
              <SmsCounter count={count} channel={current.channel} />
              {current.channel === 'sms' && <span className="mut" style={{ fontSize: 12 }}>Sayac degiskenler ornek degerlerle doldurulduktan sonraki uzunlugu gosterir; gercek isimlere gore degisebilir.</span>}
              {editable && (
                <div>
                  <div className="mut" style={{ fontSize: 12, marginBottom: 4 }}>Değişken ekle</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {TEMPLATE_VARIABLES.map((v) => (
                      <button key={v.key} type="button" className="btn sm" title={`Örnek: ${v.sample}`} onClick={() => insertVar(v.key)}>
                        <span className="mono">{`{${v.key}}`}</span>&nbsp;<span className="mut">{v.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="mut" style={{ fontSize: 12, marginBottom: 4 }}>Önizleme (örnek değerlerle)</div>
                <div className="pnl" style={{ padding: '8px 10px', whiteSpace: 'pre-wrap', background: 'var(--head)' }}>
                  {preview.data?.subject && <div style={{ fontWeight: 600, marginBottom: 4 }}>{preview.data.subject}</div>}
                  {body ? preview.data?.body : <span className="mut">Metin boş</span>}
                </div>
              </div>
              {err && <div className="alert">{err}</div>}
            </div>
            {editable && (
              <div className="form-foot">
                <span className="mut">Ctrl+S kaydeder.</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" disabled={!dirty} onClick={() => { setBody(current.body); setSubject(current.subject ?? '') }}>Değişiklikleri geri al</button>
                  <button className="btn p" disabled={!dirty || !body.trim() || save.isPending} onClick={() => save.mutate()}>Kaydet</button>
                </span>
              </div>
            )}
          </section>
        )}
      </div>
    </SettingsLayout>
  )
}
