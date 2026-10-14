// Aşı modülü: Aşı uygula, Aşı takvimi, hayvan detayı Aşılar sekmesi, Bugün paneli, Aşılar ve ürünler
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../api'
import { useCan, useSession } from '../session'
import { Field, Icon, age, useToast } from '../ui'
import { openPrint } from '../print'
import { SettingsLayout } from '../components/SettingsNav'
import { addDaysIso, formatDateTr, todayIstanbul } from '@shared/petvet'
import { formatTrPhone } from '@shared/identity'
import { SPECIES_LABEL, type AnimalDetail, type AnimalListItem, type Species, type UserDto } from '@shared/api-types'
import {
  CALENDAR_FILTERS,
  CALENDAR_FILTER_LABEL,
  PLAN_STATUS_LABEL,
  VACCINE_KINDS,
  VACCINE_KIND_LABEL,
  maskPhone,
  validateSteps,
  type AnimalVaccinesDto,
  type CalendarDto,
  type CalendarFilter,
  type CalendarItem,
  type PlanStatus,
  type ProtocolStep,
  type ReminderInfo,
  type VaccinateResult,
  type VaccinePreviewDto,
  type VaccineKind,
  type VaccineProduct,
  type VaccineProtocol,
} from '@shared/vaccines'

// ---------------------------------------------------------------- küçük parçalar

