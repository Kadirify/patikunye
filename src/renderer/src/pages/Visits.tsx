// Muayene modülü (C): S-40 muayene ekranı, S-41 muayene listesi, S-42 tedavi satırları,
// hayvan detayındaki "Muayeneler" ve "Tedaviler" sekmeleri.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs, HttpError } from '../api'
import { useCan, useSession } from '../session'
import { ChipNo, age, speciesLabel, useToast } from '../ui'
import { openPrint } from '../print'
import { Attachments } from '../components/Attachments'
import { formatDateTr } from '@shared/petvet'
import { SEX_LABEL, type UserDto } from '@shared/api-types'
import {
  DOSE_UNITS,
  ROUTES,
  SYSTEM_KEYS,
  SYSTEM_LABEL,
  TREATMENT_KIND_LABEL,
  VISIT_STATUS_LABEL,
  VISIT_TYPES,
  VISIT_TYPE_LABEL,
  VITAL_LIMITS,
  allergyMatch,
  isPerKg,
  totalDose,
  weightJumpWarning,
  type AnimalTreatmentDto,
  type DiagnosisSuggestion,
  type DoseUnit,
  type DrugSuggestion,
  type Findings,
  type SystemKey,
  type TreatmentInput,
  type TreatmentKind,
  type VisitAnimalContext,
  type VisitDetail,
  type VisitDisplayStatus,
  type VisitListResult,
  type VisitPhrase,
  type VisitStatusFilter,
  type VisitType,
  type Vitals,
} from '@shared/visits'

/* ───────────── Yardımcılar ───────────── */

