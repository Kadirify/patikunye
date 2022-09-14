// S-95 KVKK talepleri ve S-114 KVKK metinleri
import { useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../../api'
import { useCan } from '../../session'
import { Field, useToast } from '../../ui'
import { Attachments } from '../../components/Attachments'
import { openPrint } from '../../print'
import { formatDateTr, todayIstanbul } from '@shared/petvet'
import {
  ANONYMIZE_CONFIRM,
  KVKK_CHANNELS,
  KVKK_CHANNEL_LABEL,
  KVKK_DUE_DAYS,
  KVKK_REQUEST_TYPES,
  KVKK_REQUEST_TYPE_LABEL,
  KVKK_STATUS_LABEL,
  KVKK_TEXT_KINDS,
  KVKK_TEXT_LABEL,
  type AnonymizePreview,
  type KvkkRequestDto,
  type KvkkRequestInput,
  type KvkkTextDto,
  type KvkkTextKind,
} from '@shared/admin'
import { Modal, NoAccess, downloadText, errText, fieldErr, fmtDateTime, useCtrlS } from './common'

export function KvkkPage() {
  const can = useCan()
  if (!can('kvkk.requests') && !can('settings.manage')) return <NoAccess />
  return (
    <>
      <div className="page-head"><h1>KVKK</h1><span className="mut">Kişisel veri talepleri (m.11) ve metinler</span></div>
      <nav className="pnl fstrip" aria-label="KVKK bölümleri">
        <NavLink end to="/ayarlar/kvkk" className={({ isActive }) => `fl${isActive ? ' on' : ''}`}><span className="kx" style={{ fontSize: 13 }}>Talepler</span></NavLink>
        <NavLink to="/ayarlar/kvkk/metinler" className={({ isActive }) => `fl${isActive ? ' on' : ''}`}><span className="kx" style={{ fontSize: 13 }}>Metinler</span></NavLink>
      </nav>
      <Routes>
        <Route index element={can('kvkk.requests') ? <RequestList /> : <NoAccess />} />
        <Route path="talep/:id" element={can('kvkk.requests') ? <RequestDetail /> : <NoAccess />} />
        <Route path="metinler" element={can('settings.manage') ? <Texts /> : <NoAccess />} />
      </Routes>
    </>
  )
}

function DaysLeft({ r }: { r: KvkkRequestDto }) {
  if (r.status !== 'open') return <span className="mut">—</span>
  const cls = r.daysLeft < 0 ? 's-red' : r.daysLeft <= 7 ? 's-amb' : 's-gry'
  return <span className={`mono ${cls}`} style={{ fontWeight: 600 }}>{r.daysLeft < 0 ? `${-r.daysLeft} gün gecikti` : r.daysLeft === 0 ? 'bugün son' : `${r.daysLeft} gün`}</span>
}

function StatusTag({ s }: { s: KvkkRequestDto['status'] }) {
  return <span className={`st ${s === 'open' ? 's-amb' : s === 'done' ? 's-ok' : 's-gry'}`}>{KVKK_STATUS_LABEL[s]}</span>
}

function RequestList() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const status = params.get('durum') ?? 'open'
  const prefillOwner = params.get('owner')
  const [creating, setCreating] = useState(!!prefillOwner)
  const list = useQuery({ queryKey: ['kvkk-requests', status], queryFn: () => api.get<KvkkRequestDto[]>('/api/kvkk/requests' + qs({ status: status === 'all' ? undefined : status })) })

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          ['open', 'Açık'],
          ['done', 'Yanıtlandı'],
          ['rejected', 'Reddedildi'],
          ['all', 'Tümü'],
        ].map(([k, l]) => (
          <button key={k} className={`btn sm${status === k ? ' p' : ''}`} onClick={() => setParams({ durum: k })}>{l}</button>
        ))}
        <button className="btn p" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>+ Yeni talep</button>
      </div>
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Başvuru</th><th>Kalan</th><th>Son gün</th><th>Tür</th><th>Sahip</th><th>Yol</th><th>Durum</th></tr>
            </thead>
            <tbody>
              {list.data?.map((r) => (
                <tr key={r.id} className={`click${r.status === 'open' && r.daysLeft < 0 ? ' hot' : ''}`} onClick={() => nav(`/ayarlar/kvkk/talep/${r.id}`)}>
                  <td className="mono">{formatDateTr(r.receivedAt)}</td>
                  <td><DaysLeft r={r} /></td>
                  <td className="mono">{formatDateTr(r.dueDate)}</td>
                  <td>{KVKK_REQUEST_TYPE_LABEL[r.type]}</td>
                  <td>{r.ownerName}</td>
                  <td>{KVKK_CHANNEL_LABEL[r.channel]}</td>
                  <td><StatusTag s={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.length === 0 && <div className="empty">Bu durumda talep yok.</div>}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{errText(list.error)}</div>}
        </div>
        <div className="tfoot mut">Yasal yanıt süresi başvurudan itibaren {KVKK_DUE_DAYS} gündür.</div>
      </section>
      {creating && (
        <NewRequest
          ownerId={prefillOwner}
          onClose={() => {
            setCreating(false)
            if (prefillOwner) setParams({ durum: status })
          }}
          onCreated={(id) => nav(`/ayarlar/kvkk/talep/${id}`)}
        />
      )}
    </>
  )
}