const shortDate = (iso: string) => formatDateTr(iso).replace(/\.(\d{2})(\d{2})$/, '.$2')
const dayTime = (iso: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

function ReminderCell({ r }: { r: ReminderInfo | null }) {
  if (!r) return <span className="mut" title="Mesajlaşma modülü hazır değil">-</span>
  const ch = r.channel === 'email' ? 'E-posta' : r.channel ? 'SMS' : ''
  const at = r.at ? ' ' + dayTime(r.at).slice(0, 5) : ''
  switch (r.state) {
    case 'sent':
      return <span className="st s-ok">{ch || 'Gönderildi'}{at}</span>
    case 'failed':
      return <span className="st s-red" title={r.error ?? undefined}>{ch} gitmedi{r.error ? ` - ${r.error}` : ''}</span>
    case 'no_consent':
      return <span className="st s-gry">İzin yok</span>
    case 'cancelled':
      return <span className="st s-gry">İptal</span>
    case 'planned':
      return <span className="st s-blu">Planlandı</span>
    default:
      return <span className="mut">yok</span>
  }
}

function PlanStateCell({ s }: { s: PlanStatus }) {
  const cls = s === 'done' ? 's-ok' : s === 'cancelled' ? 's-gry' : s === 'external' ? 's-blu' : s === 'postponed' ? 's-amb' : 's-gry'
  return <span className={`st ${cls}`}>{PLAN_STATUS_LABEL[s]}</span>
}

function delayText(daysLeft: number) {
  if (daysLeft < 0) return { text: `${-daysLeft} g`, color: daysLeft < -7 ? 'var(--red)' : 'var(--amb)' }
  if (daysLeft === 0) return { text: 'bugün', color: 'var(--amb)' }
  return { text: `${daysLeft} g kaldı`, color: 'var(--muted)' }
}

/** Basit kalıcı diyalog: Esc kapatır */
function Dialog({ title, onClose, children, width = 440 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, background: 'rgba(29,28,26,.35)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '10vh', zIndex: 50 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="pnl" style={{ width, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
        <div className="ph"><h2>{title}</h2><button type="button" className="btn sm" onClick={onClose} aria-label="Kapat">Kapat</button></div>
        <div style={{ padding: 12 }}>{children}</div>
      </div>
    </div>
  )
}

type PlanAction = { kind: 'postpone' | 'external' | 'cancel'; planId: string; title: string; dueDate: string }

/** Plan satırı işlemleri: Ertele, Başka klinikte yaptırıldı, İptal */
function PlanActionDialog({ action, onClose }: { action: PlanAction; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const today = todayIstanbul()
  const [date, setDate] = useState(action.kind === 'postpone' ? addDaysIso(today, 7) : today)
  const [text, setText] = useState('')
  const [product, setProduct] = useState('')
  const [err, setErr] = useState('')
  const m = useMutation({
    mutationFn: () => {
      const base = `/api/vaccination-plans/${action.planId}`
      if (action.kind === 'postpone') return api.post(`${base}/postpone`, { dueDate: date, reason: text || undefined })
      if (action.kind === 'cancel') return api.post(`${base}/cancel`, { reason: text })
      return api.post(`${base}/external`, { givenAt: date, productName: product || undefined, externalClinic: text || undefined })
    },
    onSuccess: () => {
      qc.invalidateQueries()
      toast(action.kind === 'postpone' ? `Vade ${formatDateTr(date)} olarak ertelendi.` : action.kind === 'cancel' ? 'Plan satırı iptal edildi.' : 'Dış kayıt eklendi.')
      onClose()
    },
    onError: (e) => setErr((e as Error).message),
  })
  const heading = action.kind === 'postpone' ? 'Ertele' : action.kind === 'cancel' ? 'Planı iptal et' : 'Başka klinikte yaptırıldı'
  return (
    <Dialog title={`${heading} - ${action.title}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setErr('')
          m.mutate()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <span className="mut">Mevcut vade: {formatDateTr(action.dueDate)}</span>
        {action.kind !== 'cancel' && (
          <Field label={action.kind === 'postpone' ? 'Yeni vade *' : 'Uygulama tarihi *'} htmlFor="pa-d">
            <input id="pa-d" type="date" className="inp" value={date} min={action.kind === 'postpone' ? today : undefined} max={action.kind === 'external' ? today : undefined} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        )}
        {action.kind === 'external' && (
          <Field label="Ürün (biliniyorsa)" htmlFor="pa-p"><input id="pa-p" className="inp" value={product} onChange={(e) => setProduct(e.target.value)} /></Field>
        )}
        <Field label={action.kind === 'cancel' ? 'Neden *' : action.kind === 'external' ? 'Klinik' : 'Not'} htmlFor="pa-t">
          <input id="pa-t" className="inp" value={text} onChange={(e) => setText(e.target.value)} required={action.kind === 'cancel'} minLength={action.kind === 'cancel' ? 3 : undefined} autoFocus={action.kind === 'cancel'} />
        </Field>
        {action.kind === 'postpone' && <span className="mut">Hatırlatmalar yeni vadeye göre yeniden planlanır.</span>}
        {action.kind === 'external' && <span className="mut">Kayıt "dış kayıt" olarak girilir; PETVET görevi açılmaz. Sonraki doz protokolden planlanır.</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {err && <span className="err" role="alert">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn p" disabled={m.isPending}>{m.isPending ? 'Kaydediliyor...' : 'Kaydet'}</button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Aşı takvimi

export function VaccineCalendarPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const filter = (params.get('f') as CalendarFilter) ?? 'overdue'
  const kind = params.get('kind') ?? ''
  const species = params.get('species') ?? ''
  const page = Number(params.get('p') ?? 1)
  const view = params.get('v') === 'ay' ? 'month' : 'list'
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [action, setAction] = useState<PlanAction | null>(null)

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    if (k !== 'p') n.delete('p')
    setParams(n)
    setSel(new Set())
  }

  const q = useQuery({
    queryKey: ['vaccine-calendar', view === 'month' ? 'month' : filter, kind, species, view === 'month' ? 1 : page],
    queryFn: () =>
      api.get<CalendarDto>(
        '/api/vaccine-calendar' + qs({ filter: view === 'month' ? 'month' : filter, kind, species, page: view === 'month' ? 1 : page, pageSize: view === 'month' ? 200 : 50 }),
      ),
  })
  const d = q.data
  const items = d?.items ?? []
  const allSel = items.length > 0 && items.every((i) => sel.has(i.planId))

  const remind = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number }>('/api/vaccination-plans/remind', { planIds: [...sel] }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast(`${r.queued} hatırlatma kuyruğa alındı${r.skipped ? `, ${r.skipped} satır atlandı (sahip/izin yok)` : ''}.`)
      setSel(new Set())
    },
    onError: (e) => toast((e as Error).message, 'err'),
  })

  const selected = items.filter((i) => sel.has(i.planId))
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1

  return (
    <>
      <div className="page-head">
        <h1>Aşı takvimi</h1>
        <span className="mut">Vadesi gelen ve geçen aşılar</span>
        <div className="right" role="group" aria-label="Görünüm" style={{ display: 'inline-flex', gap: 0 }}>
          <button className={`btn sm${view === 'list' ? ' p' : ''}`} onClick={() => set('v', '')} aria-pressed={view === 'list'}>Liste</button>
          <button className={`btn sm${view === 'month' ? ' p' : ''}`} onClick={() => set('v', 'ay')} aria-pressed={view === 'month'}>Ay</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'stretch' }}>
        {view === 'list' && (
          <nav aria-label="Hazır filtre" className="pnl fstrip" style={{ flex: '1 1 auto' }}>
            {CALENDAR_FILTERS.filter((f) => f !== 'all').map((f) => (
              <button key={f} className={`fl${filter === f ? ' on' : ''}`} onClick={() => set('f', f)} style={(f === 'overdue' || f === 'failed') && filter !== f && d?.counts[f] ? { color: 'var(--red)' } : undefined}>
                <span className="v">{d ? d.counts[f] : '-'}</span>
                <span className="kx">{CALENDAR_FILTER_LABEL[f]}</span>
              </button>
            ))}
          </nav>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="inp" aria-label="Aşı türü" value={kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Tüm aşılar</option>
            {VACCINE_KINDS.map((k) => <option key={k} value={k}>{VACCINE_KIND_LABEL[k]}</option>)}
          </select>
          <select className="inp" aria-label="Tür" value={species} onChange={(e) => set('species', e.target.value)}>
            <option value="">Tüm türler</option>
            {(['cat', 'dog', 'ferret'] as Species[]).map((s) => <option key={s} value={s}>{SPECIES_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      {d && !d.remindersAvailable && <div className="alert amb">Mesajlaşma modülü hazır olmadığı için hatırlatma durumları gösterilemiyor.</div>}

      {view === 'month' ? (
        <MonthView items={items} onPick={(id) => nav(`/hayvanlar/${id}`)} />
      ) : (
        <section className="pnl">
          {sel.size > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--sel)', borderBottom: '1px solid #b8c8e3' }}>
              <strong>{sel.size} seçili</strong>
              {can('messages.send') && (
                <button className="btn sm" disabled={remind.isPending} onClick={() => remind.mutate()}>Hatırlatma gönder</button>
              )}
              {can('appointments.write') && (
                <button
                  className="btn sm"
                  disabled={selected.length !== 1}
                  title={selected.length !== 1 ? 'Randevu önermek için tek satır seçin' : undefined}
                  onClick={() => {
                    const x = selected[0]
                    nav(`/randevular${qs({ yeni: 1, animal: x.animalId, tarih: x.dueDate < todayIstanbul() ? todayIstanbul() : x.dueDate })}`)
                  }}
                >
                  Randevu öner
                </button>
              )}
              <button className="btn sm" onClick={() => openPrint('worklist', undefined, { list: 'vaccine-calls' })}>Arama listesi yazdır</button>
            </div>
          )}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" className="ck" aria-label="Tümünü seç" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(items.map((i) => i.planId)))} />
                  </th>
                  <th>Vade</th><th>Gecikme</th><th>Hasta</th><th>Aşı</th><th>Sahip</th><th>Telefon</th><th>Hatırlatma</th><th>Randevu</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <CalendarRow key={i.planId} i={i} checked={sel.has(i.planId)} onCheck={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(i.planId); else n.delete(i.planId); return n })} onAction={setAction} />
                ))}
              </tbody>
            </table>
            {d && items.length === 0 && <div className="empty">Bu filtrede aşı yok.</div>}
            {q.isError && <div className="alert" style={{ margin: 12 }}>{(q.error as Error).message}</div>}
          </div>
          {d && d.total > 0 && (
            <div className="tfoot">
              <span>{d.total} kayıttan {items.length} gösteriliyor - satır sonundaki ⋯ : ertele, başka klinikte yapıldı, iptal</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="btn sm" disabled={page <= 1} onClick={() => set('p', String(page - 1))}>Önceki</button>
                Sayfa {page} / {pages}
                <button className="btn sm" disabled={page >= pages} onClick={() => set('p', String(page + 1))}>Sonraki</button>
              </span>
            </div>
          )}
        </section>
      )}
      {action && <PlanActionDialog action={action} onClose={() => setAction(null)} />}
    </>
  )
}

function CalendarRow({ i, checked, onCheck, onAction }: { i: CalendarItem; checked: boolean; onCheck: (v: boolean) => void; onAction: (a: PlanAction) => void }) {
  const can = useCan()
  const [menu, setMenu] = useState(false)
  const delay = delayText(i.daysLeft)
  const title = `${i.animalName} - ${VACCINE_KIND_LABEL[i.kind]}${i.doseLabel ? ' ' + i.doseLabel : ''}`
  const canWrite = can('vaccinations.write')
  const canPlan = canWrite || can('messages.send')
  const act = (kind: PlanAction['kind']) => {
    setMenu(false)
    onAction({ kind, planId: i.planId, title, dueDate: i.dueDate })
  }
  return (
    <tr style={checked ? { background: 'var(--sel)' } : undefined}>
      <td><input type="checkbox" className="ck" aria-label={`${i.animalName} seç`} checked={checked} onChange={(e) => onCheck(e.target.checked)} /></td>
      <td className="mono">{shortDate(i.dueDate)}{i.status === 'postponed' && <span className="mut" title="Ertelendi"> ↻</span>}</td>
      <td className="mono" style={{ color: delay.color }}>{delay.text}</td>
      <td><Link to={`/hayvanlar/${i.animalId}`}><strong>{i.animalName}</strong></Link> <span className="mut">{SPECIES_LABEL[i.species]}</span></td>
      <td>{VACCINE_KIND_LABEL[i.kind]}{i.doseLabel ? ` - ${i.doseLabel}` : ''}</td>
      <td>{i.ownerName ?? '-'}</td>
      <td className="mono">{maskPhone(i.ownerPhone)} <CopyPhone phone={i.ownerPhone} /></td>
      <td><ReminderCell r={i.reminder} /></td>
      <td className={i.appointmentAt ? 'mono' : 'mut'}>{i.appointmentAt ? dayTime(i.appointmentAt) : 'yok'}</td>
      <td style={{ whiteSpace: 'nowrap', position: 'relative' }}>
        {canWrite && <Link className="btn sm" to={`/asilar/uygula${qs({ animal: i.animalId, plan: i.planId })}`}>Uygula</Link>}{' '}
        {canPlan && (
          <button className="btn sm" aria-label="Diğer işlemler" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>⋯</button>
        )}
        {menu && (
          <div role="menu" className="pnl" style={{ position: 'absolute', right: 8, top: '100%', zIndex: 20, display: 'flex', flexDirection: 'column', minWidth: 200, boxShadow: '0 4px 12px rgba(0,0,0,.12)' }} onMouseLeave={() => setMenu(false)}>
            <button role="menuitem" className="list-row" style={menuItem} onClick={() => act('postpone')}>Ertele...</button>
            {canWrite && <button role="menuitem" className="list-row" style={menuItem} onClick={() => act('external')}>Başka klinikte yaptırıldı...</button>}
            <button role="menuitem" className="list-row" style={menuItem} onClick={() => act('cancel')}>İptal...</button>
          </div>
        )}
      </td>
    </tr>
  )
}
const menuItem: React.CSSProperties = { border: 0, background: '#fff', textAlign: 'left', cursor: 'pointer', width: '100%' }

function CopyPhone({ phone }: { phone: string | null }) {
  const [done, setDone] = useState(false)
  if (!phone) return null
  return (
    <button
      type="button"
      className={`cb${done ? ' done' : ''}`}
      aria-label="Telefonu kopyala"
      title={`Kopyala: ${formatTrPhone(phone)}`}
      onClick={async () => {
        await navigator.clipboard.writeText(formatTrPhone(phone).replace(/\s/g, ''))
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      <Icon d={done ? 'check' : 'copy'} size={13} />
    </button>
  )
}

/** Ay görünümü: gün başına aşı sayısı */
function MonthView({ items, onPick }: { items: CalendarItem[]; onPick: (animalId: string) => void }) {
  const today = todayIstanbul()
  const [y, m] = today.split('-').map(Number)
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const startDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7 // pazartesi = 0
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const byDay = new Map<string, CalendarItem[]>()
  for (const i of items) byDay.set(i.dueDate, [...(byDay.get(i.dueDate) ?? []), i])
  const cells: (string | null)[] = [...Array(startDow).fill(null), ...Array.from({ length: days }, (_, k) => addDaysIso(first, k))]
  const monthName = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15)))
  return (
    <section className="pnl">
      <div className="ph"><h2>{monthName}</h2><span className="mut">{items.length} açık aşı</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1, background: 'var(--line-2)' }}>
        {['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map((d) => (
          <div key={d} style={{ background: 'var(--head)', padding: '4px 6px', fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{d}</div>
        ))}
        {cells.map((c, k) => {
          const list = c ? (byDay.get(c) ?? []) : []
          return (
            <div key={k} style={{ background: c === today ? '#eef3fa' : '#fff', minHeight: 72, padding: '4px 6px', fontSize: 12 }}>
              {c && (
                <>
                  <div className="mono" style={{ color: c < today ? 'var(--muted)' : 'var(--ink)' }}>{Number(c.slice(8))}</div>
                  {list.length > 0 && (
                    <div style={{ fontWeight: 600, color: c < today ? 'var(--red)' : 'var(--accent)' }} title={list.map((i) => `${i.animalName} - ${VACCINE_KIND_LABEL[i.kind]}`).join('\n')}>
                      {list.length} aşı
                    </div>
                  )}
                  {list.slice(0, 2).map((i) => (
                    <button key={i.planId} type="button" onClick={() => onPick(i.animalId)} style={{ display: 'block', border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink-2)', fontSize: 11, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                      {i.animalName} - {VACCINE_KIND_LABEL[i.kind]}
                    </button>
                  ))}
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Aşı uygula

export function VaccinatePage() {
  const [params, setParams] = useSearchParams()
  const animalId = params.get('animal')
  if (!animalId) return <AnimalPicker onPick={(id) => setParams((p) => { const n = new URLSearchParams(p); n.set('animal', id); return n })} />
  return <VaccinateForm key={animalId} animalId={animalId} visitId={params.get('visit')} planId={params.get('plan')} />
}

function AnimalPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const r = useQuery({
    queryKey: ['animals', q],
    queryFn: () => api.get<AnimalListItem[]>('/api/animals' + qs({ q })),
    enabled: q.trim().length >= 2,
  })
  return (
    <>
      <div className="page-head"><h1>Aşı uygula</h1><span className="mut">Önce hastayı seçin (ad, sahip, çip ya da telefon)</span></div>
      <section className="pnl" style={{ maxWidth: 760 }}>
        <div style={{ padding: 12 }}>
          <Field label="Hasta ara" htmlFor="va-q">
            <input id="va-q" className="inp" data-chip-input value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" placeholder="Pamuk, Yılmaz, 792..." />
          </Field>
        </div>
        {r.data?.map((a) => (
          <button key={a.id} type="button" className="list-row" style={{ ...menuItem, borderBottom: '1px solid var(--line-3)' }} onClick={() => onPick(a.id)}>
            <span><strong>{a.name}</strong> <span className="mut">- {SPECIES_LABEL[a.species]}{a.breed ? ` - ${a.breed}` : ''}{a.birthDate ? ` - ${age(a.birthDate)}` : ''}</span></span>
            <span className="mut">{a.ownerName}</span>
          </button>
        ))}
        {r.data?.length === 0 && <div className="empty">Hasta bulunamadı.</div>}
      </section>
    </>
  )
}

function VaccinateForm({ animalId, visitId, planId }: { animalId: string; visitId: string | null; planId: string | null }) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const { user } = useSession()
  const today = todayIstanbul()
  const formRef = useRef<HTMLFormElement>(null)

  const animal = useQuery({ queryKey: ['animal', animalId], queryFn: () => api.get<AnimalDetail>(`/api/animals/${animalId}`) })
  const vax = useQuery({ queryKey: ['animal-vaccines', animalId], queryFn: () => api.get<AnimalVaccinesDto>(`/api/animals/${animalId}/vaccines`) })
  const species = animal.data?.species
  const products = useQuery({
    queryKey: ['vaccine-products', species],
    queryFn: () => api.get<VaccineProduct[]>('/api/vaccine-products' + qs({ species })),
    enabled: !!species,
  })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserDto[]>('/api/users') })
  const vets = (users.data ?? []).filter((u) => u.role === 'vet' || u.role === 'admin')
  const plan = vax.data?.plans.find((p) => p.id === planId)

  const [kind, setKind] = useState<VaccineKind | ''>('')
  const [productId, setProductId] = useState('')
  const [lotNo, setLotNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const [givenAt, setGivenAt] = useState(today)
  const [givenBy, setGivenBy] = useState('')
  const [doseLabel, setDoseLabel] = useState('')
  const [nextDue, setNextDue] = useState<string | null>(null) // null = protokolden
  const [noNext, setNoNext] = useState(false)
  const [passport, setPassport] = useState(false)
  const [sideEffects, setSideEffects] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')

  useEffect(() => {
    if (plan && !kind) setKind(plan.kind)
  }, [plan, kind])
  useEffect(() => {
    if (!givenBy && vets.length) setGivenBy((vets.find((v) => v.id === user?.id) ?? vets[0]).id)
  }, [vets, givenBy, user?.id])

  const kindProducts = (products.data ?? []).filter((p) => p.kind === kind)
  const availableKinds = VACCINE_KINDS.filter((k) => (products.data ?? []).some((p) => p.kind === k))
  useEffect(() => {
    if (kindProducts.length === 1 && !productId) setProductId(kindProducts[0].id)
  }, [kindProducts, productId])
  const product = kindProducts.find((p) => p.id === productId)

  const preview = useQuery({
    queryKey: ['vaccine-preview', animalId, kind, givenAt, productId],
    queryFn: () => api.get<VaccinePreviewDto>('/api/vaccines/preview' + qs({ animalId, kind, givenAt, productId })),
    enabled: !!kind && /^\d{4}-\d{2}-\d{2}$/.test(givenAt),
  })
  const pv = preview.data
  const effectiveNext = noNext ? null : (nextDue ?? pv?.nextDueDate ?? null)

  const rabies = kind === 'rabies'
  const a = animal.data
  const back = () => nav(visitId ? `/muayene/${visitId}` : `/hayvanlar/${animalId}`)

  function validate() {
    const e: Record<string, string> = {}
    if (!kind) e.kind = 'Aşı türünü seçin.'
    if (!productId) e.product = 'Ürün seçin.'
    if (rabies && !lotNo.trim()) e.lot = 'Kuduz aşısında lot / seri no zorunlu.'
    if (rabies && !expiry) e.expiry = 'Kuduz aşısında son kullanma tarihi zorunlu.'
    if (expiry && expiry < givenAt) e.expiry = 'SKT uygulama tarihinden önce - bu aşı kullanılamaz.'
    if (!givenAt) e.givenAt = 'Uygulama tarihini girin.'
    else if (givenAt > today) e.givenAt = 'Uygulama tarihi ileri bir tarih olamaz.'
    if (!givenBy) e.givenBy = 'Uygulayan hekimi seçin.'
    if (effectiveNext && effectiveNext <= givenAt) e.next = 'Sonraki doz uygulama tarihinden sonra olmalı.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = useMutation({
    mutationFn: () =>
      api.post<VaccinateResult>('/api/vaccinations', {
        animalId,
        kind,
        productId,
        lotNo: lotNo.trim() || undefined,
        expiryDate: expiry || undefined,
        givenAt,
        givenBy,
        doseLabel: doseLabel.trim() || undefined,
        nextDueDate: noNext ? null : (nextDue ?? undefined),
        passportRecorded: passport,
        sideEffects: sideEffects.trim() || undefined,
        visitId: visitId ?? undefined,
        planId: planId ?? undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      const parts = [`${VACCINE_KIND_LABEL[kind as VaccineKind]} aşısı kaydedildi.`]
      if (r.nextDueDate) parts.push(`Sonraki doz: ${formatDateTr(r.nextDueDate)}.`)
      if (r.petvetStatus === 'missing_info') parts.push("PETVET görevi açıldı ama sahibin TCKN'si eksik.")
      else if (r.petvetStatus) parts.push('PETVET görevi açıldı.')
      toast(parts.join(' '))
      back()
    },
    onError: (e) => setErr((e as Error).message),
  })

  function submit(e?: React.FormEvent) {
    e?.preventDefault()
    setErr('')
    if (validate()) save.mutate()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        formRef.current?.requestSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (animal.isError) return <div className="alert">{(animal.error as Error).message}</div>
  if (!a) return <div className="mut">Yükleniyor...</div>
  const owner = a.owners.find((o) => o.isPrimary) ?? a.owners[0]

  return (
    <>
      <nav className="crumb" aria-label="Konum">
        <Link to="/asilar">Aşı takvimi</Link> › <Link to={`/hayvanlar/${a.id}`}>{a.name}</Link> › Aşı uygula
      </nav>
      <div className="page-head">
        <h1>Aşı uygula - {a.name}</h1>
        <span className="mut">
          {[SPECIES_LABEL[a.species], a.breed, a.birthDate ? age(a.birthDate) : null].filter(Boolean).join(' - ')}
          {owner ? ` - ${owner.fullName}` : ''}
        </span>
      </div>
      {a.status !== 'active' && <div className="alert amb">Hayvan {a.status === 'dead' ? 'ölü' : 'kayıp'} olarak işaretli. Uygulama kaydedilir ama sonraki doz planı ve hatırlatma oluşturulmaz.</div>}
      {plan && <div className="alert">Plan satırı: {VACCINE_KIND_LABEL[plan.kind]}{plan.doseLabel ? ` - ${plan.doseLabel}` : ''} - vade {formatDateTr(plan.dueDate)}</div>}

      <form ref={formRef} className="pnl" onSubmit={submit} style={{ maxWidth: 1080 }} onKeyDown={(e) => e.key === 'Escape' && back()}>
        <fieldset className="sec">
          <legend>Aşı</legend>
          <div className="g4">
            <Field label="Aşı türü *" htmlFor="v-kind" error={errors.kind}>
              <select id="v-kind" className="inp" value={kind} onChange={(e) => { setKind(e.target.value as VaccineKind); setProductId(''); setNextDue(null); setDoseLabel('') }} autoFocus>
                <option value="">Seçin...</option>
                {availableKinds.map((k) => <option key={k} value={k}>{VACCINE_KIND_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label="Ürün *" htmlFor="v-prod" error={errors.product}>
              <select id="v-prod" className="inp" value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!kind}>
                <option value="">Seçin...</option>
                {kindProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Üretici" htmlFor="v-man"><input id="v-man" className="inp" value={product?.manufacturer ?? ''} readOnly tabIndex={-1} /></Field>
            <Field label={`Lot / seri no${rabies ? ' *' : ''}`} htmlFor="v-lot" error={errors.lot}>
              <input id="v-lot" className="inp mono" value={lotNo} onChange={(e) => setLotNo(e.target.value)} list="v-lot-list" autoComplete="off" />
              <datalist id="v-lot-list">{pv?.lastLotNo && <option value={pv.lastLotNo} />}</datalist>
              {pv?.lastLotNo && !lotNo && (
                <button type="button" className="btn sm" style={{ marginTop: 4, alignSelf: 'flex-start' }} onClick={() => { setLotNo(pv.lastLotNo!); if (!expiry && pv.lastExpiryDate) setExpiry(pv.lastExpiryDate) }}>
                  Son lot: {pv.lastLotNo}
                </button>
              )}
            </Field>
            <Field label={`Son kullanma tarihi${rabies ? ' *' : ''}`} htmlFor="v-exp" error={errors.expiry ?? (expiry && expiry < givenAt ? 'SKT uygulama tarihinden önce - bu aşı kullanılamaz.' : undefined)}>
              <input id="v-exp" type="date" className={`inp${expiry && expiry < givenAt ? ' bad' : ''}`} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
            <Field label="Uygulama tarihi *" htmlFor="v-date" error={errors.givenAt}>
              <input id="v-date" type="date" className="inp" max={today} value={givenAt} onChange={(e) => { setGivenAt(e.target.value); setNextDue(null) }} required />
            </Field>
            <Field label="Uygulayan hekim *" htmlFor="v-vet" error={errors.givenBy}>
              <select id="v-vet" className="inp" value={givenBy} onChange={(e) => setGivenBy(e.target.value)}>
                {vets.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </Field>
            <Field label="Doz" htmlFor="v-dose">
              <input id="v-dose" className="inp" value={doseLabel} placeholder={pv?.doseLabel ?? ''} onChange={(e) => setDoseLabel(e.target.value)} list="v-dose-list" />
              <datalist id="v-dose-list">{pv?.doseLabel && <option value={pv.doseLabel} />}<option value="Rapel" /></datalist>
            </Field>
          </div>
        </fieldset>

        <fieldset className="sec">
          <legend>Sonraki doz ve kayıt</legend>
          <div className="g4">
            <Field label="Sonraki doz tarihi" htmlFor="v-next" error={errors.next}>
              <input id="v-next" type="date" className="inp" value={effectiveNext ?? ''} min={addDaysIso(givenAt || today, 1)} disabled={noNext || a.status !== 'active'} onChange={(e) => setNextDue(e.target.value || null)} />
              <span className="mut" style={{ fontSize: 12 }}>
                {pv?.nextDoseLabel && !noNext ? `${pv.nextDoseLabel} - ` : ''}
                {nextDue ? 'elle değiştirildi' : pv?.protocolName ? `protokol: ${pv.protocolName}` : pv && !pv.nextDueDate ? 'protokol yok' : ''}
              </span>
            </Field>
            <div className="f">
              <span className="l">&nbsp;</span>
              <label className="ck"><input type="checkbox" checked={noNext} onChange={(e) => setNoNext(e.target.checked)} />Sonraki doz planlama</label>
              {nextDue && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setNextDue(null)}>Protokole dön</button>}
            </div>
            <div className="f">
              <span className="l">Pasaport</span>
              <label className="ck"><input type="checkbox" checked={passport} onChange={(e) => setPassport(e.target.checked)} />Pasaporta işlendi</label>
              {rabies && a.passportNo && !passport && <span className="s-amb" style={{ fontSize: 12 }}>Pasaportu var ({a.passportNo}) - kuduz aşısını pasaporta işleyin.</span>}
            </div>
            <Field label="Yan etki gözlemi" htmlFor="v-se" style={{ gridColumn: 'span 4' }}>
              <input id="v-se" className="inp" value={sideEffects} onChange={(e) => setSideEffects(e.target.value)} />
            </Field>
          </div>
          {pv?.warnings.map((w) => <div key={w} className="alert amb" style={{ marginTop: 8 }}>{w}</div>)}
        </fieldset>

        <div className="form-foot">
          <span className="mut">
            {pv ? (
              <>
                {pv.doseNo}. uygulama - <strong style={{ color: 'var(--ink)' }}>{doseLabel || pv.doseLabel}</strong>
                {pv.petvetTask && <> - PETVET aşı görevi açılacak{owner && !owner.tcknLast4 && <span className="s-amb"> (sahip TCKN'si eksik -> "eksik bilgi")</span>}</>}
              </>
            ) : (
              'Aşı türünü seçin.'
            )}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {err && <span className="err" role="alert">{err}</span>}
            <button type="button" className="btn" onClick={back}>Vazgeç</button>
            <button className="btn p" disabled={save.isPending}>{save.isPending ? 'Kaydediliyor...' : 'Kaydet'} <span className="k">Ctrl+S</span></button>
          </div>
        </div>
      </form>
    </>
  )
}

// ---------------------------------------------------------------- Aşılar sekmesi

export function AnimalVaccinesTab({ animalId }: { animalId?: string }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [action, setAction] = useState<PlanAction | null>(null)
  const [protoOpen, setProtoOpen] = useState(false)
  const [del, setDel] = useState<{ id: string; title: string } | null>(null)
  const q = useQuery({
    queryKey: ['animal-vaccines', animalId],
    queryFn: () => api.get<AnimalVaccinesDto>(`/api/animals/${animalId}/vaccines`),
    enabled: !!animalId,
  })
  const recalc = useMutation({
    mutationFn: () => api.post<{ plans: unknown[] }>(`/api/animals/${animalId}/vaccine-plan/recalculate`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast(`Plan yeniden hesaplandı (${r.plans.length} açık satır).`)
    },
    onError: (e) => toast((e as Error).message, 'err'),
  })
  if (!animalId) return null
  const d = q.data
  const canWrite = can('vaccinations.write')
  const canPlan = canWrite || can('messages.send')
  const open = d?.plans.filter((p) => p.status === 'planned' || p.status === 'postponed') ?? []
  const closed = d?.plans.filter((p) => p.status !== 'planned' && p.status !== 'postponed') ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn p" to={`/asilar/uygula?animal=${animalId}`}>Aşı uygula</Link>
          <button className="btn" onClick={() => setProtoOpen(true)}>Protokol değiştir</button>
          <button className="btn" disabled={recalc.isPending} onClick={() => recalc.mutate()}>Planı yeniden hesapla</button>
        </div>
      )}
      {q.isError && <div className="alert">{(q.error as Error).message}</div>}

      <section className="pnl">
        <div className="ph"><h2>Planlanan / yaklaşan</h2></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Vade</th><th>Kalan</th><th>Aşı</th><th>Doz</th><th>Durum</th><th>Hatırlatma</th><th></th></tr></thead>
            <tbody>
              {open.map((p) => {
                const dl = delayText(p.daysLeft)
                const title = `${VACCINE_KIND_LABEL[p.kind]}${p.doseLabel ? ' ' + p.doseLabel : ''}`
                return (
                  <tr key={p.id}>
                    <td className="mono">{formatDateTr(p.dueDate)}</td>
                    <td className="mono" style={{ color: dl.color }}>{p.daysLeft < 0 ? `${dl.text} gecikti` : dl.text}</td>
                    <td>{VACCINE_KIND_LABEL[p.kind]}</td>
                    <td>{p.doseLabel ?? '-'}</td>
                    <td><PlanStateCell s={p.status} />{p.reason && <span className="mut"> - {p.reason}</span>}</td>
                    <td><ReminderCell r={p.reminder} /></td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {canWrite && <Link className="btn sm" to={`/asilar/uygula${qs({ animal: animalId, plan: p.id })}`}>Uygula</Link>}{' '}
                      {canPlan && <button className="btn sm" onClick={() => setAction({ kind: 'postpone', planId: p.id, title, dueDate: p.dueDate })}>Ertele</button>}{' '}
                      {canWrite && <button className="btn sm" onClick={() => setAction({ kind: 'external', planId: p.id, title, dueDate: p.dueDate })}>Başka klinikte</button>}{' '}
                      {canPlan && <button className="btn sm" onClick={() => setAction({ kind: 'cancel', planId: p.id, title, dueDate: p.dueDate })}>İptal</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {d && open.length === 0 && <div className="empty">Planlanmış aşı yok.{canWrite && ' "Planı yeniden hesapla" ya da "Protokol değiştir" ile plan oluşturabilirsiniz.'}</div>}
        </div>
        {closed.length > 0 && (
          <details style={{ padding: '6px 12px', fontSize: 13 }}>
            <summary className="mut" style={{ cursor: 'pointer' }}>Kapanmış plan satırları ({closed.length})</summary>
            <table>
              <tbody>
                {closed.map((p) => (
                  <tr key={p.id}><td className="mono">{formatDateTr(p.dueDate)}</td><td>{VACCINE_KIND_LABEL[p.kind]} {p.doseLabel ?? ''}</td><td><PlanStateCell s={p.status} /></td><td className="mut">{p.reason ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="pnl">
        <div className="ph"><h2>Uygulananlar</h2></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Tarih</th><th>Aşı</th><th>Ürün</th><th>Lot</th><th>SKT</th><th>Hekim</th><th>Pasaport</th><th>PETVET</th><th></th></tr></thead>
            <tbody>
              {d?.vaccinations.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{formatDateTr(v.givenAt)}</td>
                  <td>{VACCINE_KIND_LABEL[v.kind]}{v.doseLabel ? ` - ${v.doseLabel}` : ''}{v.sideEffects && <div className="s-amb" style={{ fontSize: 12 }}>Yan etki: {v.sideEffects}</div>}</td>
                  <td>{v.productName ?? '-'}{v.external && <div className="mut" style={{ fontSize: 12 }}>Dış kayıt{v.externalClinic ? ` - ${v.externalClinic}` : ''}</div>}</td>
                  <td className="mono">{v.lotNo ?? '-'}</td>
                  <td className="mono">{v.expiryDate ? formatDateTr(v.expiryDate) : '-'}</td>
                  <td>{v.givenByName ?? '-'}</td>
                  <td>{v.passportRecorded ? <span className="st s-ok">İşlendi</span> : <span className="mut">-</span>}</td>
                  <td>
                    {v.petvetTaskId ? (
                      <Link to={`/petvet/${v.petvetTaskId}`} className={`st ${v.petvetStatus === 'done' ? 's-ok' : v.petvetStatus === 'cancelled' ? 's-gry' : 's-amb'}`}>
                        {v.petvetStatus === 'done' ? 'Girildi' : v.petvetStatus === 'cancelled' ? 'İptal' : v.petvetStatus === 'missing_info' ? 'Eksik bilgi' : 'Bekliyor'}
                      </Link>
                    ) : (
                      <span className="mut">-</span>
                    )}
                  </td>
                  <td>{canWrite && <button className="btn sm" onClick={() => setDel({ id: v.id, title: `${formatDateTr(v.givenAt)} ${VACCINE_KIND_LABEL[v.kind]}` })}>Sil</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.vaccinations.length === 0 && <div className="empty">Kayıtlı aşı yok.</div>}
        </div>
      </section>

      {action && <PlanActionDialog action={action} onClose={() => setAction(null)} />}
      {protoOpen && d && <ProtocolDialog animalId={animalId} data={d} onClose={() => setProtoOpen(false)} />}
      {del && <DeleteVaccinationDialog {...del} onClose={() => setDel(null)} />}
    </div>
  )
}

function ProtocolDialog({ animalId, data, onClose }: { animalId: string; data: AnimalVaccinesDto; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const protocols = useQuery({
    queryKey: ['vaccine-protocols', data.species],
    queryFn: () => api.get<VaccineProtocol[]>('/api/vaccine-protocols' + qs({ species: data.species })),
  })
  const kinds = VACCINE_KINDS.filter((k) => protocols.data?.some((p) => p.kind === k))
  const [kind, setKind] = useState<VaccineKind | ''>('')
  const [pid, setPid] = useState('')
  const [err, setErr] = useState('')
  const list = protocols.data?.filter((p) => p.kind === kind) ?? []
  const chosen = list.find((p) => p.id === pid)
  const m = useMutation({
    mutationFn: () => api.post<{ dueDate: string | null }>(`/api/animals/${animalId}/vaccine-protocol`, { kind, protocolId: pid }),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast(r.dueDate ? `Protokol değişti. Sıradaki vade: ${formatDateTr(r.dueDate)}.` : 'Protokol değişti.')
      onClose()
    },
    onError: (e) => setErr((e as Error).message),
  })
  return (
    <Dialog title="Protokol değiştir" onClose={onClose} width={520}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate() }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Aşı türü *" htmlFor="pd-k">
          <select id="pd-k" className="inp" value={kind} onChange={(e) => { const k = e.target.value as VaccineKind; setKind(k); setPid(data.protocols[k]?.protocolId ?? '') }} required autoFocus>
            <option value="">Seçin...</option>
            {kinds.map((k) => <option key={k} value={k}>{VACCINE_KIND_LABEL[k]}{data.protocols[k] ? ` - şu an: ${data.protocols[k]!.name}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Protokol *" htmlFor="pd-p">
          <select id="pd-p" className="inp" value={pid} onChange={(e) => setPid(e.target.value)} required disabled={!kind}>
            <option value="">Seçin...</option>
            {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {chosen && <StepsLine steps={chosen.steps} />}
        <span className="mut">Bu türdeki açık plan satırları iptal edilir ve plan seçilen protokole göre yeniden kurulur.</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {err && <span className="err" role="alert">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn p" disabled={m.isPending || !pid}>Uygula</button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteVaccinationDialog({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const m = useMutation({
    mutationFn: () => api.post(`/api/vaccinations/${id}/delete`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Aşı kaydı silindi; bağlı PETVET görevi iptal edildi.')
      onClose()
    },
    onError: (e) => setErr((e as Error).message),
  })
  return (
    <Dialog title={`Hatalı kaydı sil - ${title}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate() }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Neden *" htmlFor="dv-r"><input id="dv-r" className="inp" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} autoFocus /></Field>
        <span className="mut">Kayıt yumuşak silinir (geri izlenebilir). Açık PETVET görevi iptal olur, plan yeniden hesaplanır.</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {err && <span className="err" role="alert">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn p" disabled={m.isPending}>Sil</button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Bugün ekranı: geciken aşılar

export function TodayVaccinesPanel() {
  const can = useCan()
  const q = useQuery({
    queryKey: ['vaccine-calendar', 'overdue', 'today-panel'],
    queryFn: () => api.get<CalendarDto>('/api/vaccine-calendar' + qs({ filter: 'overdue', pageSize: 8 })),
    enabled: can('animals.read'),
    refetchInterval: 60_000,
  })
  if (!can('animals.read')) return null
  const d = q.data
  return (
    <section className="pnl">
      <div className="ph"><h2>Geciken aşılar - aranacak</h2><Link to="/asilar?f=overdue" style={{ fontSize: 12 }}>Tümü{d ? ` (${d.counts.overdue})` : ''}</Link></div>
      {d?.items.length === 0 && <div className="empty">Son 30 günde geciken aşı yok.</div>}
      {q.isError && <div className="alert" style={{ margin: 8 }}>{(q.error as Error).message}</div>}
      {d?.items.map((i) => (
        <div key={i.planId} className="list-row">
          <span style={{ minWidth: 0 }}>
            <Link to={`/hayvanlar/${i.animalId}`}><strong>{i.animalName}</strong></Link> - {VACCINE_KIND_LABEL[i.kind]}{i.doseLabel ? ` ${i.doseLabel}` : ''}
            <span className="mut"> - {i.ownerName ?? 'sahip yok'}</span>
            {i.ownerPhone && <span className="mono mut"> - {maskPhone(i.ownerPhone)}</span>} <CopyPhone phone={i.ownerPhone} />
            {i.reminder?.state === 'failed' && <span className="s-red"> - mesaj gitmedi</span>}
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="mono" style={{ color: delayText(i.daysLeft).color }}>{-i.daysLeft} gün</span>
            {can('vaccinations.write') && <Link className="btn sm" to={`/asilar/uygula${qs({ animal: i.animalId, plan: i.planId })}`}>Uygula</Link>}
          </span>
        </div>
      ))}
    </section>
  )
}

// ---------------------------------------------------------------- Ayarlar > Aşılar ve ürünler

function StepsLine({ steps }: { steps: ProtocolStep[] }) {
  return (
    <span style={{ fontSize: 12 }}>
      {steps.map((s, k) => (
        <span key={k}>
          {k > 0 && ' -> '}
          <strong>{s.label}</strong>
          <span className="mut">
            {s.minAgeWeeks != null ? ` (>=${s.minAgeWeeks} hf)` : ''}
            {s.afterPrevWeeks != null ? ` (+${s.afterPrevWeeks} hf)` : ''}
            {s.thenEveryDays != null ? ` (her ${s.thenEveryDays} günde)` : ''}
          </span>
        </span>
      ))}
    </span>
  )
}

const emptyProduct = { name: '', manufacturer: '', kind: 'rabies' as VaccineKind, species: [] as Species[], immunityDays: '' as string, active: true, notes: '' }
const SETTINGS_SPECIES: Species[] = ['cat', 'dog', 'ferret', 'rabbit', 'bird', 'other']

export function VaccineSettingsPage() {
  const can = useCan()
  const edit = can('settings.manage')
  const products = useQuery({ queryKey: ['vaccine-products', 'all'], queryFn: () => api.get<VaccineProduct[]>('/api/vaccine-products?all=1') })
  const protocols = useQuery({ queryKey: ['vaccine-protocols', 'all'], queryFn: () => api.get<VaccineProtocol[]>('/api/vaccine-protocols?all=1') })
  const [prod, setProd] = useState<VaccineProduct | 'new' | null>(null)
  const [proto, setProto] = useState<VaccineProtocol | 'new' | null>(null)

  return (
    <SettingsLayout>
      <div className="page-head"><h1>Aşılar ve ürünler</h1><span className="mut">Aşı ürünleri ve tür bazında aşı protokolleri</span></div>
      <div className="alert amb">Uygulamayla gelen ürün ve protokoller <strong>örnektir</strong>; yaş ve aralıkları hekim onayıyla düzenleyin.</div>

      <section className="pnl">
        <div className="ph"><h2>Aşı ürünleri</h2>{edit && <button className="btn sm" onClick={() => setProd('new')}>Ürün ekle</button>}</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Ürün</th><th>Üretici</th><th>Aşı türü</th><th>Türler</th><th>Bağışıklık</th><th>Durum</th><th></th></tr></thead>
            <tbody>
              {products.data?.map((p) => (
                <tr key={p.id} className={edit ? 'click' : undefined} onDoubleClick={() => edit && setProd(p)}>
                  <td><strong>{p.name}</strong>{p.notes && <span className="mut"> - {p.notes}</span>}</td>
                  <td>{p.manufacturer ?? '-'}</td>
                  <td>{VACCINE_KIND_LABEL[p.kind]}</td>
                  <td>{p.species.length ? p.species.map((s) => SPECIES_LABEL[s]).join(', ') : 'Tümü'}</td>
                  <td className="mono">{p.immunityDays ? `${p.immunityDays} gün` : '-'}</td>
                  <td>{p.active ? <span className="st s-ok">Etkin</span> : <span className="st s-gry">Kullanım dışı</span>}</td>
                  <td>{edit && <button className="btn sm" onClick={() => setProd(p)}>Düzenle</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {products.data?.length === 0 && <div className="empty">Ürün yok.</div>}
        </div>
      </section>

      <section className="pnl">
        <div className="ph"><h2>Aşı protokolleri</h2>{edit && <button className="btn sm" onClick={() => setProto('new')}>Protokol ekle</button>}</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Tür</th><th>Aşı</th><th>Protokol</th><th>Adımlar</th><th>Durum</th><th></th></tr></thead>
            <tbody>
              {protocols.data?.map((p) => (
                <tr key={p.id}>
                  <td>{SPECIES_LABEL[p.species]}</td>
                  <td>{VACCINE_KIND_LABEL[p.kind]}</td>
                  <td><strong>{p.name}</strong></td>
                  <td><StepsLine steps={p.steps} /></td>
                  <td>{p.active ? <span className="st s-ok">Etkin</span> : <span className="st s-gry">Kullanım dışı</span>}</td>
                  <td>{edit && <button className="btn sm" onClick={() => setProto(p)}>Düzenle</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tfoot"><span>Bir türde birden çok etkin protokol varsa varsayılan, ilk eklenendir; hayvan bazında "Protokol değiştir" ile seçilir.</span></div>
      </section>

      {prod && <ProductDialog product={prod === 'new' ? null : prod} onClose={() => setProd(null)} />}
      {proto && <ProtocolEditDialog protocol={proto === 'new' ? null : proto} onClose={() => setProto(null)} />}
    </SettingsLayout>
  )
}

function ProductDialog({ product, onClose }: { product: VaccineProduct | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState(
    product
      ? { name: product.name, manufacturer: product.manufacturer ?? '', kind: product.kind, species: product.species, immunityDays: product.immunityDays ? String(product.immunityDays) : '', active: product.active, notes: product.notes ?? '' }
      : emptyProduct,
  )
  const [err, setErr] = useState('')
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, manufacturer: f.manufacturer || undefined, notes: f.notes || undefined, immunityDays: f.immunityDays ? Number(f.immunityDays) : null }
      return product ? api.put(`/api/vaccine-products/${product.id}`, body) : api.post('/api/vaccine-products', body)
    },
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Ürün kaydedildi.')
      onClose()
    },
    onError: (e) => setErr((e as Error).message),
  })
  return (
    <Dialog title={product ? `Ürün - ${product.name}` : 'Yeni ürün'} onClose={onClose} width={560}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate() }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Ürün adı *" htmlFor="pr-n"><input id="pr-n" className="inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
          <Field label="Üretici" htmlFor="pr-m"><input id="pr-m" className="inp" value={f.manufacturer} onChange={(e) => setF({ ...f, manufacturer: e.target.value })} /></Field>
          <Field label="Aşı türü *" htmlFor="pr-k">
            <select id="pr-k" className="inp" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as VaccineKind })}>
              {VACCINE_KINDS.map((k) => <option key={k} value={k}>{VACCINE_KIND_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Varsayılan bağışıklık (gün)" htmlFor="pr-i"><input id="pr-i" type="number" min={1} className="inp mono" value={f.immunityDays} onChange={(e) => setF({ ...f, immunityDays: e.target.value })} /></Field>
        </div>
        <div className="f">
          <span className="l">Türler (boş = tümü)</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {SETTINGS_SPECIES.map((s) => (
              <label key={s} className="ck">
                <input type="checkbox" checked={f.species.includes(s)} onChange={(e) => setF({ ...f, species: e.target.checked ? [...f.species, s] : f.species.filter((x) => x !== s) })} />
                {SPECIES_LABEL[s]}
              </label>
            ))}
          </div>
        </div>
        <Field label="Not" htmlFor="pr-no"><input id="pr-no" className="inp" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <label className="ck"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Etkin (aşı uygulama listesinde görünür)</label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {err && <span className="err" role="alert">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn p" disabled={m.isPending}>Kaydet</button>
        </div>
      </form>
    </Dialog>
  )
}

type StepDraft = { label: string; minAgeWeeks: string; afterPrevWeeks: string; thenEveryDays: string }
const toDraft = (s: ProtocolStep): StepDraft => ({
  label: s.label,
  minAgeWeeks: s.minAgeWeeks != null ? String(s.minAgeWeeks) : '',
  afterPrevWeeks: s.afterPrevWeeks != null ? String(s.afterPrevWeeks) : '',
  thenEveryDays: s.thenEveryDays != null ? String(s.thenEveryDays) : '',
})
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

function ProtocolEditDialog({ protocol, onClose }: { protocol: VaccineProtocol | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [species, setSpecies] = useState<Species>(protocol?.species ?? 'dog')
  const [kind, setKind] = useState<VaccineKind>(protocol?.kind ?? 'combo')
  const [name, setName] = useState(protocol?.name ?? '')
  const [active, setActive] = useState(protocol?.active ?? true)
  const [steps, setSteps] = useState<StepDraft[]>(protocol ? protocol.steps.map(toDraft) : [{ label: '1. doz', minAgeWeeks: '8', afterPrevWeeks: '', thenEveryDays: '' }])
  const [err, setErr] = useState('')
  const parsed: ProtocolStep[] = useMemo(
    () => steps.map((s) => ({ label: s.label.trim(), minAgeWeeks: num(s.minAgeWeeks), afterPrevWeeks: num(s.afterPrevWeeks), thenEveryDays: num(s.thenEveryDays) })),
    [steps],
  )
  const m = useMutation({
    mutationFn: () => {
      const body = { species, kind, name, active, steps: parsed }
      return protocol ? api.put(`/api/vaccine-protocols/${protocol.id}`, body) : api.post('/api/vaccine-protocols', body)
    },
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Protokol kaydedildi.')
      onClose()
    },
    onError: (e) => setErr((e as Error).message),
  })
  const upd = (k: number, patch: Partial<StepDraft>) => setSteps((x) => x.map((s, i) => (i === k ? { ...s, ...patch } : s)))
  return (
    <Dialog title={protocol ? `Protokol - ${protocol.name}` : 'Yeni protokol'} onClose={onClose} width={720}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const v = validateSteps(parsed)
          if (v) return setErr(v)
          setErr('')
          m.mutate()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 10 }}>
          <Field label="Tür *" htmlFor="pe-s">
            <select id="pe-s" className="inp" value={species} onChange={(e) => setSpecies(e.target.value as Species)}>
              {SETTINGS_SPECIES.map((s) => <option key={s} value={s}>{SPECIES_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Aşı türü *" htmlFor="pe-k">
            <select id="pe-k" className="inp" value={kind} onChange={(e) => setKind(e.target.value as VaccineKind)}>
              {VACCINE_KINDS.map((k) => <option key={k} value={k}>{VACCINE_KIND_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Protokol adı *" htmlFor="pe-n"><input id="pe-n" className="inp" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        </div>
        <table>
          <thead><tr><th>#</th><th>Adım adı</th><th>En küçük yaş (hf)</th><th>Önceki dozdan sonra (hf)</th><th>Tekrar (gün, son adım)</th><th></th></tr></thead>
          <tbody>
            {steps.map((s, k) => (
              <tr key={k}>
                <td className="mono">{k + 1}</td>
                <td><input className="inp" aria-label={`${k + 1}. adım adı`} value={s.label} onChange={(e) => upd(k, { label: e.target.value })} style={{ width: '100%' }} /></td>
                <td><input className="inp mono" type="number" min={0} aria-label="En küçük yaş" value={s.minAgeWeeks} onChange={(e) => upd(k, { minAgeWeeks: e.target.value })} style={{ width: 80 }} /></td>
                <td><input className="inp mono" type="number" min={1} aria-label="Önceki dozdan sonra" value={s.afterPrevWeeks} disabled={k === 0} onChange={(e) => upd(k, { afterPrevWeeks: e.target.value })} style={{ width: 80 }} /></td>
                <td><input className="inp mono" type="number" min={1} aria-label="Tekrar" value={s.thenEveryDays} disabled={k !== steps.length - 1} onChange={(e) => upd(k, { thenEveryDays: e.target.value })} style={{ width: 80 }} /></td>
                <td>{steps.length > 1 && <button type="button" className="btn sm" aria-label={`${k + 1}. adımı sil`} onClick={() => setSteps((x) => x.filter((_, i) => i !== k))}>Sil</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn sm" onClick={() => setSteps((x) => [...x.map((s, i) => (i === x.length - 1 ? { ...s, thenEveryDays: '' } : s)), { label: `${x.length + 1}. doz`, minAgeWeeks: '', afterPrevWeeks: '3', thenEveryDays: '' }])}>Adım ekle</button>
          <label className="ck"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Etkin</label>
          <span className="mut" style={{ fontSize: 12 }}>Ör. köpek karma: 1. doz >=6 hf -> +3 hf -> +3 hf -> yıllık rapel (+52 hf, her 365 günde).</span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {err && <span className="err" role="alert">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn p" disabled={m.isPending}>Kaydet</button>
        </div>
      </form>
    </Dialog>
  )
}