const TZ = 'Europe/Istanbul'
/** ISO → datetime-local değeri (İstanbul saati) */
function toLocalInput(iso: string) {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T')
}
/** datetime-local → ISO (Türkiye UTC+3, yaz saati yok) */
function fromLocalInput(v: string) {
  const d = new Date(`${v}:00+03:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
}
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ })
/** "38,9" → 38.9 ; boş → null ; geçersiz → NaN */
function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}
const fmtNum = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))
const shortName = (n: string | null) => {
  if (!n) return '—'
  const p = n.replace(/^Dr\.?\s*/i, '').split(/\s+/)
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]
}

function StatusMark({ s, stale }: { s: VisitDisplayStatus; stale?: boolean }) {
  const cls = s === 'draft' ? (stale ? 's-red' : 's-amb') : s === 'amended' ? 's-blu' : 's-ok'
  return <span className={`st ${cls}`}>{VISIT_STATUS_LABEL[s]}{stale ? ' (24 sa+)' : ''}</span>
}

function useVets() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserDto[]>('/api/users'),
    staleTime: 5 * 60_000,
    select: (us) => us.filter((u) => u.role === 'vet' || u.role === 'admin'),
  })
}

/* ───────────── S-41 Muayene listesi ───────────── */

const STATUS_FILTERS: { key: VisitStatusFilter; label: string }[] = [
  { key: 'all', label: 'Tümü' },
  { key: 'draft', label: 'Taslak' },
  { key: 'stale', label: '24 saatten eski taslak' },
  { key: 'signed', label: 'İmzalı' },
  { key: 'amended', label: 'Düzeltilmiş' },
]

export function VisitsPage() {
  const { user } = useSession()
  const can = useCan()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const vets = useVets()
  const isVet = user?.role === 'vet' || user?.role === 'admin'
  const content = can('visits.read')
  // Hekim varsayılan olarak "benim muayenelerim" ile açar
  const vet = params.get('hekim') ?? (isVet ? 'me' : 'all')
  const status = (params.get('durum') as VisitStatusFilter | null) ?? 'all'
  const page = Number(params.get('sayfa') ?? '0')
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    if (k !== 'sayfa') n.delete('sayfa')
    setParams(n, { replace: true })
  }
  const vetId = vet === 'me' ? user?.id : vet === 'all' ? undefined : vet
  const query = {
    from: params.get('bas') ?? undefined,
    to: params.get('bit') ?? undefined,
    vetId,
    type: params.get('tur') ?? undefined,
    status,
    diagnosis: params.get('tani') ?? undefined,
    q: params.get('q') ?? undefined,
    limit: 50,
    offset: page * 50,
  }
  const list = useQuery({ queryKey: ['visits', query], queryFn: () => api.get<VisitListResult>('/api/visits' + qs(query)) })
  const total = list.data?.total ?? 0

  return (
    <>
      <div className="page-head">
        <h1>Muayeneler</h1>
        <span className="mut">Yeni muayene hayvan kartından ya da bekleme salonundan açılır.</span>
      </div>
      <nav aria-label="Durum filtresi" className="pnl fstrip">
        {STATUS_FILTERS.map((f) => (
          <button key={f.key} className={`fl${status === f.key ? ' on' : ''}`} onClick={() => set('durum', f.key === 'all' ? '' : f.key)}>
            <span className="kx">{f.label}</span>
          </button>
        ))}
      </nav>
      <section className="pnl" aria-label="Filtreler" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', padding: '10px 12px', alignItems: 'flex-end' }}>
        <div className="f" style={{ width: 150 }}>
          <label htmlFor="vf-from">Başlangıç</label>
          <input id="vf-from" type="date" className="inp mono" value={params.get('bas') ?? ''} onChange={(e) => set('bas', e.target.value)} />
        </div>
        <div className="f" style={{ width: 150 }}>
          <label htmlFor="vf-to">Bitiş</label>
          <input id="vf-to" type="date" className="inp mono" value={params.get('bit') ?? ''} onChange={(e) => set('bit', e.target.value)} />
        </div>
        <div className="f" style={{ width: 190 }}>
          <label htmlFor="vf-vet">Hekim</label>
          <select id="vf-vet" className="inp" value={vet} onChange={(e) => set('hekim', e.target.value)}>
            {isVet && <option value="me">Benim muayenelerim</option>}
            <option value="all">Tüm hekimler</option>
            {vets.data?.filter((v) => v.id !== user?.id).map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
          </select>
        </div>
        <div className="f" style={{ width: 140 }}>
          <label htmlFor="vf-type">Tür</label>
          <select id="vf-type" className="inp" value={params.get('tur') ?? ''} onChange={(e) => set('tur', e.target.value)}>
            <option value="">Tümü</option>
            {VISIT_TYPES.map((t) => <option key={t} value={t}>{VISIT_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        {content && (
          <div className="f" style={{ width: 180 }}>
            <label htmlFor="vf-dx">Tanı içeren</label>
            <input id="vf-dx" className="inp" defaultValue={params.get('tani') ?? ''} onBlur={(e) => set('tani', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && set('tani', e.currentTarget.value.trim())} />
          </div>
        )}
        <div className="f" style={{ width: 200 }}>
          <label htmlFor="vf-q">Hayvan / sahip</label>
          <input id="vf-q" className="inp" defaultValue={params.get('q') ?? ''} onBlur={(e) => set('q', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value.trim())} />
        </div>
      </section>
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Tarih</th><th>Hayvan</th><th>Sahip</th><th>Hekim</th><th>Tür</th>{content && <th>Tanı özeti</th>}<th>Durum</th></tr>
            </thead>
            <tbody>
              {list.data?.rows.map((r) => (
                <tr key={r.id} className={`click${r.stale ? ' hot' : ''}`} onDoubleClick={() => nav(`/muayene/${r.id}`)} onClick={() => nav(`/muayene/${r.id}`)}>
                  <td className="mono">{fmtDateTime(r.visitAt)}</td>
                  <td><strong>{r.animalName}</strong> <span className="mut">{speciesLabel(r.species)}</span></td>
                  <td>{r.ownerName ?? <span className="mut">—</span>}</td>
                  <td>{r.vetName ?? <span className="mut">seçilmedi</span>}</td>
                  <td>{VISIT_TYPE_LABEL[r.type]}</td>
                  {content && <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.diagnosisSummary ?? <span className="mut">—</span>}</td>}
                  <td><StatusMark s={r.displayStatus} stale={r.stale} />{r.version > 1 && <span className="mut mono"> v{r.version}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.rows.length === 0 && <div className="empty">Bu filtrelerle muayene yok.</div>}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
        </div>
        {total > 50 && (
          <div className="tfoot" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px' }}>
            <span className="mut">{page * 50 + 1}–{Math.min(total, (page + 1) * 50)} / {total}</span>
            <button className="btn sm" disabled={page === 0} onClick={() => set('sayfa', String(page - 1))}>Önceki</button>
            <button className="btn sm" disabled={(page + 1) * 50 >= total} onClick={() => set('sayfa', String(page + 1))}>Sonraki</button>
          </div>
        )}
      </section>
    </>
  )
}

/* ───────────── S-40 Muayene ekranı ───────────── */

export function VisitEditorPage() {
  const { id } = useParams()
  if (id === 'yeni') return <NewVisit />
  if (!id) return null
  return <VisitLoader key={id} id={id} />
}

/** /muayene/yeni?animal=ID[&appointment=ID] → taslak oluşturup editöre geçer */
function NewVisit() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const can = useCan()
  const animalId = params.get('animal')
  const appointmentId = params.get('appointment')
  const [err, setErr] = useState('')
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !animalId || !can('visits.write')) return
    started.current = true
    api
      .post<{ id: string }>('/api/visits', { animalId, ...(appointmentId ? { appointmentId } : {}) })
      .then((r) => nav(`/muayene/${r.id}`, { replace: true }))
      .catch((e) => setErr((e as Error).message))
  }, [animalId, appointmentId, nav, can])
  if (!can('visits.write')) return <div className="alert">Muayene açma yetkiniz yok.</div>
  if (!animalId) return <div className="alert amb">Muayene için önce bir hayvan seçin (hayvan kartından "Yeni muayene").</div>
  if (err) return <div className="alert">{err}</div>
  return <div className="mut">Muayene açılıyor…</div>
}

function VisitLoader({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['visit', id], queryFn: () => api.get<VisitDetail>(`/api/visits/${id}`), refetchOnWindowFocus: false })
  const can = useCan()
  if (q.isError) return <div className="alert">{(q.error as Error).message}</div>
  if (!q.data) return <div className="mut">Yükleniyor…</div>
  const v = q.data
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 }}>
      <AnimalSide animalId={v.animalId} excludeVisitId={v.id} />
      {v.restricted ? (
        <RestrictedVisit v={v} />
      ) : v.status === 'draft' && can('visits.write') ? (
        <VisitForm key={`${v.id}:${v.status}`} initial={v} />
      ) : (
        <SignedVisit v={v} />
      )}
    </div>
  )
}

/* Sol panel: hayvan kartı + önceki muayeneler + süren tedaviler + alerjiler */
function AnimalSide({ animalId, excludeVisitId }: { animalId: string; excludeVisitId?: string }) {
  const ctx = useAnimalContext(animalId, excludeVisitId)
  const [open, setOpen] = useState(true)
  const c = ctx.data
  if (!c) return <aside style={{ flex: '1 1 260px', maxWidth: 300 }} className="mut">{ctx.isError ? (ctx.error as Error).message : 'Yükleniyor…'}</aside>
  const a = c.animal
  return (
    <aside style={{ flex: '1 1 260px', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="pnl">
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Link to={`/hayvanlar/${a.id}`} style={{ fontSize: 16, fontWeight: 600, color: 'inherit', textDecoration: 'none' }}>{a.name}</Link>
            <button type="button" className="btn sm" aria-expanded={open} aria-label={open ? 'Hayvan kartını daralt' : 'Hayvan kartını genişlet'} onClick={() => setOpen(!open)} style={{ height: 22, padding: '0 6px' }}>{open ? '−' : '+'}</button>
          </div>
          <span className="mut" style={{ fontSize: 12 }}>
            {[speciesLabel(a.species), a.breed, SEX_LABEL[a.sex] + (a.neutered ? ' (kısır)' : ''), age(a.birthDate)].filter(Boolean).join(' · ')}
            {c.lastWeight ? ` · son ${fmtNum(c.lastWeight.kg)} kg` : ''}
          </span>
          {open && (
            <>
              <span style={{ fontSize: 12 }}><ChipNo value={a.chipNo} /></span>
              {(a.behavior || a.allergies.length > 0) && (
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                  {a.behavior && <span className="tag s-red">{a.behavior === 'bites' ? 'Isırır — ağızlık' : a.behavior === 'aggressive' ? 'Agresif' : 'Ürkek'}</span>}
                  {a.allergies.map((x) => <span key={x} className="tag s-red">{x} alerjisi</span>)}
                </span>
              )}
              {c.owner && (
                <span style={{ fontSize: 12, marginTop: 4 }}>
                  Sahip: <Link to={`/sahipler/${c.owner.id}`}>{c.owner.fullName}</Link>
                  {c.owner.phone && <> · <span className="mono">{c.owner.phone.replace(/^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/, '0$1 $2 $3 $4')}</span></>}
                </span>
              )}
            </>
          )}
        </div>
      </section>
      {open && (
        <>
          <section className="pnl">
            <div className="ph"><h2>Önceki muayeneler</h2></div>
            <div style={{ padding: '8px 12px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {c.recentVisits.length === 0 && <span className="mut">Kayıt yok</span>}
              {c.recentVisits.map((v) => (
                <div key={v.id}>
                  <Link to={`/muayene/${v.id}`} className="mono">{fmtShortDate(v.visitAt)}</Link> · {shortName(v.vetName)}
                  {v.status === 'draft' && <span className="s-amb"> · taslak</span>}
                  <br />
                  {v.summary || <span className="mut">{VISIT_TYPE_LABEL[v.type]}</span>}
                </div>
              ))}
            </div>
          </section>
          <section className="pnl">
            <div className="ph"><h2>Süren tedaviler</h2></div>
            <div style={{ padding: '8px 12px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {c.activeTreatments.length === 0 && <span className="mut">Yok</span>}
              {c.activeTreatments.map((t) => (
                <div key={t.id}>
                  <strong>{t.drug}</strong> {[t.dose != null ? `${fmtNum(t.dose)} ${t.doseUnit ?? ''}` : '', t.frequency].filter(Boolean).join(' · ')}
                  <br />
                  <span className="mut">{t.endDate ? `${formatDateTr(t.endDate)} tarihine kadar` : ''}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </aside>
  )
}

function useAnimalContext(animalId: string, exclude?: string) {
  return useQuery({
    queryKey: ['visit-context', animalId, exclude],
    queryFn: () => api.get<VisitAnimalContext>(`/api/visits/animal-context/${animalId}` + qs({ exclude })),
  })
}

function VisitHeaderInfo({ v }: { v: VisitDetail }) {
  return (
    <span className="mut">
      {fmtDateTime(v.visitAt)} · {v.vetName ?? 'hekim seçilmedi'} · {VISIT_TYPE_LABEL[v.type]}
    </span>
  )
}

function RestrictedVisit({ v }: { v: VisitDetail }) {
  return (
    <section className="pnl" style={{ flex: '999 1 640px', minWidth: 0 }}>
      <div className="ph"><h2>Muayene</h2><StatusMark s={v.displayStatus} /></div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <VisitHeaderInfo v={v} />
        <div className="alert amb">Muayene içeriğini görme yetkiniz yok. Yalnızca tarih, hekim ve tür gösterilir.</div>
      </div>
    </section>
  )
}

/* İmzalı (salt okunur) görünüm + versiyon sekmeleri + Ek/düzeltme */
function SignedVisit({ v }: { v: VisitDetail }) {
  const can = useCan()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [amending, setAmending] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const amend = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/api/visits/${v.id}/amend`, { reason }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast('Ek/düzeltme taslağı açıldı.')
      nav(`/muayene/${r.id}`)
    },
    onError: (e) => {
      const he = e as HttpError
      const existing = (he.details as { id?: string } | undefined)?.id
      if (he.code === 'HAS_SUCCESSOR' && existing) nav(`/muayene/${existing}`)
      else setErr(he.message)
    },
  })
  const f = v.findings
  const vitals = vitalCells(f.vitals)
  const abnormal = SYSTEM_KEYS.filter((k) => f.systems[k]?.status === 'abnormal')
  const normal = SYSTEM_KEYS.filter((k) => f.systems[k]?.status === 'normal')

  return (
    <section className="pnl" style={{ flex: '999 1 640px', minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--head)' }}>
        <strong style={{ fontSize: 15 }}>Muayene</strong>
        <StatusMark s={v.displayStatus} />
        <VisitHeaderInfo v={v} />
      </div>
      {v.versions.length > 1 && (
        <nav aria-label="Versiyonlar" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--line-2)' }}>
          {v.versions.map((x) => (
            <Link
              key={x.id}
              to={`/muayene/${x.id}`}
              aria-current={x.id === v.id ? 'page' : undefined}
              style={{ padding: '6px 14px', textDecoration: 'none', borderRight: '1px solid var(--line-2)', color: x.id === v.id ? '#fff' : 'var(--ink)', background: x.id === v.id ? 'var(--ink)' : 'transparent', fontSize: 12 }}
            >
              Versiyon {x.version} · {x.status === 'draft' ? 'taslak' : x.signedAt ? fmtShortDate(x.signedAt) : ''}
            </Link>
          ))}
        </nav>
      )}
      {v.supersededById && (
        <div className="alert amb" style={{ margin: '10px 14px 0' }}>
          Bu kayıt sonraki bir versiyonla düzeltildi. <Link to={`/muayene/${v.supersededById}`}>Son versiyonu aç</Link>
        </div>
      )}
      {v.amendReason && <div className="mut" style={{ padding: '8px 14px 0' }}>Düzeltme nedeni: {v.amendReason}</div>}
      <ReadSection l="S" title="Şikayet / öykü"><Pre text={v.subjective} /></ReadSection>
      <ReadSection l="O" title="Bulgular">
        {vitals.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginBottom: 8 }}>
            {vitals.map(([k, val]) => <span key={k}><span className="mut">{k}</span> <span className="mono">{val}</span></span>)}
          </div>
        )}
        {abnormal.map((k) => (
          <div key={k} style={{ color: 'var(--red)' }}><strong>{SYSTEM_LABEL[k]}: anormal</strong>{f.systems[k]?.note ? ` — ${f.systems[k]?.note}` : ''}</div>
        ))}
        {normal.length > 0 && <div className="mut">Normal: {normal.map((k) => SYSTEM_LABEL[k]).join(', ')}</div>}
        {!vitals.length && !abnormal.length && !normal.length && <span className="mut">—</span>}
      </ReadSection>
      <ReadSection l="A" title="Değerlendirme">
        {v.diagnoses.length > 0 && <div>Tanı: <strong>{v.diagnoses.join(', ')}</strong></div>}
        {v.differential.length > 0 && <div>Ayırıcı: {v.differential.join(', ')}</div>}
        <Pre text={v.assessment} />
      </ReadSection>
      <ReadSection l="P" title="Plan ve tedavi">
        {v.treatments.length > 0 && <TreatmentTable rows={v.treatments} />}
        <Pre text={v.planText} />
        {v.tests && <div>Tetkikler: {v.tests}</div>}
        {v.controlDate && <div>Kontrol tarihi: <span className="mono">{formatDateTr(v.controlDate)}</span></div>}
        {v.ownerAdvice && <div><span className="mut">Sahibe öneriler:</span> <Pre text={v.ownerAdvice} /></div>}
        {v.internalNote && <div><span className="mut">İç not:</span> <Pre text={v.internalNote} /></div>}
      </ReadSection>
      <div style={{ padding: '0 14px 12px' }}>
        <Attachments ownerType="visit" ownerId={v.id} title="Ekler" canUpload={can('visits.write')} />
      </div>
      {amending && (
        <form
          className="alert amb"
          style={{ margin: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault()
            setErr('')
            amend.mutate()
          }}
        >
          <div className="f" style={{ flex: '1 1 320px' }}>
            <label htmlFor="am-r">Düzeltme nedeni *</label>
            <input id="am-r" className="inp" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ör. Kilo yanlış girilmiş" />
          </div>
          <button className="btn p" disabled={amend.isPending || reason.trim().length < 3}>Yeni versiyon aç</button>
          <button type="button" className="btn" onClick={() => setAmending(false)}>Vazgeç</button>
          {err && <span className="err" style={{ flexBasis: '100%' }}>{err}</span>}
        </form>
      )}
      <div className="form-foot">
        <span className="mut" style={{ fontSize: 12 }}>
          {v.status === 'signed' ? `İmzalayan ${v.signedByName ?? ''} · ${v.signedAt ? fmtDateTime(v.signedAt) : ''} · Kayıt değiştirilemez, yalnızca ek/düzeltme eklenir.` : 'Taslak (düzenleme yetkiniz yok).'}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => openPrint('visit', v.id)}>Yazdır</button>
          {v.treatments.some((t) => t.kind === 'prescribed') && <button type="button" className="btn" onClick={() => openPrint('prescription', v.id)}>Tedavi talimatı</button>}
          {v.status === 'signed' && !v.supersededById && can('visits.write') && !amending && (
            <button type="button" className="btn p" onClick={() => setAmending(true)}>Ek/düzeltme</button>
          )}
        </span>
      </div>
    </section>
  )
}