function NewRequest({ ownerId, onClose, onCreated }: { ownerId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [f, setF] = useState<Omit<KvkkRequestInput, 'ownerId'>>({ type: 'info', receivedAt: todayIstanbul(), channel: 'written', note: '' })
  const pre = useQuery({ queryKey: ['kvkk-owner', ownerId], queryFn: () => api.get<{ id: string; name: string }>(`/api/kvkk/owners/${ownerId}`), enabled: !!ownerId })
  useEffect(() => {
    if (pre.data && !owner) setOwner(pre.data)
  }, [pre.data, owner])
  const found = useQuery({
    queryKey: ['kvkk-owner-search', search],
    queryFn: () => api.get<{ id: string; name: string; phoneLast4: string | null; tcknLast4: string | null; anonymized: boolean }[]>('/api/kvkk/owners' + qs({ q: search })),
    enabled: search.trim().length >= 2 && !owner,
  })
  const save = useMutation({
    mutationFn: () => api.post<KvkkRequestDto>('/api/kvkk/requests', { ...f, ownerId: owner?.id }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      onCreated(r.id)
    },
  })
  useCtrlS(() => owner && save.mutate())

  return (
    <Modal title="Yeni KVKK talebi" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (owner) save.mutate()
        }}
      >
        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 12px' }}>
          <div className="f" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="k-owner">Sahip *</label>
            {owner ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <strong>{owner.name}</strong>
                <button type="button" className="btn sm" onClick={() => setOwner(null)}>Değiştir</button>
              </div>
            ) : (
              <>
                <input id="k-owner" className="inp" placeholder="Ad, telefon ya da TCKN son 4 hane" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
                {found.data?.map((o) => (
                  <button key={o.id} type="button" className="list-row" style={{ textAlign: 'left', border: 0, background: 'transparent', width: '100%' }} onClick={() => setOwner(o)}>
                    <strong>{o.name}</strong>{' '}
                    <span className="mut">{o.phoneLast4 ? `tel …${o.phoneLast4}` : ''}{o.tcknLast4 ? ` · TCKN …${o.tcknLast4}` : ''}{o.anonymized ? ' · anonim' : ''}</span>
                  </button>
                ))}
                {found.data?.length === 0 && <span className="mut">Sonuç yok.</span>}
              </>
            )}
            {fieldErr(save.error, 'ownerId') && <span className="err">{fieldErr(save.error, 'ownerId')}</span>}
          </div>
          <Field label="Talep türü *" htmlFor="k-type">
            <select id="k-type" className="inp" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as KvkkRequestInput['type'] })}>
              {KVKK_REQUEST_TYPES.map((t) => <option key={t} value={t}>{KVKK_REQUEST_TYPE_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Başvuru yolu *" htmlFor="k-ch">
            <select id="k-ch" className="inp" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as KvkkRequestInput['channel'] })}>
              {KVKK_CHANNELS.map((c) => <option key={c} value={c}>{KVKK_CHANNEL_LABEL[c]}</option>)}
            </select>
          </Field>
          <Field label="Başvuru tarihi *" htmlFor="k-date" error={fieldErr(save.error, 'receivedAt')}>
            <input id="k-date" type="date" className="inp mono" value={f.receivedAt} max={todayIstanbul()} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} />
          </Field>
          <Field label="Not" htmlFor="k-note">
            <input id="k-note" className="inp" value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
          <div className="mut" style={{ gridColumn: '1 / -1', fontSize: 12 }}>Dilekçeyi talep kaydedildikten sonra "Belgeler" bölümüne ekleyin.</div>
        </div>
        <div className="form-foot">
          <span className="err">{save.isError ? errText(save.error) : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
            <button className="btn p" disabled={!owner || save.isPending}>Kaydet</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

function RequestDetail() {
  const { id } = useParams()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['kvkk-request', id], queryFn: () => api.get<KvkkRequestDto>(`/api/kvkk/requests/${id}`) })
  const [note, setNote] = useState<string | null>(null)
  const [anon, setAnon] = useState(false)
  const [exportErr, setExportErr] = useState('')
  const r = q.data
  const close = useMutation({
    mutationFn: (status: KvkkRequestDto['status']) => api.patch<KvkkRequestDto>(`/api/kvkk/requests/${id}`, { status, responseNote: note ?? r?.responseNote ?? '' }),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Talep güncellendi.')
    },
  })

  async function exportCopy() {
    if (!r) return
    setExportErr('')
    try {
      const data = await api.get<unknown>(`/api/kvkk/owners/${r.ownerId}/export` + qs({ requestId: r.id }))
      downloadText(`kvkk-veri-kopyasi-${r.receivedAt}.json`, JSON.stringify(data, null, 2), 'application/json')
      toast('Veri kopyası indirildi (denetim kaydına yazıldı).')
    } catch (e) {
      setExportErr(errText(e))
    }
  }

  if (q.isError) return <div className="alert">{errText(q.error)}</div>
  if (!r) return <div className="mut">Yükleniyor…</div>
  const open = r.status === 'open'

  return (
    <>
      <nav className="crumb" aria-label="Konum"><Link to="/ayarlar/kvkk">KVKK talepleri</Link> › {KVKK_REQUEST_TYPE_LABEL[r.type]} — {r.ownerName}</nav>
      <div className="pnl" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 20px', padding: '12px 14px', alignItems: 'center', borderColor: open && r.daysLeft < 0 ? 'var(--red)' : undefined }}>
        <div>
          <h2 style={{ fontSize: 16, margin: 0 }}>{KVKK_REQUEST_TYPE_LABEL[r.type]}</h2>
          <span className="mut">{r.ownerName}{r.ownerAnonymized ? ' (anonimleştirildi)' : ''} · {KVKK_CHANNEL_LABEL[r.channel]} · başvuru {formatDateTr(r.receivedAt)}</span>
          {r.note && <div style={{ fontSize: 13 }}>{r.note}</div>}
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div><StatusTag s={r.status} /> <DaysLeft r={r} /></div>
          <div className="mono mut" style={{ fontSize: 12 }}>son gün {formatDateTr(r.dueDate)}{r.closedAt ? ` · kapandı ${fmtDateTime(r.closedAt)}` : ''}</div>
        </div>
      </div>

      <section className="pnl">
        <div className="ph"><h2>İşlem</h2></div>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" onClick={exportCopy} disabled={r.ownerAnonymized}>Veri kopyası indir (JSON)</button>
          <Link className="btn" to={`/sahipler/${r.ownerId}`}>Sahip kaydını aç (düzeltme)</Link>
          <button className="btn" onClick={() => setAnon(true)} disabled={r.ownerAnonymized}>Anonimleştir…</button>
          <button className="btn" onClick={() => openPrint('kvkk-response', r.id)}>Yanıt yazısı yazdır</button>
          {exportErr && <span className="err">{exportErr}</span>}
        </div>
      </section>

      <section className="pnl">
        <div className="ph"><h2>Yanıt</h2></div>
        <div style={{ padding: 12 }}>
          <Field label="Yanıt notu (verilen cevap, gönderim tarihi)" htmlFor="k-resp" error={fieldErr(close.error, 'responseNote')}>
            <textarea id="k-resp" className="inp" style={{ height: 80, padding: 8 }} value={note ?? r.responseNote ?? ''} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="form-foot">
          <span className="err">{close.isError && !fieldErr(close.error, 'responseNote') ? errText(close.error) : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {open ? (
              <>
                <button className="btn" disabled={close.isPending} onClick={() => close.mutate('rejected')}>Reddet ve kapat</button>
                <button className="btn p" disabled={close.isPending} onClick={() => close.mutate('done')}>Yanıtlandı olarak kapat</button>
              </>
            ) : (
              <button className="btn" disabled={close.isPending} onClick={() => close.mutate('open')}>Yeniden aç</button>
            )}
          </div>
        </div>
      </section>

      <Attachments ownerType="kvkk_request" ownerId={r.id} title="Dilekçe ve yazışmalar" />
      {anon && <AnonymizeDialog ownerId={r.ownerId} requestId={r.id} onClose={() => setAnon(false)} />}
    </>
  )
}

