// S-60 PETVET iş listesi ve S-61 görev detayı
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../api'
import { ChipNo, Icon, PetvetState, kindLabel, speciesLabel, urgencyClass, urgencyText, useToast } from '../ui'
import { formatDateTr } from '@shared/petvet'
import type { PetvetSummary, PetvetTaskDetail, PetvetTaskListItem } from '@shared/api-types'

const FILTERS = [
  { key: 'overdue', label: 'Süresi doldu', n: (s: PetvetSummary) => s.overdue, hot: true },
  { key: 'today', label: 'Bugün son', n: (s: PetvetSummary) => s.today },
  { key: 'week', label: 'Bu hafta', n: (s: PetvetSummary) => s.week },
  { key: 'open', label: 'Tüm bekleyenler', n: (s: PetvetSummary) => s.open },
  { key: 'missing', label: 'Eksik bilgi', n: (s: PetvetSummary) => s.missing },
  { key: 'done', label: 'Bu ay girildi', n: (s: PetvetSummary) => s.doneThisMonth },
] as const

export function PetvetListPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const filter = params.get('f') ?? 'open'
  const summary = useQuery({ queryKey: ['petvet-summary'], queryFn: () => api.get<PetvetSummary>('/api/petvet/summary') })
  const list = useQuery({
    queryKey: ['petvet-tasks', filter],
    queryFn: () => api.get<PetvetTaskListItem[]>('/api/petvet/tasks' + qs({ filter })),
  })

  return (
    <>
      <div className="page-head">
        <h1>PETVET işleri</h1>
        <span className="mut">Bakanlık sistemine (hbs.tarbil.gov.tr) girilmesi gerekenler · yeni çip için süre 15 gün</span>
      </div>
      <nav aria-label="Durum filtresi" className="pnl fstrip">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`fl${filter === f.key ? ' on' : ''}`}
            style={f.key === 'overdue' && filter !== f.key && summary.data?.overdue ? { color: 'var(--red)' } : undefined}
            onClick={() => setParams({ f: f.key })}
          >
            <span className="v">{summary.data ? f.n(summary.data) : '–'}</span>
            <span className="kx">{f.label}</span>
          </button>
        ))}
      </nav>
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Son tarih</th><th>Kalan</th><th>İş</th><th>Hasta</th><th>Çip</th><th>Sahip</th><th>Hekim</th><th>Durum</th></tr>
            </thead>
            <tbody>
              {list.data?.map((t) => (
                <tr key={t.id} className={`click${t.urgency === 'overdue' && t.status !== 'done' ? ' hot' : ''}`} onClick={() => nav(`/petvet/${t.id}`)}>
                  <td className="mono">{formatDateTr(t.dueDate)}</td>
                  <td className={`mono ${t.status === 'done' ? 'mut' : urgencyClass(t.urgency)}`} style={{ fontWeight: 600 }}>
                    {t.status === 'done' ? '—' : urgencyText(t.urgency, t.daysLeft)}
                  </td>
                  <td>{kindLabel(t.kind)}</td>
                  <td><strong>{t.animalName}</strong> <span className="mut">{speciesLabel(t.species)}</span></td>
                  <td><ChipNo value={t.chipNo} short /></td>
                  <td>{t.ownerName}{t.missingFields.includes('owner.tckn') && <span className="s-amb"> — TCKN yok</span>}</td>
                  <td>{t.vetName}</td>
                  <td><PetvetState status={t.status} urgency={t.urgency} daysLeft={t.daysLeft} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.length === 0 && <div className="empty">Bu filtrede iş yok.</div>}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
        </div>
      </section>
    </>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  if (!value) return <span />
  return (
    <button
      type="button"
      className={`cb${done ? ' done' : ''}`}
      aria-label={`${label} kopyala`}
      title="Kopyala"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      <Icon d={done ? 'check' : 'copy'} size={14} />
    </button>
  )
}

export function PetvetTaskPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const toast = useToast()
  // Her açılış TCKN görüntüleme kaydı yazar; gereksiz tekrar çekmeyi önle
  const q = useQuery({
    queryKey: ['petvet-task', id],
    queryFn: () => api.get<PetvetTaskDetail>(`/api/petvet/tasks/${id}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const [tckn, setTckn] = useState('')
  const [err, setErr] = useState('')

  const done = useMutation({
    mutationFn: () => api.post(`/api/petvet/tasks/${id}/done`, { petvetRef: ref || undefined, note: note || undefined }),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Görev "girildi" olarak kapatıldı.')
    },
    onError: (e) => setErr((e as Error).message),
  })

  const t = q.data
  if (q.isError) return <div className="alert">{(q.error as Error).message}</div>
  if (!t) return <div className="mut">Yükleniyor…</div>
  const group = (g: 'owner' | 'animal') => t.copyFields.filter((f) => f.group === g)
  const open = t.status === 'pending' || t.status === 'missing_info'
  const allText = t.copyFields.map((f) => `${f.label}\t${f.value}`).join('\n')

  return (
    <>
      <nav className="crumb" aria-label="Konum"><Link to="/petvet">PETVET işleri</Link> › {kindLabel(t.kind)} — {t.animalName}</nav>
      <div className="pnl" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 20px', padding: '12px 14px', borderColor: open && t.urgency === 'overdue' ? 'var(--red)' : undefined }}>
        <div>
          <h1 style={{ fontSize: 18 }}>{kindLabel(t.kind)} kaydı · {t.animalName}</h1>
          <span className="mut">Olay tarihi {formatDateTr(t.eventDate)}{t.vetName ? ` · ${t.vetName}` : ''}</span>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          {open ? (
            <div className={`st ${urgencyClass(t.urgency)}`} style={{ fontWeight: 600 }}>
              {t.urgency === 'overdue' ? `Süre ${-t.daysLeft} gün önce doldu` : t.urgency === 'today' ? 'Bugün son gün' : `${t.daysLeft} gün kaldı`}
            </div>
          ) : (
            <PetvetState status={t.status} urgency={t.urgency} daysLeft={t.daysLeft} />
          )}
          <div className="mono mut" style={{ fontSize: 12 }}>son gün {formatDateTr(t.dueDate)}</div>
        </div>
      </div>

      {t.status === 'missing_info' && (
        <MissingTckn taskOwnerName={t.ownerName} onDone={() => qc.invalidateQueries()} tckn={tckn} setTckn={setTckn} ownerId={t.ownerId} />
      )}

      <div className="row2">
        {(['owner', 'animal'] as const).map((g) => (
          <section key={g} className="pnl" style={{ flex: '1 1 400px', minWidth: 0 }}>
            <div className="ph"><h2>{g === 'owner' ? 'Sahip' : 'Hayvan'}</h2></div>
            {group(g).map((f) => (
              <div key={f.key} className="cp">
                <span className="k">{f.label}</span>
                <span className="v" style={f.key === 'chipNo' ? { fontWeight: 600 } : undefined}>{f.value || <span className="mut">—</span>}</span>
                <CopyButton value={f.value} label={f.label} />
              </div>
            ))}
          </section>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="btn" onClick={() => navigator.clipboard.writeText(allText).then(() => toast('Tüm alanlar kopyalandı.'))}>Tümünü kopyala (sekmeli)</button>
        <a className="btn" href="https://hbs.tarbil.gov.tr/" target="_blank" rel="noreferrer">hbs.tarbil.gov.tr'yi aç ↗</a>
        <span className="mut" style={{ fontSize: 12 }}>Değerler PETVET'in beklediği biçimde (büyük harf, telefonda baştaki 0 yok) kopyalanır.</span>
      </div>

      {open ? (
        <form
          className="pnl"
          style={{ maxWidth: 820 }}
          onSubmit={(e) => {
            e.preventDefault()
            setErr('')
            done.mutate()
          }}
        >
          <div className="ph"><h2>Sonuç</h2></div>
          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '10px 12px' }}>
            <div className="f"><label htmlFor="ref">PETVET kayıt / referans no</label><input id="ref" className="inp mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="isteğe bağlı" /></div>
            <div className="f"><label htmlFor="note">Not</label><input id="note" className="inp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          <div className="form-foot">
            <span className="err">{err}</span>
            <button className="btn p" disabled={done.isPending || t.status === 'missing_info'}>Girildi olarak işaretle</button>
          </div>
        </form>
      ) : (
        <div className="alert ok" style={{ maxWidth: 820 }}>
          PETVET'e girildi{t.doneAt ? ` · ${new Date(t.doneAt).toLocaleString('tr-TR')}` : ''}{t.petvetRef ? ` · referans ${t.petvetRef}` : ''}{t.note ? ` · ${t.note}` : ''}
        </div>
      )}
      {t.copyFields.some((f) => f.key === 'tckn' && f.value) && (
        <p className="mut" style={{ margin: 0, fontSize: 12 }}>TCKN'nin tam hali bu ekranda gösterildi; görüntüleme denetim kaydına yazıldı.</p>
      )}
    </>
  )
}

function MissingTckn(props: { taskOwnerName: string | null; tckn: string; setTckn(v: string): void; onDone(): void; ownerId: string | null }) {
  const toast = useToast()
  const [err, setErr] = useState('')
  return (
    <form
      className="alert amb"
      style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}
      onSubmit={async (e) => {
        e.preventDefault()
        setErr('')
        try {
          await api.post(`/api/owners/${props.ownerId}/tckn`, { tckn: props.tckn })
          toast('TCKN eklendi; görev bekliyor durumuna geçti.')
          props.onDone()
        } catch (e) {
          setErr((e as Error).message)
        }
      }}
    >
      <div style={{ flex: '1 1 260px' }}>
        <strong className="s-amb">Eksik bilgi:</strong> {props.taskOwnerName} için TCKN kayıtlı değil. PETVET kaydı TCKN olmadan yapılamaz.
      </div>
      <div className="f" style={{ width: 200 }}>
        <label htmlFor="tk">TCKN</label>
        <input id="tk" className="inp mono" inputMode="numeric" maxLength={11} value={props.tckn} onChange={(e) => props.setTckn(e.target.value.replace(/\D/g, ''))} />
      </div>
      <button className="btn" disabled={!props.ownerId || props.tckn.length !== 11}>TCKN'yi kaydet</button>
      {err && <span className="err" style={{ flexBasis: '100%' }}>{err}</span>}
    </form>
  )
}