function vitalCells(x: Vitals): [string, string][] {
  const out: [string, string][] = []
  if (x.temp != null) out.push(['Ateş', `${fmtNum(x.temp)} °C`])
  if (x.pulse != null) out.push(['Nabız', `${x.pulse} /dk`])
  if (x.resp != null) out.push(['Solunum', `${x.resp} /dk`])
  if (x.weight != null) out.push(['Kilo', `${fmtNum(x.weight)} kg`])
  if (x.bcs != null) out.push(['VKS', `${x.bcs}/9`])
  if (x.crt != null) out.push(['KDZ', `${fmtNum(x.crt)} sn`])
  if (x.dehydration != null) out.push(['Dehidrasyon', `%${fmtNum(x.dehydration)}`])
  if (x.mucosa) out.push(['Mukoza', x.mucosa])
  return out
}

const secStyle: CSSProperties = { padding: '12px 14px', borderBottom: '1px solid var(--line-2)', display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 10 }
const slStyle: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600, color: 'var(--accent)', paddingTop: 2 }
const shStyle: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600 }

function ReadSection({ l, title, children }: { l: string; title: string; children: React.ReactNode }) {
  return (
    <div style={secStyle}>
      <span style={slStyle} aria-hidden="true">{l}</span>
      <div>
        <p style={shStyle}>{title}</p>
        {children}
      </div>
    </div>
  )
}
function Pre({ text }: { text: string | null }) {
  return text ? <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div> : null
}

