// Modül B — S-20 Sahip listesi, S-21 Sahip formu, S-22 Sahip detayı (+ birleştirme)
// Bu dosya Animals.tsx'in de kullandığı küçük yardımcıları (Modal, Tabs, DropMenu, OwnerPicker) dışa aktarır.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError, qs } from '../api'
import { useCan } from '../session'
import { ChipNo, Field, age, useToast } from '../ui'
import { Attachments } from '../components/Attachments'
import { formatTrPhone, isValidTckn, normalizeTrMobile } from '@shared/identity'
import { formatDateTr } from '@shared/petvet'
import { SEX_LABEL, SPECIES_LABEL, type OwnerListItem } from '@shared/api-types'
import {
  ANIMAL_STATUS_LABEL,
  BEHAVIOR_LABEL,
  CHANNEL_LABEL,
  CITIES,
  CONSENT_LABEL,
  DEFAULT_OWNER_TAGS,
  KVKK_METHOD_LABEL,
  MERGE_FIELDS,
  MERGE_FIELD_LABEL,
  type Behavior,
  type Channel,
  type HistoryRow,
  type KvkkMethod,
  type MergeField,
  type OwnerDetail,
  type OwnerListResult,
} from '@shared/owners'

/* ================= Ortak küçük yardımcılar (B modülü) ================= */

export function fmtDT(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
}

export const ACTION_LABEL: Record<string, string> = {
  create: 'Oluşturma',
  update: 'Değişiklik',
  delete: 'Silme',
  view_sensitive: 'Hassas görüntüleme',
  export: 'Dışa aktarma',
  petvet_done: 'PETVET girildi',
}

/** Ctrl+S kaydet, Esc kapat */
export function useFormKeys(onSave: () => void, onEsc?: () => void) {
  const ref = useRef({ onSave, onEsc })
  ref.current = { onSave, onEsc }
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        ref.current.onSave()
      } else if (e.key === 'Escape' && ref.current.onEsc) {
        ref.current.onEsc()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
}

export function Modal({ title, onClose, children, footer, width = 560 }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(29,28,26,.35)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px', zIndex: 40, overflowY: 'auto' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="pnl" style={{ width, maxWidth: '100%', boxShadow: '0 10px 30px rgba(29,28,26,.25)' }}>
        <div className="ph">
          <h2>{title}</h2>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Kapat">Kapat</button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
        {footer && <div className="form-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string; hidden?: boolean }[]; value: string; onChange(k: string): void }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 2, padding: '6px 8px 0', background: 'var(--side)', border: '1px solid var(--line)', borderTop: 0, overflowX: 'auto' }}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => {
          const on = t.key === value
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.key)}
              style={{
                font: 'inherit',
                fontSize: 13,
                height: 34,
                padding: '0 14px',
                border: '1px solid transparent',
                borderBottom: 0,
                borderRadius: '3px 3px 0 0',
                background: on ? '#fff' : 'transparent',
                borderColor: on ? 'var(--line)' : 'transparent',
                color: on ? 'var(--ink)' : '#3d3a35',
                fontWeight: on ? 600 : 400,
                cursor: 'pointer',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          )
        })}
    </div>
  )
}