function AnonymizeDialog({ ownerId, requestId, onClose }: { ownerId: string; requestId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const pv = useQuery({ queryKey: ['kvkk-anon-preview', ownerId], queryFn: () => api.get<AnonymizePreview>(`/api/kvkk/owners/${ownerId}/anonymize-preview`) })
  const [confirmText, setConfirmText] = useState('')
  const [password, setPassword] = useState('')
  const run = useMutation({
    mutationFn: () => api.post<{ anonymName: string }>(`/api/kvkk/owners/${ownerId}/anonymize`, { confirm: confirmText, password, requestId }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast(`Sahip anonimleştirildi: ${r.anonymName}`)
      onClose()
    },
  })
  const p = pv.data
  const ready = confirmText.trim().toLocaleUpperCase('tr-TR') === ANONYMIZE_CONFIRM && !!password

  return (
    <Modal title="Anonimleştirme önizlemesi" onClose={onClose} width={640}>
      {!p ? (
        <div className="empty">{pv.isError ? errText(pv.error) : 'Yükleniyor…'}</div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) run.mutate()
          }}
        >
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="alert" style={{ fontSize: 13 }}>Bu işlem <strong>geri alınamaz</strong>. Kişisel veriler kalıcı olarak silinir.</div>
            <div>Ad: <strong>{p.currentName}</strong> → <strong>{p.anonymName}</strong></div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Silinecek alanlar</div>
              <ul style={{ margin: 0, paddingLeft: 18, columns: 2, fontSize: 13 }}>
                {p.clearedFields.map((f) => <li key={f.field} className={f.hasValue ? undefined : 'mut'}>{f.label}{f.hasValue ? '' : ' (boş)'}</li>)}
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Saklanacak kayıtlar (sahip bağlantısı anonim kimliğe döner)</div>
              <table>
                <tbody>
                  {p.kept.map((k) => (
                    <tr key={k.label}><td>{k.label}</td><td className="mono">{k.count}</td><td className="mut" style={{ fontSize: 12 }}>{k.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mut" style={{ fontSize: 12 }}>Not: Denetim kaydındaki geçmiş özetler değiştirilemez (hash zinciri). ⚠️ Saklama gerekçeleri hukukçuyla netleşmeli.</div>
            <Field label={`Onay için "${ANONYMIZE_CONFIRM}" yazın`} htmlFor="an-c" error={fieldErr(run.error, 'confirm')}>
              <input id="an-c" className="inp mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Yönetici parolası" htmlFor="an-p" error={fieldErr(run.error, 'password')}>
              <input id="an-p" type="password" className="inp" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
          </div>
          <div className="form-foot">
            <span className="err">{run.isError && !fieldErr(run.error, 'password') && !fieldErr(run.error, 'confirm') ? errText(run.error) : ''}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
              <button className="btn p" style={ready ? { background: 'var(--red)', borderColor: 'var(--red)' } : undefined} disabled={!ready || run.isPending || p.alreadyAnonymized}>
                Anonimleştir
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}

function Texts() {
  const qc = useQueryClient()
  const toast = useToast()
  const [kind, setKind] = useState<KvkkTextKind>('notice')
  const latest = useQuery({ queryKey: ['kvkk-texts'], queryFn: () => api.get<KvkkTextDto[]>('/api/kvkk/texts') })
  const history = useQuery({ queryKey: ['kvkk-texts', 'history'], queryFn: () => api.get<KvkkTextDto[]>('/api/kvkk/texts?history=1') })
  const cur = latest.data?.find((t) => t.kind === kind)
  const [body, setBody] = useState<string | null>(null)
  const text = body ?? cur?.body ?? ''
  const dirty = body !== null && body !== cur?.body
  const save = useMutation({
    mutationFn: () => api.post<{ version: number }>('/api/kvkk/texts', { kind, body: text }),
    onSuccess: (r) => {
      setBody(null)
      qc.invalidateQueries()
      toast(`Sürüm ${r.version} yayımlandı.`)
    },
  })
  useCtrlS(() => dirty && save.mutate(), dirty)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {KVKK_TEXT_KINDS.map((k) => (
          <button key={k} className={`btn sm${kind === k ? ' p' : ''}`} onClick={() => { setKind(k); setBody(null) }}>{KVKK_TEXT_LABEL[k]}</button>
        ))}
      </div>
      <div className="alert amb" style={{ fontSize: 13 }}>Uygulamayla gelen metinler örnektir; kullanmadan önce hukukçu onayı gerekir. Her kayıt yeni sürüm oluşturur, eski onaylar eski sürüme bağlı kalır. VERBİS kayıt yükümlülüğünü kliniğinize göre kontrol edin.</div>
      <form
        className="pnl"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) save.mutate()
        }}
      >
        <div className="ph"><h2>{KVKK_TEXT_LABEL[kind]}</h2><span className="mut" style={{ fontSize: 12 }}>{cur ? `Sürüm ${cur.version} · ${fmtDateTime(cur.publishedAt)}` : ''}</span></div>
        <div style={{ padding: 12 }}>
          <textarea className="inp" aria-label="Metin" style={{ height: 320, padding: 10, lineHeight: 1.5 }} value={text} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="form-foot">
          <span className="err">{save.isError ? errText(save.error) : ''}</span>
          <button className="btn p" disabled={!dirty || save.isPending}>Yeni sürüm olarak yayımla <span className="k">Ctrl+S</span></button>
        </div>
      </form>
      <section className="pnl">
        <div className="ph"><h2>Sürüm geçmişi</h2></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Sürüm</th><th>Yayım</th><th>Yayımlayan</th></tr></thead>
            <tbody>
              {history.data?.filter((t) => t.kind === kind).map((t) => (
                <tr key={t.id}><td className="mono">{t.version}</td><td className="mono">{fmtDateTime(t.publishedAt)}</td><td>{t.createdByName ?? 'Uygulama şablonu'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