function TreatmentTable({ rows }: { rows: (TreatmentInput & { totalDose?: number | null; id?: string })[] }) {
  return (
    <div className="tbl-wrap" style={{ marginBottom: 8 }}>
      <table>
        <thead><tr><th>İlaç / uygulama</th><th>Doz</th><th>Yol</th><th>Sıklık · süre</th><th>Türü</th><th>E-reçete no</th></tr></thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.id ?? i}>
              <td><strong>{t.drug}</strong>{t.activeIngredient && <span className="mut"> ({t.activeIngredient})</span>}{t.note && <div className="mut" style={{ fontSize: 12 }}>{t.note}</div>}</td>
              <td className="mono">{t.dose != null ? `${fmtNum(t.dose)} ${t.doseUnit ?? ''}` : ''}{t.totalDose != null && ` → ${fmtNum(t.totalDose)} ${(t.doseUnit ?? '').replace('/kg', '')}`}</td>
              <td>{t.route}</td>
              <td>{[t.frequency, t.duration].filter(Boolean).join(' · ')}</td>
              <td>{TREATMENT_KIND_LABEL[t.kind]}</td>
              <td className="mono">{t.eReceteNo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────── Taslak formu ───────────── */

type VitalKey = Exclude<keyof Vitals, 'mucosa'>
const VITAL_FIELDS: { k: VitalKey; label: string; unit: string }[] = [
  { k: 'temp', label: 'Ateş', unit: '°C' },
  { k: 'pulse', label: 'Nabız', unit: '/dk' },
  { k: 'resp', label: 'Solunum', unit: '/dk' },
  { k: 'weight', label: 'Kilo', unit: 'kg' },
  { k: 'bcs', label: 'VKS', unit: '(1–9)' },
  { k: 'crt', label: 'KDZ', unit: 'sn' },
  { k: 'dehydration', label: 'Dehidrasyon', unit: '%' },
]

interface TreatmentRowState {
  key: number
  drug: string
  activeIngredient: string
  dose: string
  doseUnit: DoseUnit | ''
  route: string
  frequency: string
  duration: string
  kind: TreatmentKind
  eReceteNo: string
  note: string
  allergyAck: boolean
}

interface FormState {
  vetId: string
  visitAt: string // datetime-local
  type: VisitType
  subjective: string
  vitals: Record<VitalKey, string>
  mucosa: string
  systems: Findings['systems']
  assessment: string
  diagnoses: string[]
  differential: string[]
  planText: string
  tests: string
  ownerAdvice: string
  internalNote: string
  controlDate: string
  treatments: TreatmentRowState[]
}

let rowSeq = 1
function toForm(v: VisitDetail): FormState {
  const vt = v.findings.vitals
  return {
    vetId: v.vetId ?? '',
    visitAt: toLocalInput(v.visitAt),
    type: v.type,
    subjective: v.subjective ?? '',
    vitals: Object.fromEntries(VITAL_FIELDS.map((f) => [f.k, fmtNum(vt[f.k] as number | null | undefined)])) as Record<VitalKey, string>,
    mucosa: vt.mucosa ?? '',
    systems: v.findings.systems,
    assessment: v.assessment ?? '',
    diagnoses: v.diagnoses,
    differential: v.differential,
    planText: v.planText ?? '',
    tests: v.tests ?? '',
    ownerAdvice: v.ownerAdvice ?? '',
    internalNote: v.internalNote ?? '',
    controlDate: v.controlDate ?? '',
    treatments: v.treatments.map((t) => ({
      key: rowSeq++,
      drug: t.drug,
      activeIngredient: t.activeIngredient ?? '',
      dose: fmtNum(t.dose),
      doseUnit: (t.doseUnit ?? '') as DoseUnit | '',
      route: t.route ?? '',
      frequency: t.frequency ?? '',
      duration: t.duration ?? '',
      kind: t.kind,
      eReceteNo: t.eReceteNo ?? '',
      note: t.note ?? '',
      allergyAck: t.allergyAck,
    })),
  }
}

/** Form → API girdisi; sayı hatalarını alan bazında döndürür */
function toPayload(f: FormState): { body: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const vitals: Vitals = {}
  for (const vf of VITAL_FIELDS) {
    const n = parseNum(f.vitals[vf.k])
    if (Number.isNaN(n)) errors[vf.k] = `${vf.label} sayı olmalı.`
    else if (n != null) {
      const lim = VITAL_LIMITS[vf.k].hard
      if (n < lim[0] || n > lim[1]) errors[vf.k] = `${vf.label} ${fmtNum(lim[0])}–${lim[1]} arasında olmalı.`
      vitals[vf.k] = n
    }
  }
  if (f.mucosa.trim()) vitals.mucosa = f.mucosa.trim()
  const visitAt = fromLocalInput(f.visitAt)
  if (!visitAt) errors.visitAt = 'Tarih/saat geçersiz.'
  const treatments: TreatmentInput[] = []
  f.treatments.forEach((t, i) => {
    if (!t.drug.trim()) {
      if (t.dose || t.activeIngredient) errors[`t${i}`] = 'İlaç / ürün adını girin.'
      return
    }
    const dose = parseNum(t.dose)
    if (Number.isNaN(dose)) errors[`t${i}`] = 'Doz sayı olmalı.'
    treatments.push({
      drug: t.drug.trim(),
      activeIngredient: t.activeIngredient.trim() || null,
      dose: Number.isNaN(dose) ? null : dose,
      doseUnit: t.doseUnit || null,
      route: t.route || null,
      frequency: t.frequency.trim() || null,
      duration: t.duration.trim() || null,
      kind: t.kind,
      eReceteNo: t.eReceteNo.trim() || null,
      note: t.note.trim() || null,
      allergyAck: t.allergyAck,
    })
  })
  return {
    errors,
    body: {
      vetId: f.vetId || null,
      ...(visitAt ? { visitAt } : {}),
      type: f.type,
      subjective: f.subjective,
      findings: { vitals, systems: f.systems },
      assessment: f.assessment,
      diagnoses: f.diagnoses,
      differential: f.differential,
      planText: f.planText,
      tests: f.tests,
      ownerAdvice: f.ownerAdvice,
      internalNote: f.internalNote,
      controlDate: f.controlDate || null,
      treatments,
    },
  }
}

function VisitForm({ initial }: { initial: VisitDetail }) {
  const can = useCan()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const vets = useVets()
  const ctx = useAnimalContext(initial.animalId, initial.id)
  const [f, setF] = useState<FormState>(() => toForm(initial))
  const [dirty, setDirty] = useState(false)
  const [rev, setRev] = useState(initial.rev)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState('')
  const [conflict, setConflict] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'sign' | null>(null)
  const saving = useRef<Promise<boolean> | null>(null)
  const state = useRef({ f, dirty, rev })
  state.current = { f, dirty, rev }

  const upd = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setDirty(true)
  }, [])

  /** Taslağı kaydeder; başarılıysa true */
  const save = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      if (saving.current) await saving.current
      const { f: cur, rev: curRev } = state.current
      const { body, errors: errs } = toPayload(cur)
      setErrors(errs)
      if (Object.keys(errs).length) {
        setSaveErr(opts.silent ? 'Otomatik kayıt yapılamadı: alanlardaki hataları düzeltin.' : 'Alanlardaki hataları düzeltin.')
        return false
      }
      const p = (async () => {
        try {
          const r = await api.patch<{ rev: number; updatedAt: string }>(`/api/visits/${initial.id}`, { ...body, rev: curRev })
          // Hemen ardından gelen imza/kayıt eski sürümle gitmesin (yeniden çizim beklenmeden)
          state.current.rev = r.rev
          setRev(r.rev)
          setSavedAt(r.updatedAt)
          setSaveErr('')
          // Kayıt sırasında yeni değişiklik olmadıysa temiz say
          if (state.current.f === cur) setDirty(false)
          qc.invalidateQueries({ queryKey: ['visit-context'] })
          return true
        } catch (e) {
          const he = e as HttpError
          if (he.code === 'CONFLICT') setConflict(he.message)
          else if (he.code === 'SIGNED') {
            setConflict('Bu muayene başka bir bilgisayarda imzalandı.')
          } else setSaveErr((opts.silent ? 'Otomatik kayıt yapılamadı: ' : '') + he.message)
          return false
        }
      })()
      saving.current = p
      const ok = await p
      saving.current = null
      return ok
    },
    [initial.id, qc],
  )

  // Otomatik taslak kaydı (15 sn)
  useEffect(() => {
    const t = setInterval(() => {
      if (state.current.dirty && !saving.current && !conflict) void save({ silent: true })
    }, 15_000)
    return () => clearInterval(t)
  }, [save, conflict])

  // Sayfadan çıkarken kaydedilmemiş değişiklik uyarısı
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (state.current.dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  const allergies = ctx.data?.animal.allergies ?? initial.animal.allergies
  const prevVitals = ctx.data?.previousVitals?.vitals
  const prevWeight = ctx.data?.lastWeight?.kg ?? prevVitals?.weight ?? null
  const curWeight = parseNum(f.vitals.weight)
  const weightForDose = curWeight != null && !Number.isNaN(curWeight) ? curWeight : prevWeight

  async function sign() {
    if (!can('visits.sign')) return
    const w = parseNum(f.vitals.weight)
    if (w != null && !Number.isNaN(w) && weightJumpWarning(prevWeight, w) && !window.confirm(`Kilo önceki ölçümden (${fmtNum(prevWeight)} kg) %30'dan fazla farklı: ${fmtNum(w)} kg. Emin misiniz?`)) return
    const unacked = f.treatments.find((t) => t.drug && allergyMatch(allergies, t) && !t.allergyAck)
    if (unacked) {
      setSaveErr(`${unacked.drug}: alerji uyarısını onaylamadan imzalanamaz.`)
      return
    }
    setBusy('sign')
    try {
      if (!(await save())) return
      await api.post(`/api/visits/${initial.id}/sign`, { rev: state.current.rev })
      setDirty(false)
      toast('Muayene imzalandı.')
      qc.invalidateQueries()
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function saveNow() {
    setBusy('save')
    const ok = await save()
    setBusy(null)
    if (ok) toast('Taslak kaydedildi.')
  }

  async function removeDraft() {
    if (!window.confirm('Bu taslak muayene silinsin mi?')) return
    try {
      await api.del(`/api/visits/${initial.id}`)
      setDirty(false)
      qc.invalidateQueries()
      toast('Taslak silindi.')
      nav(initial.supersedesId ? `/muayene/${initial.supersedesId}` : `/hayvanlar/${initial.animalId}`)
    } catch (e) {
      setSaveErr((e as Error).message)
    }
  }

  function onKeyDown(e: RKeyboardEvent) {
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      void saveNow()
    } else if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      void sign()
    }
  }

  const tempN = parseNum(f.vitals.temp)
  const tempWarn = tempN != null && !Number.isNaN(tempN) && (tempN < VITAL_LIMITS.temp.warn[0] || tempN > VITAL_LIMITS.temp.warn[1])
  const allNormal = () => {
    const s: Findings['systems'] = { ...f.systems }
    for (const k of SYSTEM_KEYS) if (s[k]?.status !== 'abnormal') s[k] = { status: 'normal' }
    upd('systems', s)
  }

  return (
    <form
      className="pnl"
      style={{ flex: '999 1 640px', minWidth: 0 }}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        void saveNow()
      }}
      aria-label="Muayene formu"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--head)' }}>
        <strong style={{ fontSize: 15 }}>{initial.version > 1 ? `Ek/düzeltme · versiyon ${initial.version}` : 'Muayene'}</strong>
        <span className="st s-amb" aria-live="polite">
          Taslak{savedAt ? ` · ${fmtTime(savedAt)}'de kaydedildi` : ''}{dirty ? ' · kaydedilmemiş değişiklik' : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="f" style={{ width: 180 }}>
            <label htmlFor="v-at">Tarih / saat *</label>
            <input id="v-at" type="datetime-local" className={`inp mono${errors.visitAt ? ' bad' : ''}`} value={f.visitAt} onChange={(e) => upd('visitAt', e.target.value)} />
          </div>
          <div className="f" style={{ width: 170 }}>
            <label htmlFor="v-vet">Hekim *</label>
            <select id="v-vet" className="inp" value={f.vetId} onChange={(e) => upd('vetId', e.target.value)}>
              <option value="">— seçin —</option>
              {vets.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </div>
          <div className="f" style={{ width: 140 }}>
            <label htmlFor="v-type">Tür *</label>
            <select id="v-type" className="inp" value={f.type} onChange={(e) => upd('type', e.target.value as VisitType)}>
              {VISIT_TYPES.map((t) => <option key={t} value={t}>{VISIT_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
        </div>
      </div>

      {conflict && (
        <div className="alert" role="alert" style={{ margin: '10px 14px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{conflict}</span>
          <button type="button" className="btn sm" onClick={() => qc.invalidateQueries({ queryKey: ['visit', initial.id] }).then(() => window.location.reload())}>Yeniden yükle</button>
        </div>
      )}
      {initial.amendReason && <div className="mut" style={{ padding: '8px 14px 0' }}>Düzeltme nedeni: {initial.amendReason} · önceki versiyon <Link to={`/muayene/${initial.supersedesId}`}>v{initial.version - 1}</Link> görünür kalır.</div>}

      <div style={secStyle}>
        <span style={slStyle} aria-hidden="true">S</span>
        <div className="f">
          <label htmlFor="v-s" style={{ ...shStyle, margin: 0, color: 'var(--ink)' }}>Şikayet / öykü</label>
          <PhraseTextarea id="v-s" rows={3} value={f.subjective} onChange={(v) => upd('subjective', v)} />
          <span className="mut" style={{ fontSize: 11 }}>"/" yazarak hazır cümle ekleyin</span>
        </div>
      </div>

      <div style={secStyle}>
        <span style={slStyle} aria-hidden="true">O</span>
        <div>
          <p style={shStyle}>Bulgular</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, marginBottom: 10 }}>
            {VITAL_FIELDS.map((vf) => {
              const prev = vf.k === 'weight' ? prevWeight : (prevVitals?.[vf.k] as number | null | undefined)
              const cur = parseNum(f.vitals[vf.k])
              const arrow = prev != null && cur != null && !Number.isNaN(cur) ? (cur > prev ? ' ↑' : cur < prev ? ' ↓' : ' =') : ''
              const warn =
                vf.k === 'temp' ? tempWarn : vf.k === 'weight' && cur != null && !Number.isNaN(cur) ? weightJumpWarning(prevWeight, cur) : false
              return (
                <div key={vf.k} className="f">
                  <label htmlFor={`vt-${vf.k}`}>{vf.label} {vf.unit}</label>
                  <input
                    id={`vt-${vf.k}`}
                    className={`inp mono${errors[vf.k] ? ' bad' : ''}`}
                    inputMode="decimal"
                    value={f.vitals[vf.k]}
                    style={warn ? { borderColor: 'var(--amb-line)', background: 'var(--amb-bg)' } : undefined}
                    onChange={(e) => upd('vitals', { ...f.vitals, [vf.k]: e.target.value })}
                  />
                  {prev != null && <span className="mono mut" style={{ fontSize: 11 }}>önceki {fmtNum(prev)}{arrow}</span>}
                  {errors[vf.k] && <span className="err">{errors[vf.k]}</span>}
                  {!errors[vf.k] && warn && <span className="s-amb" style={{ fontSize: 11 }}>{vf.k === 'temp' ? '35–43 dışında' : '±%30 fark — emin misiniz?'}</span>}
                </div>
              )
            })}
            <div className="f">
              <label htmlFor="vt-muc">Mukoza</label>
              <input id="vt-muc" className="inp" list="mucosa-list" value={f.mucosa} onChange={(e) => upd('mucosa', e.target.value)} />
              <datalist id="mucosa-list">{['Pembe', 'Soluk', 'Hiperemik', 'Siyanotik', 'İkterik'].map((x) => <option key={x} value={x} />)}</datalist>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span className="mut" style={{ fontSize: 12 }}>Sistemler</span>
            <button type="button" className="btn sm" style={{ height: 24, fontSize: 12 }} onClick={allNormal}>Tümü normal</button>
          </div>
          <SystemsChecklist value={f.systems} onChange={(s) => upd('systems', s)} />
        </div>
      </div>

      <div style={secStyle}>
        <span style={slStyle} aria-hidden="true">A</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ ...shStyle, margin: 0 }}>Değerlendirme</p>
          <DiagnosisPicker label="Tanı (ön / kesin)" value={f.diagnoses} onChange={(v) => upd('diagnoses', v)} />
          <DiagnosisPicker label="Ayırıcı tanılar" value={f.differential} onChange={(v) => upd('differential', v)} />
          <PhraseTextarea id="v-a" rows={2} value={f.assessment} onChange={(v) => upd('assessment', v)} ariaLabel="Değerlendirme notu" placeholder="Değerlendirme notu" />
        </div>
      </div>

      <div style={{ ...secStyle, borderBottom: 0 }}>
        <span style={slStyle} aria-hidden="true">P</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ ...shStyle, margin: 0 }}>Plan ve tedavi</p>
          <TreatmentEditor rows={f.treatments} onChange={(r) => upd('treatments', r)} allergies={allergies} weight={weightForDose ?? null} errors={errors} />
          <div className="f">
            <label htmlFor="v-plan">Plan</label>
            <PhraseTextarea id="v-plan" rows={2} value={f.planText} onChange={(v) => upd('planText', v)} />
          </div>
          <div className="f">
            <label htmlFor="v-tests">İstenen tetkikler</label>
            <input id="v-tests" className="inp" value={f.tests} onChange={(e) => upd('tests', e.target.value)} placeholder="ör. Hemogram, biyokimya, röntgen (sol dirsek, 2 yön)" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0,1fr)', gap: 12, alignItems: 'start' }}>
            <div className="f">
              <label htmlFor="v-ctrl">Kontrol tarihi</label>
              <input id="v-ctrl" type="date" className="inp mono" min={f.visitAt.slice(0, 10)} value={f.controlDate} onChange={(e) => upd('controlDate', e.target.value)} />
              {f.controlDate && (
                <span style={{ fontSize: 12 }}>
                  <Link to={`/randevular?yeni=1&animal=${initial.animalId}&tarih=${f.controlDate}`}>Randevu ver</Link>
                  <span className="mut"> · imzalanınca SMS hatırlatma planlanır</span>
                </span>
              )}
            </div>
            <div className="f">
              <label htmlFor="v-adv">Sahibe öneriler (yazdırılır)</label>
              <PhraseTextarea id="v-adv" rows={2} value={f.ownerAdvice} onChange={(v) => upd('ownerAdvice', v)} />
            </div>
          </div>
          <div className="f">
            <label htmlFor="v-int">İç not (sahip çıktısında yer almaz)</label>
            <textarea id="v-int" className="inp" rows={1} value={f.internalNote} onChange={(e) => upd('internalNote', e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
            {can('vaccinations.write') && <Link to={`/asilar/uygula?animal=${initial.animalId}&visit=${initial.id}`}>Aşı uygula</Link>}
          </div>
          <Attachments ownerType="visit" ownerId={initial.id} title="Ekler (fotoğraf, laboratuvar sonucu)" />
        </div>
      </div>

      <div className="form-foot">
        <span className={saveErr ? 'err' : 'mut'} style={{ fontSize: 12 }} role={saveErr ? 'alert' : undefined}>
          {saveErr || 'İmzalandıktan sonra kayıt değiştirilemez, yalnızca ek/düzeltme eklenir.'}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={removeDraft}>Taslağı sil</button>
          <button type="button" className="btn" onClick={async () => { if (!dirty || (await save())) openPrint('visit', initial.id) }}>Yazdır</button>
          {f.treatments.some((t) => t.kind === 'prescribed' && t.drug) && (
            <button type="button" className="btn" onClick={async () => { if (!dirty || (await save())) openPrint('prescription', initial.id) }}>Tedavi talimatı</button>
          )}
          <button type="submit" className="btn" disabled={busy !== null}>Taslak kaydet <span className="k mut">Ctrl+S</span></button>
          {can('visits.sign') && (
            <button type="button" className="btn p" disabled={busy !== null || !!conflict} onClick={() => void sign()}>
              İmzala ve kapat <span className="k">Ctrl+Enter</span>
            </button>
          )}
        </span>
      </div>
    </form>
  )
}