export interface MenuItem {
  label: string
  onClick(): void
  hidden?: boolean
  disabled?: boolean
  danger?: boolean
}
export function DropMenu({ label, items, primary }: { label: string; items: MenuItem[]; primary?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      window.removeEventListener('keydown', k)
    }
  }, [open])
  const visible = items.filter((i) => !i.hidden)
  if (!visible.length) return null
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`btn${primary ? ' p' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label} ▾
      </button>
      {open && (
        <div role="menu" className="pnl" style={{ position: 'absolute', right: 0, top: 34, zIndex: 30, minWidth: 220, boxShadow: '0 6px 20px rgba(29,28,26,.15)', padding: '4px 0' }}>
          {visible.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              disabled={i.disabled}
              onClick={() => {
                setOpen(false)
                i.onClick()
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 0,
                background: 'transparent',
                padding: '7px 12px',
                font: 'inherit',
                cursor: i.disabled ? 'default' : 'pointer',
                color: i.disabled ? 'var(--muted)' : i.danger ? 'var(--red)' : 'var(--ink)',
                opacity: i.disabled ? 0.6 : 1,
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Sahip arama + seçim (hayvan formu, devir, birleştirme) */
export function OwnerPicker({
  value,
  onChange,
  exclude,
  label = 'Sahip ara: ad, telefon, TCKN',
  id = 'owner-q',
}: {
  value: { id: string; label: string } | null
  onChange(v: { id: string; label: string; tcknLast4: string | null; kvkk: boolean } | null): void
  exclude?: string[]
  label?: string
  id?: string
}) {
  const [q, setQ] = useState('')
  const search = useQuery({
    queryKey: ['owners', 'pick', q],
    queryFn: () => api.get<OwnerListItem[]>('/api/owners' + qs({ q })),
    enabled: q.trim().length >= 2 && !value,
  })
  if (value) {
    return (
      <div style={{ border: '1px solid var(--accent)', background: '#eef3fa', borderRadius: 2, padding: '6px 10px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <strong style={{ flex: 1 }}>{value.label}</strong>
        <button type="button" className="btn sm" onClick={() => onChange(null)}>Değiştir</button>
      </div>
    )
  }
  const rows = (search.data ?? []).filter((x) => !exclude?.includes(x.id))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Field label={label} htmlFor={id}>
        <input id={id} className="inp" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </Field>
      {rows.length > 0 && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 2, maxHeight: 220, overflowY: 'auto' }}>
          {rows.map((x) => (
            <button
              key={x.id}
              type="button"
              className="list-row"
              style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line-3)', background: '#fff', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onChange({ id: x.id, label: `${x.fullName} · ${formatTrPhone(x.phone)}`, tcknLast4: x.tcknLast4, kvkk: !!x.kvkkNoticeAt })}
            >
              <span>
                <strong>{x.fullName}</strong> <span className="mut">· {formatTrPhone(x.phone)} · {[x.city, x.district].filter(Boolean).join(' / ')}</span>
              </span>
              <span className="mut">{x.tcknLast4 ? `TCKN ****${x.tcknLast4} · ` : ''}{x.animalCount} hayvan</span>
            </button>
          ))}
        </div>
      )}
      {search.data && rows.length === 0 && <span className="mut">Sahip bulunamadı.</span>}
    </div>
  )
}

export function HistoryTable({ rows }: { rows: HistoryRow[] | undefined }) {
  return (
    <section className="pnl">
      <div className="ph"><h2>Değişiklik geçmişi</h2></div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>İşlem</th><th>Açıklama</th><th>Kullanıcı</th></tr></thead>
          <tbody>
            {rows?.map((h) => (
              <tr key={h.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDT(h.at)}</td>
                <td>{ACTION_LABEL[h.action] ?? h.action}</td>
                <td>{h.summary}</td>
                <td>{h.userName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows?.length === 0 && <div className="empty">Kayıt yok.</div>}
      </div>
    </section>
  )
}

function useOwnerTags() {
  const q = useQuery({
    queryKey: ['dictionaries', 'owner_tag'],
    queryFn: async () => {
      try {
        const r = await api.get<({ value?: string; label?: string; name?: string } | string)[]>('/api/dictionaries/owner_tag')
        const list = r.map((x) => (typeof x === 'string' ? x : (x.label ?? x.value ?? x.name ?? ''))).filter(Boolean)
        return list.length ? list : DEFAULT_OWNER_TAGS
      } catch {
        return DEFAULT_OWNER_TAGS
      }
    },
    staleTime: 5 * 60_000,
  })
  return q.data ?? DEFAULT_OWNER_TAGS
}

/* ================= S-20 Sahip listesi ================= */

const PAGE = 50

export function OwnersPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const can = useCan()
  const toast = useToast()
  const tags = useOwnerTags()
  const f = {
    q: params.get('q') ?? '',
    city: params.get('il') ?? '',
    district: params.get('ilce') ?? '',
    active: params.get('aktif') === '1' ? '1' : undefined,
    marketing: params.get('pazarlama') === '1' ? '1' : undefined,
    inactive12: params.get('gelmeyen') === '1' ? '1' : undefined,
    tag: params.get('etiket') ?? '',
  }
  const offset = Number(params.get('s') ?? 0) || 0
  const [text, setText] = useState(f.q)
  const [district, setDistrict] = useState(f.district)
  useEffect(() => setText(f.q), [f.q])

  const query = qs({ ...f, offset })
  const list = useQuery({ queryKey: ['owners', 'list', query], queryFn: () => api.get<OwnerListResult>('/api/owners/list' + query) })

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v)
    else p.delete(k)
    if (k !== 's') p.delete('s')
    setParams(p)
  }

  async function exportCsv() {
    try {
      const url = await api.blobUrl('/api/owners/export.csv' + qs({ ...f }))
      const a = document.createElement('a')
      a.href = url
      a.download = `sahipler-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      toast('CSV dosyası indirildi. Dışa aktarma denetim kaydına yazıldı.')
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  const total = list.data?.total ?? 0
  const filtered = !!(f.q || f.city || f.district || f.active || f.marketing || f.inactive12 || f.tag)
  return (
    <>
      <div className="page-head">
        <h1>Sahipler</h1>
        {list.data && <span className="mut">{total} kayıt</span>}
        <div className="right">
          {can('owners.export') && <button className="btn" onClick={exportCsv}>CSV dışa aktar</button>}
          {can('owners.write') && <Link to="/sahipler/yeni" className="btn p">Yeni sahip</Link>}
        </div>
      </div>
      <form
        className="pnl"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px' }}
        onSubmit={(e) => {
          e.preventDefault()
          const p = new URLSearchParams(params)
          for (const [k, v] of [['q', text.trim()], ['ilce', district.trim()]] as const) {
            if (v) p.set(k, v)
            else p.delete(k)
          }
          p.delete('s')
          setParams(p)
        }}
      >
        <input className="inp" style={{ width: 260 }} placeholder="Ad, telefon, TCKN, e-posta" aria-label="Ara" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="inp" style={{ width: 150 }} aria-label="İl" value={f.city} onChange={(e) => setParam('il', e.target.value || null)}>
          <option value="">Tüm iller</option>
          {CITIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <input className="inp" style={{ width: 130 }} placeholder="İlçe" aria-label="İlçe" value={district} onChange={(e) => setDistrict(e.target.value)} />
        <select className="inp" style={{ width: 140 }} aria-label="Etiket" value={f.tag} onChange={(e) => setParam('etiket', e.target.value || null)}>
          <option value="">Tüm etiketler</option>
          {tags.map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="btn">Ara</button>
        <label className="ck"><input type="checkbox" checked={!!f.active} onChange={(e) => setParam('aktif', e.target.checked ? '1' : null)} />Aktif hayvanı olanlar</label>
        <label className="ck"><input type="checkbox" checked={!!f.marketing} onChange={(e) => setParam('pazarlama', e.target.checked ? '1' : null)} />Ticari ileti izni olanlar</label>
        <label className="ck"><input type="checkbox" checked={!!f.inactive12} onChange={(e) => setParam('gelmeyen', e.target.checked ? '1' : null)} />Son 12 ayda gelmeyenler</label>
        {filtered && <button type="button" className="btn sm" onClick={() => setParams(new URLSearchParams())}>Filtreleri temizle</button>}
      </form>
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Ad soyad</th><th>Telefon</th><th>İl / ilçe</th><th>Hayvan</th><th>Son ziyaret</th><th>KVKK</th><th>Etiketler</th></tr>
            </thead>
            <tbody>
              {list.data?.items.map((o) => (
                <tr key={o.id} className="click" onClick={() => nav(`/sahipler/${o.id}`)} onDoubleClick={() => nav(`/sahipler/${o.id}`)}>
                  <td><strong>{o.fullName}</strong></td>
                  <td className="mono">{formatTrPhone(o.phone)}</td>
                  <td>{[o.city, o.district].filter(Boolean).join(' / ')}</td>
                  <td className="mono">{o.animalCount}</td>
                  <td className="mono">{formatDateTr(o.lastVisit) || <span className="mut">—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {o.kvkkNoticeAt ? <span className="st s-ok">Aydınlatma</span> : <span className="st s-red">Aydınlatma yok</span>}{' '}
                    <span className={`st ${o.marketingConsent ? 's-ok' : 's-gry'}`}>{o.marketingConsent ? 'Ticari ✓' : 'Ticari ✗'}</span>
                  </td>
                  <td>{o.tags.map((t) => <span key={t} className="tag s-gry" style={{ marginRight: 4 }}>{t}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.isLoading && <div className="empty">Yükleniyor…</div>}
          {list.data?.items.length === 0 && (
            <div className="empty">
              {filtered ? 'Bu filtrelerle kayıt bulunamadı.' : <>Henüz sahip kaydı yok. Çip okutarak ya da "Yeni sahip" ile başlayın.{' '}{can('owners.write') && <Link to="/sahipler/yeni">Yeni sahip</Link>}</>}
            </div>
          )}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
        </div>
        {total > PAGE && (
          <div className="tfoot">
            <span>{offset + 1}–{Math.min(offset + PAGE, total)} / {total}</span>
            <button className="btn sm" disabled={offset === 0} onClick={() => setParam('s', String(Math.max(0, offset - PAGE)) || null)}>Önceki</button>
            <button className="btn sm" disabled={offset + PAGE >= total} onClick={() => setParam('s', String(offset + PAGE))}>Sonraki</button>
          </div>
        )}
      </section>
    </>
  )
}

/* ================= S-21 Sahip formu ================= */

interface OwnerFormState {
  firstName: string
  lastName: string
  tckn: string
  clearTckn: boolean
  isForeign: boolean
  foreignDocNo: string
  birthDate: string
  phone: string
  phone2: string
  email: string
  city: string
  district: string
  address: string
  emergencyName: string
  emergencyPhone: string
  preferredChannel: Channel
  tags: string[]
  notes: string
  kvkkNotice: boolean
  kvkkMethod: KvkkMethod
  reminderConsent: boolean
  marketingConsent: boolean
}

const emptyOwner: OwnerFormState = {
  firstName: '', lastName: '', tckn: '', clearTckn: false, isForeign: false, foreignDocNo: '', birthDate: '', phone: '', phone2: '', email: '',
  city: '', district: '', address: '', emergencyName: '', emergencyPhone: '', preferredChannel: 'sms', tags: [], notes: '',
  kvkkNotice: false, kvkkMethod: 'printed', reminderConsent: true, marketingConsent: false,
}

function fromDetail(o: OwnerDetail): OwnerFormState {
  return {
    ...emptyOwner,
    firstName: o.firstName,
    lastName: o.lastName,
    isForeign: o.isForeign,
    birthDate: o.birthDate ?? '',
    phone: formatTrPhone(o.phone),
    phone2: formatTrPhone(o.phone2),
    email: o.email ?? '',
    city: o.city ?? '',
    district: o.district ?? '',
    address: o.address ?? '',
    emergencyName: o.emergencyName ?? '',
    emergencyPhone: formatTrPhone(o.emergencyPhone),
    preferredChannel: o.preferredChannel,
    tags: o.tags,
    notes: o.notes ?? '',
    kvkkNotice: !!o.kvkkNoticeAt,
    kvkkMethod: (o.kvkkMethod as KvkkMethod) ?? 'printed',
    reminderConsent: o.reminderConsent,
    marketingConsent: !!o.marketingConsentAt,
  }
}

function OwnerForm({ existing }: { existing?: OwnerDetail }) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const tagOptions = useOwnerTags()
  const initial = useMemo(() => (existing ? fromDetail(existing) : emptyOwner), [existing])
  const [s, setS] = useState<OwnerFormState>(initial)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [conflict, setConflict] = useState<string | null>(null)
  const [dupTckn, setDupTckn] = useState<{ id: string; fullName: string } | null>(null)
  const [dupPhone, setDupPhone] = useState<{ id: string; fullName: string }[]>([])
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const afterRef = useRef<'detail' | 'animal'>('detail')
  const dirty = JSON.stringify(s) !== JSON.stringify(initial)
  const set = <K extends keyof OwnerFormState>(k: K, v: OwnerFormState[K]) => setS((x) => ({ ...x, [k]: v }))

  const cancel = () => {
    if (dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Çıkmak istiyor musunuz?')) return
    nav(existing ? `/sahipler/${existing.id}` : '/sahipler')
  }
  useFormKeys(() => formRef.current?.requestSubmit(), cancel)

  function validate(): Record<string, string> {
    const e: Record<string, string> = {}
    if (s.firstName.trim().length < 2) e.firstName = 'Ad en az 2 karakter olmalı.'
    if (s.lastName.trim().length < 2) e.lastName = 'Soyad en az 2 karakter olmalı.'
    if (s.tckn && !isValidTckn(s.tckn)) e.tckn = 'TCKN geçersiz (11 hane, algoritma kontrolü).'
    if (!normalizeTrMobile(s.phone)) e.phone = 'Cep telefonu 5XX XXX XX XX biçiminde olmalı.'
    if (s.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) e.email = 'E-posta geçersiz.'
    if (s.emergencyPhone && !normalizeTrMobile(s.emergencyPhone)) e.emergencyPhone = 'Telefon geçersiz.'
    if (!s.city) e.city = 'İl seçin.'
    if (!s.district.trim()) e.district = 'İlçe girin.'
    if (!s.kvkkNotice) e.kvkkNotice = 'Aydınlatma metni verilmeden kayıt yapılamaz.'
    return e
  }

  async function checkDup(field: 'tckn' | 'phone') {
    const v = field === 'tckn' ? s.tckn : s.phone
    if (field === 'tckn' && !isValidTckn(v)) return setDupTckn(null)
    if (field === 'phone' && !normalizeTrMobile(v)) return setDupPhone([])
    try {
      const r = await api.get<{ tcknOwner: { id: string; fullName: string } | null; phoneOwners: { id: string; fullName: string }[] }>(
        '/api/owners/check' + qs({ [field]: v, exclude: existing?.id }),
      )
      if (field === 'tckn') setDupTckn(r.tcknOwner)
      else setDupPhone(r.phoneOwners)
    } catch {
      /* kontrol isteğe bağlı */
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    const after = afterRef.current
    afterRef.current = 'detail'
    const v = validate()
    setErrs(v)
    if (Object.keys(v).length) return setErr('Formda düzeltilmesi gereken alanlar var.')
    if (!s.tckn && !existing?.hasTckn && !s.isForeign) {
      if (!window.confirm("TCKN girilmedi. PETVET kaydı için TCKN gerekir; ilgili görevler 'eksik bilgi' durumunda açılır. Yine de kaydedilsin mi?")) return
    }
    setBusy(true)
    const body = {
      firstName: s.firstName,
      lastName: s.lastName,
      tckn: s.tckn || undefined,
      isForeign: s.isForeign,
      foreignDocNo: s.isForeign ? s.foreignDocNo || undefined : undefined,
      birthDate: s.birthDate || undefined,
      phone: s.phone,
      phone2: s.phone2 || undefined,
      email: s.email || undefined,
      city: s.city,
      district: s.district,
      address: s.address || undefined,
      emergencyName: s.emergencyName || undefined,
      emergencyPhone: s.emergencyPhone || undefined,
      preferredChannel: s.preferredChannel,
      tags: s.tags,
      notes: s.notes || undefined,
      kvkkNotice: s.kvkkNotice,
      kvkkMethod: s.kvkkMethod,
      reminderConsent: s.reminderConsent,
      marketingConsent: s.marketingConsent,
    }
    try {
      let id = existing?.id
      if (existing) {
        await api.put(`/api/owners/${existing.id}`, { ...body, version: existing.version, clearTckn: s.clearTckn || undefined })
      } else {
        id = (await api.post<{ id: string }>('/api/owners', body)).id
      }
      qc.invalidateQueries()
      toast(existing ? 'Sahip bilgileri güncellendi.' : 'Sahip kaydedildi.')
      if (after === 'animal') nav(`/hayvanlar/yeni?sahip=${id}`)
      else nav(`/sahipler/${id}`, { replace: true })
    } catch (e) {
      const he = e as HttpError
      if (he.code === 'VERSION_CONFLICT') setConflict(he.message)
      else if (he.code === 'DUPLICATE_TCKN') {
        setDupTckn({ id: (he.details as { ownerId: string }).ownerId, fullName: '' })
        setErr(he.message)
      } else setErr(he.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <nav className="crumb" aria-label="Konum">
        <Link to="/sahipler">Sahipler</Link> › {existing ? <><Link to={`/sahipler/${existing.id}`}>{existing.fullName}</Link> › Düzenle</> : 'Yeni sahip'}
      </nav>
      {conflict && (
        <div className="alert" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{conflict} Değişiklikleriniz kaydedilmedi.</span>
          <button className="btn sm" onClick={() => { setConflict(null); qc.invalidateQueries({ queryKey: ['owner', existing?.id] }) }}>Yeniden yükle</button>
        </div>
      )}
      <form ref={formRef} className="pnl" onSubmit={submit} noValidate style={{ maxWidth: 1080 }}>
        <div className="ph"><h2>{existing ? 'Sahip bilgilerini düzenle' : 'Yeni sahip'}</h2></div>
        <fieldset className="sec">
          <legend>Kimlik</legend>
          <div className="g4">
            <Field label="Ad *" htmlFor="fn" error={errs.firstName}><input id="fn" className={`inp${errs.firstName ? ' bad' : ''}`} maxLength={60} value={s.firstName} onChange={(e) => set('firstName', e.target.value)} autoFocus /></Field>
            <Field label="Soyad *" htmlFor="ln" error={errs.lastName}><input id="ln" className={`inp${errs.lastName ? ' bad' : ''}`} maxLength={60} value={s.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
            <Field label={s.isForeign ? 'Yabancı kimlik no (99…)' : 'TCKN (PETVET için)'} htmlFor="tc" error={errs.tckn}>
              <input
                id="tc"
                className={`inp mono${errs.tckn ? ' bad' : ''}`}
                inputMode="numeric"
                maxLength={11}
                placeholder={existing?.hasTckn ? `kayıtlı: *******${existing.tcknLast4} — değiştirmek için yazın` : ''}
                value={s.tckn}
                disabled={s.clearTckn}
                onChange={(e) => set('tckn', e.target.value.replace(/\D/g, ''))}
                onBlur={() => checkDup('tckn')}
              />
            </Field>
            <Field label="Doğum tarihi" htmlFor="bd"><input id="bd" type="date" className="inp" value={s.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></Field>
            <div className="f" style={{ gridColumn: 'span 2' }}>
              <span className="l">&nbsp;</span>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <label className="ck"><input type="checkbox" checked={s.isForeign} onChange={(e) => set('isForeign', e.target.checked)} />Yabancı uyruklu</label>
                {existing?.hasTckn && <label className="ck"><input type="checkbox" checked={s.clearTckn} onChange={(e) => { set('clearTckn', e.target.checked); set('tckn', '') }} />Kayıtlı TCKN'yi sil</label>}
              </div>
            </div>
            {s.isForeign && (
              <Field label="Pasaport no" htmlFor="pp" style={{ gridColumn: 'span 2' }}>
                <input id="pp" className="inp mono" maxLength={40} placeholder={existing?.foreignDocLast4 ? `kayıtlı: ****${existing.foreignDocLast4}` : ''} value={s.foreignDocNo} onChange={(e) => set('foreignDocNo', e.target.value)} />
              </Field>
            )}
          </div>
          {dupTckn && (
            <div className="alert amb" style={{ gridColumn: 2 }}>
              Bu TCKN {dupTckn.fullName ? <strong>{dupTckn.fullName}</strong> : 'başka bir'} adlı sahipte kayıtlı. <Link to={`/sahipler/${dupTckn.id}`}>O kaydı aç</Link>
            </div>
          )}
        </fieldset>

        <fieldset className="sec">
          <legend>İletişim</legend>
          <div className="g4">
            <Field label="Cep telefonu *" htmlFor="ph" error={errs.phone}><input id="ph" className={`inp mono${errs.phone ? ' bad' : ''}`} value={s.phone} onChange={(e) => set('phone', e.target.value)} onBlur={() => checkDup('phone')} placeholder="0532 123 45 67" /></Field>
            <Field label="İkinci telefon" htmlFor="ph2"><input id="ph2" className="inp mono" value={s.phone2} onChange={(e) => set('phone2', e.target.value)} /></Field>
            <Field label="E-posta" htmlFor="em" error={errs.email} style={{ gridColumn: 'span 2' }}><input id="em" type="email" className={`inp${errs.email ? ' bad' : ''}`} value={s.email} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label="İl *" htmlFor="ci" error={errs.city}>
              <select id="ci" className={`inp${errs.city ? ' bad' : ''}`} value={s.city} onChange={(e) => set('city', e.target.value)}>
                <option value="">Seçin</option>
                {CITIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="İlçe *" htmlFor="di" error={errs.district}><input id="di" className={`inp${errs.district ? ' bad' : ''}`} value={s.district} onChange={(e) => set('district', e.target.value)} /></Field>
            <Field label="Adres" htmlFor="ad" style={{ gridColumn: 'span 2' }}><textarea id="ad" className="inp" style={{ height: 52, paddingTop: 4 }} value={s.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="Acil durum kişisi" htmlFor="en"><input id="en" className="inp" value={s.emergencyName} onChange={(e) => set('emergencyName', e.target.value)} /></Field>
            <Field label="Acil durum telefonu" htmlFor="ep" error={errs.emergencyPhone}><input id="ep" className="inp mono" value={s.emergencyPhone} onChange={(e) => set('emergencyPhone', e.target.value)} /></Field>
            <Field label="Tercih edilen kanal *" htmlFor="ch">
              <select id="ch" className="inp" value={s.preferredChannel} onChange={(e) => set('preferredChannel', e.target.value as Channel)}>
                {(Object.keys(CHANNEL_LABEL) as Channel[]).map((k) => <option key={k} value={k}>{CHANNEL_LABEL[k]}</option>)}
              </select>
            </Field>
          </div>
          {dupPhone.length > 0 && (
            <div className="alert amb" style={{ gridColumn: 2 }}>
              Bu numara başka sahipte de kayıtlı: {dupPhone.map((d, i) => <span key={d.id}>{i > 0 && ', '}<Link to={`/sahipler/${d.id}`}>{d.fullName}</Link></span>)}. Aile üyesi olabilir; kayıt engellenmez.
            </div>
          )}
        </fieldset>

        <fieldset className="sec">
          <legend>Etiket ve not</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }} role="group" aria-label="Etiketler">
              {[...new Set([...tagOptions, ...s.tags])].map((t) => (
                <label key={t} className="ck">
                  <input type="checkbox" checked={s.tags.includes(t)} onChange={(e) => set('tags', e.target.checked ? [...s.tags, t] : s.tags.filter((x) => x !== t))} />
                  {t}
                </label>
              ))}
            </div>
            <Field label="Not (yalnızca personel görür)" htmlFor="nt"><textarea id="nt" className="inp" style={{ height: 52, paddingTop: 4 }} value={s.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          </div>
        </fieldset>

        <fieldset className="sec" style={{ borderBottom: 0 }}>
          <legend>KVKK</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="ck"><input type="checkbox" checked={s.kvkkNotice} disabled={!!existing?.kvkkNoticeAt} onChange={(e) => set('kvkkNotice', e.target.checked)} />Aydınlatma metni verildi *</label>
              {existing?.kvkkNoticeAt && <span className="mut">{fmtDT(existing.kvkkNoticeAt)}</span>}
              <label className="ck" style={{ marginLeft: 8 }}>Yöntem
                <select className="inp" style={{ width: 140, marginLeft: 6 }} value={s.kvkkMethod} onChange={(e) => set('kvkkMethod', e.target.value as KvkkMethod)}>
                  <option value="printed">Basılı imza</option>
                  <option value="verbal">Sözlü</option>
                </select>
              </label>
            </div>
            {errs.kvkkNotice && <span className="err">{errs.kvkkNotice}</span>}
            <label className="ck"><input type="checkbox" checked={s.reminderConsent} onChange={(e) => set('reminderConsent', e.target.checked)} />Hatırlatma mesajı izni (aşı / randevu)</label>
            <label className="ck"><input type="checkbox" checked={s.marketingConsent} onChange={(e) => set('marketingConsent', e.target.checked)} />Ticari ileti (kampanya) izni</label>
            <span className="mut" style={{ fontSize: 12 }}>Rıza değişiklikleri geçmiş olarak saklanır (kim, ne zaman, hangi metin sürümü). Basılı aydınlatma formunu sahip detayından yazdırabilirsiniz.</span>
          </div>
        </fieldset>

        <div className="form-foot">
          <span className="mut" style={{ fontSize: 12 }}>
            {existing && <>Oluşturan: {existing.createdByName ?? '—'} · {fmtDT(existing.createdAt)} · Son değiştiren: {existing.updatedByName ?? '—'} · {fmtDT(existing.updatedAt)}</>}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {err && <span className="err" role="alert">{err}</span>}
            <button type="button" className="btn" onClick={cancel}>Vazgeç</button>
            <button type="submit" className="btn" disabled={busy} onClick={() => (afterRef.current = 'animal')}>Kaydet ve hayvan ekle</button>
            <button type="submit" className="btn p" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'} <span className="k">Ctrl+S</span></button>
          </div>
        </div>
      </form>
    </>
  )
}

/* ================= S-22 Sahip detayı ================= */

export function OwnerDetailPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const isNew = id === 'yeni'
  const edit = params.get('duzenle') === '1'
  const q = useQuery({ queryKey: ['owner', id], queryFn: () => api.get<OwnerDetail>(`/api/owners/${id}`), enabled: !isNew })

  if (isNew) return <OwnerForm key="new" />
  if (q.isError) {
    const he = q.error as HttpError
    const merged = (he.details as { mergedInto?: string } | undefined)?.mergedInto
    return (
      <div className="alert">
        {he.message} {merged && <Link to={`/sahipler/${merged}`}>Birleştirilen kaydı aç</Link>}
      </div>
    )
  }
  if (!q.data) return <div className="mut">Yükleniyor…</div>
  if (edit) return <OwnerForm key={`${id}-${q.data.version}`} existing={q.data} />
  return <OwnerView o={q.data} tab={params.get('sekme') ?? 'hayvanlar'} setTab={(t) => setParams({ sekme: t }, { replace: true, state: location.state })} />
}

function OwnerView({ o, tab, setTab }: { o: OwnerDetail; tab: string; setTab(t: string): void }) {
  const nav = useNavigate()
  const can = useCan()
  const toast = useToast()
  const qc = useQueryClient()
  const [tckn, setTckn] = useState<string | null>(null)
  const [showPassive, setShowPassive] = useState(false)
  const [merge, setMerge] = useState(false)
  const history = useQuery({ queryKey: ['owner-history', o.id], queryFn: () => api.get<HistoryRow[]>(`/api/owners/${o.id}/history`), enabled: tab === 'gecmis' })

  const active = o.animals.filter((a) => !a.toDate && a.status !== 'dead')
  const passive = o.animals.filter((a) => a.toDate || a.status === 'dead')

  async function reveal() {
    try {
      const r = await api.post<{ tckn: string | null; foreignDocNo: string | null }>(`/api/owners/${o.id}/tckn/reveal`)
      setTckn(r.tckn ?? r.foreignDocNo)
      setTimeout(() => setTckn(null), 30_000)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }
  async function remove() {
    if (!window.confirm(`${o.fullName} kaydı silinsin mi? (Yumuşak silme; denetim kaydına yazılır.)`)) return
    try {
      await api.del(`/api/owners/${o.id}`)
      qc.invalidateQueries()
      toast('Sahip kaydı silindi.')
      nav('/sahipler')
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  return (
    <>
      <nav className="crumb" aria-label="Konum"><Link to="/sahipler">Sahipler</Link> › {o.fullName}</nav>
      <section className="pnl" style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start', borderRadius: '3px 3px 0 0' }}>
        <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 22 }}>{o.fullName}</h1>
            {o.tags.map((t) => <span key={t} className="tag s-gry">{t}</span>)}
            {o.kvkkNoticeAt ? <span className="st s-ok">Aydınlatma verildi</span> : <span className="st s-red">Aydınlatma yok</span>}
            <span className={`st ${o.reminderConsent ? 's-ok' : 's-gry'}`}>Hatırlatma {o.reminderConsent ? '✓' : '✗'}</span>
            <span className={`st ${o.marketingConsentAt ? 's-ok' : 's-gry'}`}>Ticari ileti {o.marketingConsentAt ? '✓' : '✗'}</span>
          </div>
          <dl className="kv" style={{ maxWidth: 640 }}>
            <dt>Telefon</dt>
            <dd>
              <button type="button" className="mono" title="Kopyala" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => navigator.clipboard.writeText(formatTrPhone(o.phone)).then(() => toast('Telefon kopyalandı.'))}>
                {formatTrPhone(o.phone)}
              </button>
              {o.phone2 && <span className="mono mut"> · {formatTrPhone(o.phone2)}</span>}
              <span className="mut"> · tercih: {CHANNEL_LABEL[o.preferredChannel]}</span>
            </dd>
            <dt>İl / ilçe</dt>
            <dd>{[o.city, o.district].filter(Boolean).join(' / ') || '—'}{o.address ? <span className="mut"> · {o.address}</span> : null}</dd>
            <dt>{o.isForeign ? 'Kimlik' : 'TCKN'}</dt>
            <dd>
              {o.hasTckn || o.foreignDocLast4 ? (
                <>
                  <span className="mono">{tckn ?? `*******${o.tcknLast4 ?? o.foreignDocLast4}`}</span>{' '}
                  {can('owners.tckn.view') && !tckn && <button type="button" className="btn sm" onClick={reveal}>Göster</button>}
                  {tckn && <span className="mut" style={{ fontSize: 12 }}> görüntüleme kaydedildi</span>}
                </>
              ) : (
                <span className="st s-amb">Kayıtlı değil — PETVET için gerekli</span>
              )}
            </dd>
            {o.email && <><dt>E-posta</dt><dd>{o.email}</dd></>}
            {o.emergencyName && <><dt>Acil durum</dt><dd>{o.emergencyName} · <span className="mono">{formatTrPhone(o.emergencyPhone)}</span></dd></>}
            {o.notes && <><dt>Not</dt><dd>{o.notes}</dd></>}
          </dl>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {can('owners.write') && <Link className="btn" to={`/sahipler/${o.id}?duzenle=1`}>Düzenle</Link>}
          {can('animals.write') && <Link className="btn p" to={`/hayvanlar/yeni?sahip=${o.id}`}>Yeni hayvan</Link>}
          {can('appointments.write') && <Link className="btn" to={active[0] ? `/randevular?yeni=1&animal=${active[0].id}` : '/randevular'}>Randevu ver</Link>}
          {can('messages.send') && <Link className="btn" to="/mesajlar">Mesaj gönder</Link>}
          <DropMenu
            label="⋯"
            items={[
              { label: 'KVKK talebi başlat', onClick: () => nav('/ayarlar/kvkk'), hidden: !can('kvkk.requests') },
              { label: 'Birleştir…', onClick: () => setMerge(true), hidden: !can('owners.merge') },
              { label: 'Sil', onClick: remove, hidden: !can('owners.merge'), danger: true },
            ]}
          />
        </div>
      </section>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'hayvanlar', label: `Hayvanlar (${active.length})` },
          { key: 'randevular', label: 'Randevular' },
          { key: 'mesajlar', label: 'Mesajlar' },
          { key: 'belgeler', label: 'Belgeler' },
          { key: 'izinler', label: 'İzinler' },
          { key: 'gecmis', label: 'Geçmiş' },
        ]}
      />

      {tab === 'hayvanlar' && (
        <section className="pnl">
          <div className="ph">
            <h2>Hayvanlar</h2>
            {passive.length > 0 && <label className="ck" style={{ fontSize: 12 }}><input type="checkbox" checked={showPassive} onChange={(e) => setShowPassive(e.target.checked)} />Pasifleri göster ({passive.length})</label>}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Ad</th><th>Tür / ırk</th><th>Yaş</th><th>Cinsiyet</th><th>Çip</th><th>Durum</th></tr></thead>
              <tbody>
                {[...active, ...(showPassive ? passive : [])].map((a) => (
                  <tr key={a.id} className="click" onClick={() => nav(`/hayvanlar/${a.id}`)}>
                    <td>
                      <strong>{a.name}</strong>{' '}
                      {a.allergies.length > 0 && <span className="tag s-red">Alerji</span>}{' '}
                      {(a.behavior === 'aggressive' || a.behavior === 'bites') && <span className="tag s-amb">{BEHAVIOR_LABEL[a.behavior as Behavior]}</span>}
                    </td>
                    <td>{[SPECIES_LABEL[a.species], a.breed].filter(Boolean).join(' · ')}</td>
                    <td>{age(a.birthDate)}</td>
                    <td>{SEX_LABEL[a.sex]}{a.neutered ? ', kısır' : ''}</td>
                    <td><ChipNo value={a.chipNo} short /></td>
                    <td>
                      {a.toDate ? <span className="st s-gry">Devredildi ({formatDateTr(a.toDate)})</span> : (
                        <span className={`st ${a.status === 'active' ? 's-ok' : a.status === 'lost' ? 's-red' : 's-gry'}`}>{ANIMAL_STATUS_LABEL[a.status] ?? a.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {active.length === 0 && !showPassive && <div className="empty">Aktif hayvan yok. {can('animals.write') && <Link to={`/hayvanlar/yeni?sahip=${o.id}`}>Yeni hayvan ekle</Link>}</div>}
          </div>
        </section>
      )}
      {tab === 'randevular' && (
        <section className="pnl"><div className="empty">Randevular randevu modülünde görüntülenir. <Link to="/randevular">Randevu takvimine git</Link></div></section>
      )}
      {tab === 'mesajlar' && (
        <section className="pnl"><div className="empty">Bu sahibe giden mesajlar mesaj modülünde görüntülenir. <Link to="/mesajlar">Mesajlara git</Link></div></section>
      )}
      {tab === 'belgeler' && <Attachments ownerType="owner" ownerId={o.id} canUpload={can('owners.write')} />}
      {tab === 'izinler' && (
        <section className="pnl">
          <div className="ph"><h2>Rıza geçmişi</h2></div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Tarih</th><th>İzin</th><th>Durum</th><th>Metin sürümü</th><th>Yöntem</th><th>Kaydeden</th></tr></thead>
              <tbody>
                {o.consents.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{fmtDT(c.at)}</td>
                    <td>{CONSENT_LABEL[c.type]}</td>
                    <td>{c.granted ? <span className="st s-ok">Verildi</span> : <span className="st s-gry">Verilmedi / geri alındı</span>}</td>
                    <td className="mono">{c.textVersion}</td>
                    <td>{c.channel ? (KVKK_METHOD_LABEL[c.channel] ?? c.channel) : ''}</td>
                    <td>{c.userName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {o.consents.length === 0 && <div className="empty">Rıza kaydı yok.</div>}
          </div>
        </section>
      )}
      {tab === 'gecmis' && <HistoryTable rows={history.data} />}
      <p className="mut" style={{ margin: 0, fontSize: 12 }}>
        Oluşturan: {o.createdByName ?? '—'} · {fmtDT(o.createdAt)} · Son değiştiren: {o.updatedByName ?? '—'} · {fmtDT(o.updatedAt)}
      </p>
      {merge && <MergeDialog keep={o} onClose={() => setMerge(false)} />}
    </>
  )
}

/* ---------- Birleştirme (yalnız yönetici) ---------- */

function mergeValue(o: OwnerDetail, f: MergeField): string {
  switch (f) {
    case 'tckn':
      return o.tcknLast4 ? `*******${o.tcknLast4}` : ''
    case 'phone':
      return formatTrPhone(o.phone)
    case 'phone2':
      return formatTrPhone(o.phone2)
    case 'birthDate':
      return formatDateTr(o.birthDate)
    case 'emergency':
      return o.emergencyName ? `${o.emergencyName} · ${formatTrPhone(o.emergencyPhone)}` : ''
    default:
      return (o[f] as string | null) ?? ''
  }
}

function MergeDialog({ keep, onClose }: { keep: OwnerDetail; onClose(): void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [pickOwner, setPickOwner] = useState<{ id: string; label: string } | null>(null)
  const [pick, setPick] = useState<Partial<Record<MergeField, 'keep' | 'other'>>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const other = useQuery({ queryKey: ['owner', pickOwner?.id], queryFn: () => api.get<OwnerDetail>(`/api/owners/${pickOwner!.id}`), enabled: !!pickOwner })

  async function submit() {
    if (!other.data) return
    if (!window.confirm(`${other.data.fullName} kaydı ${keep.fullName} kaydına taşınacak ve silinecek. Onaylıyor musunuz?`)) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.post<{ movedAnimals: number }>(`/api/owners/${keep.id}/merge`, { otherId: other.data.id, pick })
      qc.invalidateQueries()
      toast(`Kayıtlar birleştirildi; ${r.movedAnimals} hayvan taşındı.`)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Mükerrer sahip kayıtlarını birleştir"
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="err">{err}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>Vazgeç</button>
            <button className="btn p" disabled={!other.data || busy} onClick={submit}>Birleştir</button>
          </div>
        </>
      }
    >
      <p className="mut" style={{ margin: 0 }}>Soldaki kayıt ({keep.fullName}) kalır. Seçtiğiniz kaydın hayvanları, PETVET görevleri, belgeleri ve rıza geçmişi bu kayda taşınır; o kayıt silinir.</p>
      <OwnerPicker value={pickOwner} onChange={(v) => { setPickOwner(v); setPick({}) }} exclude={[keep.id]} label="Birleştirilecek (silinecek) kayıt" id="merge-q" />
      {other.data && (
        <table>
          <thead><tr><th>Alan</th><th>Kalan: {keep.fullName}</th><th>Silinecek: {other.data.fullName}</th></tr></thead>
          <tbody>
            {MERGE_FIELDS.map((f) => {
              const a = mergeValue(keep, f)
              const b = mergeValue(other.data!, f)
              const sel = pick[f] ?? (a ? 'keep' : b ? 'other' : 'keep')
              return (
                <tr key={f}>
                  <td className="mut">{MERGE_FIELD_LABEL[f]}</td>
                  {(['keep', 'other'] as const).map((side) => (
                    <td key={side}>
                      <label className="ck" style={{ minHeight: 0 }}>
                        <input type="radio" name={`m-${f}`} checked={sel === side} disabled={a === b} onChange={() => setPick((p) => ({ ...p, [f]: side }))} />
                        <span className={f === 'tckn' || f.startsWith('phone') ? 'mono' : undefined}>{(side === 'keep' ? a : b) || <span className="mut">—</span>}</span>
                      </label>
                    </td>
                  ))}
                </tr>
              )
            })}
            <tr>
              <td className="mut">Hayvanlar</td>
              <td>{keep.animals.map((x) => x.name).join(', ') || '—'}</td>
              <td>{other.data.animals.map((x) => x.name).join(', ') || '—'} <span className="mut">(taşınır)</span></td>
            </tr>
          </tbody>
        </table>
      )}
    </Modal>
  )
}