/* Sistem kontrol listesi: tıklayınca normal → anormal → boş; anormalde not alanı */
function SystemsChecklist({ value, onChange }: { value: Findings['systems']; onChange(v: Findings['systems']): void }) {
  const cycle = (k: SystemKey) => {
    const cur = value[k]?.status
    const next = { ...value }
    if (!cur) next[k] = { status: 'normal' }
    else if (cur === 'normal') next[k] = { status: 'abnormal', note: value[k]?.note }
    else delete next[k]
    onChange(next)
  }
  const abnormal = SYSTEM_KEYS.filter((k) => value[k]?.status === 'abnormal')
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '0 16px' }}>
        {SYSTEM_KEYS.map((k) => {
          const s = value[k]?.status
          return (
            <button
              key={k}
              type="button"
              onClick={() => cycle(k)}
              aria-label={`${SYSTEM_LABEL[k]}: ${s === 'normal' ? 'normal' : s === 'abnormal' ? 'anormal' : 'değerlendirilmedi'} (değiştir)`}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', border: 0, borderBottom: '1px solid #F0EEE9', background: 'transparent', font: 'inherit', cursor: 'pointer', textAlign: 'left', color: s === 'abnormal' ? 'var(--red)' : 'var(--ink)' }}
            >
              <span>{SYSTEM_LABEL[k]}</span>
              {s === 'abnormal' ? <strong>anormal</strong> : <span className="mut">{s === 'normal' ? 'normal' : '—'}</span>}
            </button>
          )
        })}
      </div>
      {abnormal.map((k) => (
        <textarea
          key={k}
          className="inp"
          rows={2}
          aria-label={`${SYSTEM_LABEL[k]} notu`}
          placeholder={`${SYSTEM_LABEL[k]} — bulgu`}
          style={{ marginTop: 8 }}
          value={value[k]?.note ?? ''}
          onChange={(e) => onChange({ ...value, [k]: { status: 'abnormal', note: e.target.value } })}
        />
      ))}
    </>
  )
}

/* "/" ile hazır cümle ekleyen metin alanı */
function PhraseTextarea(props: { id: string; rows: number; value: string; onChange(v: string): void; ariaLabel?: string; placeholder?: string }) {
  const phrases = useQuery({ queryKey: ['visit-phrases'], queryFn: () => api.get<VisitPhrase[]>('/api/visits/phrases'), staleTime: 10 * 60_000 })
  const ref = useRef<HTMLTextAreaElement>(null)
  const [token, setToken] = useState<{ start: number; q: string } | null>(null)
  const [sel, setSel] = useState(0)
  const matches = useMemo(() => {
    if (!token) return []
    const q = token.q.toLocaleLowerCase('tr-TR')
    return (phrases.data ?? []).filter((p) => p.shortcut.toLocaleLowerCase('tr-TR').startsWith(q) || (q.length >= 3 && p.text.toLocaleLowerCase('tr-TR').includes(q))).slice(0, 8)
  }, [token, phrases.data])

  function detect(el: HTMLTextAreaElement) {
    const before = el.value.slice(0, el.selectionStart)
    const m = /(^|\s)\/([\p{L}\d_-]*)$/u.exec(before)
    setToken(m ? { start: before.length - m[2].length - 1, q: m[2] } : null)
    setSel(0)
  }
  function insert(p: VisitPhrase) {
    const el = ref.current
    if (!el || !token) return
    const end = el.selectionStart
    const v = el.value.slice(0, token.start) + p.text + el.value.slice(end)
    props.onChange(v)
    setToken(null)
    requestAnimationFrame(() => {
      const pos = token.start + p.text.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }
  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        id={props.id}
        className="inp"
        rows={props.rows}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        onChange={(e) => {
          props.onChange(e.target.value)
          detect(e.target)
        }}
        onKeyDown={(e) => {
          if (!matches.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => (s + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => (s - 1 + matches.length) % matches.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (e.ctrlKey) return
            e.preventDefault()
            insert(matches[sel])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setToken(null)
          }
        }}
        onBlur={() => setTimeout(() => setToken(null), 150)}
      />
      {matches.length > 0 && (
        <ul role="listbox" className="pnl" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', margin: 0, padding: 0, listStyle: 'none', maxHeight: 220, overflow: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,.12)' }}>
          {matches.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(p)
              }}
              style={{ padding: '6px 10px', cursor: 'pointer', background: i === sel ? 'var(--sel)' : undefined, fontSize: 12 }}
            >
              <span className="mono">/{p.shortcut}</span> <span className="mut">— {p.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* Tanı seçici: öneri listesi + serbest metin, birden çok */
function DiagnosisPicker({ label, value, onChange }: { label: string; value: string[]; onChange(v: string[]): void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(-1)
  const idBase = useRef(`dx-${Math.random().toString(36).slice(2, 8)}`).current
  const sugg = useQuery({
    queryKey: ['dx-suggest', q.trim()],
    queryFn: () => api.get<DiagnosisSuggestion[]>('/api/visits/suggest/diagnoses' + qs({ q: q.trim() })),
    enabled: open,
    staleTime: 60_000,
  })
  const items = (sugg.data ?? []).filter((s) => !value.some((v) => v.toLocaleLowerCase('tr-TR') === s.name.toLocaleLowerCase('tr-TR'))).slice(0, 10)
  const add = (name: string) => {
    const t = name.trim()
    if (t && !value.some((v) => v.toLocaleLowerCase('tr-TR') === t.toLocaleLowerCase('tr-TR'))) onChange([...value, t])
    setQ('')
    setSel(-1)
  }
  return (
    <div className="f">
      <label htmlFor={idBase}>{label}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }}>
        {value.map((d) => (
          <span key={d} style={{ fontSize: 13, padding: '3px 4px 3px 8px', border: '1px solid #BDB7AC', borderRadius: 2, background: 'var(--head)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {d}
            <button type="button" aria-label={`${d} kaldır`} onClick={() => onChange(value.filter((x) => x !== d))} style={{ border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit', padding: '0 4px' }}>×</button>
          </span>
        ))}
        <div style={{ position: 'relative' }}>
          <input
            id={idBase}
            className="inp"
            style={{ width: 240 }}
            placeholder="Tanı ekle…"
            value={q}
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-autocomplete="list"
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setQ(e.target.value)
              setOpen(true)
              setSel(-1)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, items.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, -1))
              } else if (e.key === 'Enter' && !e.ctrlKey) {
                e.preventDefault()
                add(sel >= 0 && items[sel] ? items[sel].name : q)
              } else if (e.key === 'Backspace' && !q && value.length) {
                onChange(value.slice(0, -1))
              }
            }}
          />
          {open && items.length > 0 && (
            <ul role="listbox" className="pnl" style={{ position: 'absolute', zIndex: 20, left: 0, top: '100%', width: 320, margin: 0, padding: 0, listStyle: 'none', maxHeight: 240, overflow: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,.12)' }}>
              {items.map((s, i) => (
                <li
                  key={s.name}
                  role="option"
                  aria-selected={i === sel}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(s.name)
                  }}
                  style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, background: i === sel ? 'var(--sel)' : undefined }}
                >
                  <span>{s.name}</span>
                  <span className="mut" style={{ fontSize: 11 }}>{s.category ?? ''}{s.uses ? ` · ${s.uses}×` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/* S-42 Tedavi / ilaç satırları */
function TreatmentEditor(props: {
  rows: TreatmentRowState[]
  onChange(r: TreatmentRowState[]): void
  allergies: string[]
  weight: number | null
  errors: Record<string, string>
}) {
  const { rows, onChange, allergies, weight } = props
  const drugs = useQuery({ queryKey: ['drug-suggest'], queryFn: () => api.get<DrugSuggestion[]>('/api/visits/suggest/drugs'), staleTime: 5 * 60_000 })
  const set = (i: number, patch: Partial<TreatmentRowState>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const blank = (): TreatmentRowState => ({
    key: rowSeq++,
    drug: '',
    activeIngredient: '',
    dose: '',
    doseUnit: '',
    route: '',
    frequency: '',
    duration: '',
    kind: 'administered',
    eReceteNo: '',
    note: '',
    allergyAck: false,
  })
  const pickDrug = (i: number, name: string) => {
    const d = drugs.data?.find((x) => x.drug === name)
    const r = rows[i]
    if (!d) return set(i, { drug: name, allergyAck: false })
    // Sık kullanılandan seçildi: boş alanları doldur
    set(i, {
      drug: name,
      activeIngredient: r.activeIngredient || d.activeIngredient || '',
      dose: r.dose || fmtNum(d.dose),
      doseUnit: r.doseUnit || d.doseUnit || '',
      route: r.route || d.route || '',
      frequency: r.frequency || d.frequency || '',
      duration: r.duration || d.duration || '',
      allergyAck: false,
    })
  }
  const cell: CSSProperties = { padding: '4px 4px' }
  return (
    <div className="tbl-wrap">
      <datalist id="drug-list">{drugs.data?.map((d) => <option key={d.drug} value={d.drug}>{d.activeIngredient ?? ''}</option>)}</datalist>
      <table>
        <thead>
          <tr><th>İlaç / ürün</th><th>Etken madde</th><th>Doz</th><th>Yol</th><th>Sıklık · süre</th><th>Türü</th><th>E-reçete no</th><th><span className="sr">Sil</span></th></tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const allergy = t.drug || t.activeIngredient ? allergyMatch(allergies, t) : null
            const dose = parseNum(t.dose)
            const total = dose != null && !Number.isNaN(dose) ? totalDose(dose, t.doseUnit, weight) : null
            const err = props.errors[`t${i}`]
            return (
              <FragmentRow key={t.key}>
                <tr style={allergy ? { background: 'var(--red-bg)' } : undefined}>
                  <td style={cell}><input className="inp" list="drug-list" aria-label="İlaç / ürün" value={t.drug} onChange={(e) => pickDrug(i, e.target.value)} style={{ minWidth: 150 }} /></td>
                  <td style={cell}><input className="inp" aria-label="Etken madde" value={t.activeIngredient} onChange={(e) => set(i, { activeIngredient: e.target.value, allergyAck: false })} style={{ minWidth: 110 }} /></td>
                  <td style={cell}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input className="inp mono" aria-label="Doz" inputMode="decimal" value={t.dose} onChange={(e) => set(i, { dose: e.target.value })} style={{ width: 64 }} />
                      <select className="inp" aria-label="Doz birimi" value={t.doseUnit} onChange={(e) => set(i, { doseUnit: e.target.value as DoseUnit | '' })} style={{ width: 82 }}>
                        <option value="">birim</option>
                        {DOSE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    {isPerKg(t.doseUnit) && (
                      <span className="mono" style={{ fontSize: 11 }}>
                        {total != null ? `→ ${fmtNum(total)} ${t.doseUnit.replace('/kg', '')} (${fmtNum(weight)} kg)` : <span className="s-amb">kilo girilmedi</span>}
                      </span>
                    )}
                  </td>
                  <td style={cell}>
                    <select className="inp" aria-label="Uygulama yolu" value={t.route} onChange={(e) => set(i, { route: e.target.value })} style={{ width: 96 }}>
                      <option value="">—</option>
                      {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td style={cell}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input className="inp" aria-label="Sıklık" placeholder="2×1" value={t.frequency} onChange={(e) => set(i, { frequency: e.target.value })} style={{ width: 60 }} />
                      <input className="inp" aria-label="Süre" placeholder="7 gün" value={t.duration} onChange={(e) => set(i, { duration: e.target.value })} style={{ width: 70 }} />
                    </div>
                  </td>
                  <td style={cell}>
                    <select className="inp" aria-label="Türü" value={t.kind} onChange={(e) => set(i, { kind: e.target.value as TreatmentKind })} style={{ width: 132 }}>
                      <option value="administered">Klinikte uygulandı</option>
                      <option value="prescribed">Reçete edildi</option>
                    </select>
                  </td>
                  <td style={cell}><input className="inp mono" aria-label="E-reçete no" value={t.eReceteNo} disabled={t.kind !== 'prescribed'} onChange={(e) => set(i, { eReceteNo: e.target.value })} style={{ width: 110 }} /></td>
                  <td style={cell}><button type="button" className="btn sm" aria-label={`${t.drug || 'Satırı'} sil`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
                </tr>
                {(allergy || err) && (
                  <tr>
                    <td colSpan={8} style={{ padding: '4px 8px', background: allergy ? 'var(--red-bg)' : undefined }}>
                      {allergy && (
                        <label className="ck" style={{ color: 'var(--red)', fontWeight: 600 }}>
                          <input type="checkbox" checked={t.allergyAck} onChange={(e) => set(i, { allergyAck: e.target.checked })} />
                          Dikkat: hayvanın "{allergy}" alerjisi kayıtlı. Hekim olarak riski değerlendirdim, uygulanacak.
                        </label>
                      )}
                      {err && <span className="err">{err}</span>}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={8} style={{ padding: '0 4px 6px' }}>
                    <input className="inp" aria-label="Tedavi notu" placeholder="Not" value={t.note} onChange={(e) => set(i, { note: e.target.value })} style={{ height: 26, fontSize: 12 }} />
                  </td>
                </tr>
              </FragmentRow>
            )
          })}
        </tbody>
      </table>
      <div style={{ padding: '6px 4px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" onClick={() => onChange([...rows, blank()])}>+ Satır ekle</button>
        <span className="mut" style={{ fontSize: 11 }}>⚠️ E-reçete Bakanlık sisteminde yazılır; burada yalnızca numarası bağlanır.</span>
      </div>
    </div>
  )
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/* ───────────── Hayvan detayı sekmeleri ───────────── */

export function AnimalVisitsTab({ animalId }: { animalId?: string }) {
  const can = useCan()
  const nav = useNavigate()
  const list = useQuery({
    queryKey: ['visits', { animalId }],
    queryFn: () => api.get<VisitListResult>('/api/visits' + qs({ animalId, limit: 200 })),
    enabled: !!animalId,
  })
  if (!animalId) return null
  const content = can('visits.read')
  return (
    <section className="pnl">
      <div className="ph">
        <h2>Muayeneler</h2>
        {can('visits.write') && <Link className="btn sm p" to={`/muayene/yeni?animal=${animalId}`}>Yeni muayene</Link>}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>Hekim</th><th>Tür</th>{content && <th>Tanı / özet</th>}{content && <th>Kontrol</th>}<th>Durum</th></tr></thead>
          <tbody>
            {list.data?.rows.map((r) => (
              <tr key={r.id} className={`click${r.stale ? ' hot' : ''}`} onClick={() => nav(`/muayene/${r.id}`)}>
                <td className="mono">{fmtDateTime(r.visitAt)}</td>
                <td>{r.vetName ?? <span className="mut">—</span>}</td>
                <td>{VISIT_TYPE_LABEL[r.type]}</td>
                {content && <td>{r.diagnosisSummary ?? <span className="mut">—</span>}</td>}
                {content && <td className="mono">{r.controlDate ? formatDateTr(r.controlDate) : ''}</td>}
                <td><StatusMark s={r.displayStatus} stale={r.stale} />{r.version > 1 && <span className="mut mono"> v{r.version}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.rows.length === 0 && <div className="empty">Bu hayvan için muayene kaydı yok.</div>}
        {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
      </div>
    </section>
  )
}

export function AnimalTreatmentsTab({ animalId }: { animalId?: string }) {
  const can = useCan()
  const [activeOnly, setActiveOnly] = useState(false)
  const list = useQuery({
    queryKey: ['treatments', animalId, activeOnly],
    queryFn: () => api.get<AnimalTreatmentDto[]>('/api/treatments' + qs({ animalId, active: activeOnly ? '1' : undefined })),
    enabled: !!animalId && can('visits.read'),
  })
  if (!animalId) return null
  if (!can('visits.read')) return <div className="alert amb">Tedavi kayıtlarını görme yetkiniz yok.</div>
  const today = todayIso()
  return (
    <section className="pnl">
      <div className="ph">
        <h2>Tedaviler</h2>
        <label className="ck" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Yalnızca süren tedaviler
        </label>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>İlaç / ürün</th><th>Doz</th><th>Yol</th><th>Sıklık · süre</th><th>Türü</th><th>Hekim</th><th>Durum</th></tr></thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id}>
                <td className="mono"><Link to={`/muayene/${t.visitId}`}>{fmtShortDate(t.visitAt)}</Link></td>
                <td><strong>{t.drug}</strong>{t.activeIngredient && <span className="mut"> ({t.activeIngredient})</span>}</td>
                <td className="mono">{t.dose != null ? `${fmtNum(t.dose)} ${t.doseUnit ?? ''}` : ''}{t.totalDose != null && ` → ${fmtNum(t.totalDose)} ${(t.doseUnit ?? '').replace('/kg', '')}`}</td>
                <td>{t.route}</td>
                <td>{[t.frequency, t.duration].filter(Boolean).join(' · ')}</td>
                <td>{TREATMENT_KIND_LABEL[t.kind]}{t.eReceteNo && <span className="mono mut"> · {t.eReceteNo}</span>}</td>
                <td>{shortName(t.vetName)}</td>
                <td>
                  {t.visitStatus === 'draft' ? (
                    <span className="st s-amb">Taslak muayene</span>
                  ) : t.active ? (
                    <span className="st s-blu">Sürüyor{t.endDate && t.endDate >= today ? ` · ${formatDateTr(t.endDate)}` : ''}</span>
                  ) : (
                    <span className="st s-gry">Bitti</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <div className="empty">{activeOnly ? 'Süren tedavi yok.' : 'Tedavi kaydı yok.'}</div>}
        {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
      </div>
    </section>
  )
}
