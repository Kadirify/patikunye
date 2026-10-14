// Randevu modülü: takvim, randevu formu, bekleme salonu, Bugün ekranı randevu kartı
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError, qs } from '../api'
import { useCan, useSession } from '../session'
import { Field, animalLine, useToast } from '../ui'
import { addDaysIso, formatDateTr, todayIstanbul } from '@shared/petvet'
import { formatTrPhone } from '@shared/identity'
import { SPECIES_LABEL, type AnimalDetail, type AnimalListItem, type Species } from '@shared/api-types'
import {
  APPOINTMENT_STATUS_CLASS,
  APPOINTMENT_STATUS_LABEL,
  WAIT_WARN_MINUTES,
  canTransition,
  fromMinutes,
  istanbulIso,
  istanbulParts,
  toMinutes,
  weekdayOf,
  type AppointmentConfigDto,
  type AppointmentDto,
  type AppointmentSaveResult,
  type AppointmentStatus,
  type AppointmentWarning,
  type CancelSide,
  type WaitingRoomDto,
} from '@shared/appointments'

/* ---------- Ortak yardımcılar ---------- */

const PX_PER_MIN = 40 / 30
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi']
const DAYS_SHORT = ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct']

function longDate(d: string) {
  const [y, m, day] = d.split('-').map(Number)
  return `${day} ${MONTHS[m - 1]} ${y}, ${DAYS[weekdayOf(d)]}`
}
/** Haftanın pazartesisi */
function mondayOf(d: string) {
  const wd = weekdayOf(d)
  return addDaysIso(d, wd === 0 ? -6 : 1 - wd)
}
/** Türün çerçeve renginden açık zemin tonu */
function tint(hex: string | null | undefined, k = 0.8) {
  const h = /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex! : '#8FA9D3'
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  return `rgb(${c.map((v) => Math.round(v + (255 - v) * k)).join(',')})`
}
const shortName = (n: string | null) => {
  if (!n) return ''
  const p = n.replace(/^Dr\.?\s*/i, '').split(' ')
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]
}
const BEHAVIOR: Record<string, { label: string; cls: string }> = {
  aggressive: { label: 'Agresif', cls: 's-red' },
  bites: { label: 'Isırır', cls: 's-red' },
  shy: { label: 'Ürkek', cls: 's-amb' },
}

function PatientTags({ a }: { a: AppointmentDto }) {
  const b = a.behavior ? BEHAVIOR[a.behavior] : null
  if (!b && !a.allergies.length && !a.isNewPatient) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {b && <span className={`tag ${b.cls}`}>{b.label}</span>}
      {a.allergies.length > 0 && <span className="tag s-red" title={a.allergies.join(', ')}>Alerji: {a.allergies.join(', ')}</span>}
      {a.isNewPatient && <span className="tag s-gry">Kayıtsız hasta</span>}
    </span>
  )
}

function StatusBadge({ a }: { a: AppointmentDto }) {
  if (a.status === 'arrived') {
    const late = (a.waitMinutes ?? 0) > WAIT_WARN_MINUTES
    return <span className={`st ${late ? 's-red' : 's-amb'}`}>Bekliyor {a.waitMinutes ?? 0} dk</span>
  }
  if (a.status === 'done') return <span className="st s-ok">Bitti</span>
  if (a.suggestNoShow) return <span className="st s-amb">Gecikti - gelmedi?</span>
  return <span className={`st ${APPOINTMENT_STATUS_CLASS[a.status]}`}>{APPOINTMENT_STATUS_LABEL[a.status]}</span>
}

function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(29,28,26,.35)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section className="pnl" role="dialog" aria-modal="true" aria-label={title} style={{ width, maxWidth: '100%', boxShadow: '0 6px 24px rgba(0,0,0,.18)' }}>
        <div className="ph">
          <h2>{title}</h2>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Kapat">✕</button>
        </div>
        {children}
      </section>
    </div>
  )
}

function useConfig() {
  return useQuery({ queryKey: ['appt-config'], queryFn: () => api.get<AppointmentConfigDto>('/api/appointments/config'), staleTime: 60_000 })
}

/** Durum değiştirme (hata -> toast) */
function useStatusAction() {
  const qc = useQueryClient()
  const toast = useToast()
  return async (a: AppointmentDto, status: AppointmentStatus, extra: Record<string, unknown> = {}) => {
    try {
      await api.post<AppointmentDto>(`/api/appointments/${a.id}/status`, { status, ...extra })
      qc.invalidateQueries()
      return true
    } catch (e) {
      toast((e as Error).message, 'err')
      qc.invalidateQueries()
      return false
    }
  }
}

function warnText(w: AppointmentWarning[]) {
  return w.map((x) => x.message).join(' ')
}

/* ---------- Hasta seçici ---------- */

type Patient =
  | { kind: 'animal'; id: string; label: string; sub: string }
  | { kind: 'new'; ownerName: string; phone: string; animalName: string; species: Species }

function PatientPicker({ value, onChange }: { value: Patient | null; onChange: (p: Patient | null) => void }) {
  const [q, setQ] = useState('')
  const search = useQuery({
    queryKey: ['animals', 'appt-search', q],
    queryFn: () => api.get<AnimalListItem[]>('/api/animals' + qs({ q })),
    enabled: q.trim().length >= 2 && !value,
  })
  if (value?.kind === 'animal') {
    return (
      <div style={{ border: '1px solid var(--accent)', background: '#eef3fa', borderRadius: 2, padding: '6px 10px', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span><strong>{value.label}</strong> <span className="mut">- {value.sub}</span></span>
        <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => onChange(null)}>Değiştir</button>
      </div>
    )
  }
  if (value?.kind === 'new') {
    const set = (p: Partial<typeof value>) => onChange({ ...value, ...p })
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="g4" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <Field label="Sahip adı soyadı *" htmlFor="np-o"><input id="np-o" className="inp" value={value.ownerName} onChange={(e) => set({ ownerName: e.target.value })} /></Field>
          <Field label="Cep telefonu *" htmlFor="np-p"><input id="np-p" className="inp mono" value={value.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="05XX XXX XX XX" /></Field>
          <Field label="Hayvan adı *" htmlFor="np-a"><input id="np-a" className="inp" value={value.animalName} onChange={(e) => set({ animalName: e.target.value })} /></Field>
          <Field label="Tür *" htmlFor="np-s">
            <select id="np-s" className="inp" value={value.species} onChange={(e) => set({ species: e.target.value as Species })}>
              {(Object.keys(SPECIES_LABEL) as Species[]).map((s) => <option key={s} value={s}>{SPECIES_LABEL[s]}</option>)}
            </select>
          </Field>
        </div>
        <div><button type="button" className="btn sm" onClick={() => onChange(null)}>Kayıtlı hasta ara</button></div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="inp" style={{ flex: 1 }} aria-label="Hasta ara" placeholder="Hayvan adı, sahip, telefon, çip..." value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" autoFocus />
        <button type="button" className="btn" onClick={() => onChange({ kind: 'new', ownerName: '', phone: '', animalName: '', species: 'cat' })}>Yeni hasta...</button>
      </div>
      {search.data && search.data.length > 0 && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 2, maxHeight: 220, overflowY: 'auto' }}>
          {search.data.map((x) => (
            <button
              key={x.id}
              type="button"
              className="list-row"
              style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line-3)', background: '#fff', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onChange({ kind: 'animal', id: x.id, label: x.name, sub: [animalLine(x), x.ownerName, formatTrPhone(x.ownerPhone)].filter(Boolean).join(' - ') })}
            >
              <span><strong>{x.name}</strong> <span className="mut">- {animalLine(x)}</span></span>
              <span className="mut">{x.ownerName}</span>
            </button>
          ))}
        </div>
      )}
      {search.data?.length === 0 && <span className="mut">Hasta bulunamadı. "Yeni hasta" ile hızlıca ekleyin.</span>}
    </div>
  )
}

function patientBody(p: Patient | null) {
  if (!p) return {}
  if (p.kind === 'animal') return { animalId: p.id }
  return { newPatient: { ownerName: p.ownerName, phone: p.phone, animalName: p.animalName, species: p.species } }
}

/* ---------- Randevu formu ---------- */

interface FormPreset {
  date?: string
  time?: string
  vetId?: string
  animalId?: string
}

function AppointmentForm({ cfg, edit, preset, onClose }: { cfg: AppointmentConfigDto; edit: AppointmentDto | null; preset: FormPreset; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { user } = useSession()
  const activeTypes = cfg.types.filter((t) => t.active || t.id === edit?.typeId)
  const defVet = preset.vetId ?? cfg.vets.find((v) => v.id === user?.id)?.id ?? cfg.vets[0]?.id ?? ''
  const [patient, setPatient] = useState<Patient | null>(() => {
    if (!edit) return null
    if (edit.animalId) return { kind: 'animal', id: edit.animalId, label: edit.animalName, sub: [edit.ownerName, formatTrPhone(edit.ownerPhone)].filter(Boolean).join(' - ') }
    return { kind: 'new', ownerName: edit.ownerName ?? '', phone: formatTrPhone(edit.ownerPhone), animalName: edit.animalName, species: edit.species ?? 'other' }
  })
  const [f, setF] = useState(() => ({
    date: edit?.date ?? preset.date ?? todayIstanbul(),
    time: edit?.time ?? preset.time ?? '',
    duration: edit?.durationMinutes ?? activeTypes[0]?.defaultMinutes ?? 30,
    vetId: edit?.vetId ?? defVet,
    typeId: edit?.typeId ?? activeTypes[0]?.id ?? '',
    reason: edit?.reason ?? '',
    reminder: edit?.reminder ?? true,
    sendConfirmation: false,
    notifyOwner: true,
  }))
  const [durTouched, setDurTouched] = useState(!!edit)
  const [err, setErr] = useState('')
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // ?animal=ID ön doldurma
  const pre = useQuery({
    queryKey: ['animal', preset.animalId],
    queryFn: () => api.get<AnimalDetail>(`/api/animals/${preset.animalId}`),
    enabled: !!preset.animalId && !edit,
  })
  useEffect(() => {
    if (pre.data && !patient) {
      const o = pre.data.owners.find((x) => x.isPrimary) ?? pre.data.owners[0]
      setPatient({ kind: 'animal', id: pre.data.id, label: pre.data.name, sub: [animalLine(pre.data), o?.fullName, formatTrPhone(o?.phone)].filter(Boolean).join(' - ') })
    }
  }, [pre.data]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const startsAt = f.date && /^\d{2}:\d{2}$/.test(f.time) ? istanbulIso(f.date, f.time) : ''
  const check = useQuery({
    queryKey: ['appt-check', startsAt, f.duration, f.vetId, edit?.id],
    queryFn: () =>
      api.post<{ warnings: AppointmentWarning[]; overlap: boolean }>('/api/appointments/check', {
        startsAt,
        durationMinutes: f.duration,
        vetId: f.vetId || null,
        excludeId: edit?.id ?? null,
      }),
    enabled: !!startsAt && f.duration >= 5,
  })
  const timeChanged = !!edit && (edit.date !== f.date || edit.time !== f.time)

  // Uygun hekimler (o gün çalışan) önce: klinik saatleri ortak olduğundan sıra ad sırasıdır
  const slot = cfg.slotMinutes

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setConflict(false)
    if (!patient) return setErr('Bir hasta seçin ya da yeni hasta bilgilerini girin.')
    if (patient.kind === 'new' && (!patient.ownerName.trim() || !patient.phone.trim() || !patient.animalName.trim())) return setErr('Yeni hasta için sahip adı, telefon ve hayvan adı gerekli.')
    if (!startsAt) return setErr('Tarih ve saat girin.')
    if (!f.vetId) return setErr('Hekim seçin.')
    if (!f.typeId) return setErr('Randevu türünü seçin.')
    setBusy(true)
    try {
      const payload = {
        ...patientBody(patient),
        startsAt,
        durationMinutes: Number(f.duration),
        vetId: f.vetId,
        typeId: f.typeId,
        reason: f.reason || undefined,
        reminder: f.reminder,
      }
      const r = edit
        ? await api.put<AppointmentSaveResult>(`/api/appointments/${edit.id}`, { ...payload, version: edit.version, notifyOwner: timeChanged && f.notifyOwner })
        : await api.post<AppointmentSaveResult>('/api/appointments', { ...payload, sendConfirmation: f.sendConfirmation })
      qc.invalidateQueries()
      toast(`Randevu kaydedildi: ${formatDateTr(f.date)} ${f.time}.${r.warnings.length ? ' Uyarı: ' + warnText(r.warnings) : ''}`)
      onClose()
    } catch (e2) {
      const he = e2 as HttpError
      if (he.code === 'VERSION_CONFLICT') setConflict(true)
      setErr(he.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={edit ? 'Randevuyu düzenle' : 'Yeni randevu'} onClose={onClose} width={640}>
      <form ref={formRef} onSubmit={submit}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="f">
            <span className="l">Hasta *</span>
            <PatientPicker value={patient} onChange={setPatient} />
          </div>
          <div className="g4">
            <Field label="Tarih *" htmlFor="ap-d"><input id="ap-d" type="date" className="inp" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
            <Field label="Saat *" htmlFor="ap-t"><input id="ap-t" type="time" className="inp mono" step={slot * 60} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></Field>
            <Field label="Süre (dk) *" htmlFor="ap-du">
              <input id="ap-du" type="number" min={5} max={480} step={5} className="inp mono" value={f.duration} onChange={(e) => { setDurTouched(true); setF({ ...f, duration: Number(e.target.value) }) }} required />
            </Field>
            <Field label="Hekim *" htmlFor="ap-v">
              <select id="ap-v" className="inp" value={f.vetId} onChange={(e) => setF({ ...f, vetId: e.target.value })} required>
                {cfg.vets.map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
              </select>
            </Field>
            <Field label="Tür *" htmlFor="ap-ty" style={{ gridColumn: 'span 2' }}>
              <select
                id="ap-ty"
                className="inp"
                value={f.typeId}
                onChange={(e) => {
                  const t = cfg.types.find((x) => x.id === e.target.value)
                  setF({ ...f, typeId: e.target.value, duration: !durTouched && t ? t.defaultMinutes : f.duration })
                }}
                required
              >
                {activeTypes.map((t) => <option key={t.id} value={t.id}>{t.name} - {t.defaultMinutes} dk</option>)}
              </select>
            </Field>
            <Field label="Neden / not" htmlFor="ap-r" style={{ gridColumn: 'span 2' }}>
              <input id="ap-r" className="inp" maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label className="ck"><input type="checkbox" checked={f.reminder} onChange={(e) => setF({ ...f, reminder: e.target.checked })} />Hatırlatma gönder (sahip izni varsa)</label>
            {!edit && <label className="ck"><input type="checkbox" checked={f.sendConfirmation} onChange={(e) => setF({ ...f, sendConfirmation: e.target.checked })} />Şimdi onay mesajı gönder</label>}
            {timeChanged && <label className="ck"><input type="checkbox" checked={f.notifyOwner} onChange={(e) => setF({ ...f, notifyOwner: e.target.checked })} />Sahibe değişiklik mesajı gönder</label>}
          </div>
          {patient?.kind === 'new' && <span className="mut" style={{ fontSize: 12 }}>Kayıtsız hastaya hatırlatma gönderilmez; hasta gelince kaydını açın.</span>}
          {check.data && check.data.warnings.length > 0 && (
            <div className="alert amb" role="status">{check.data.warnings.map((w) => <div key={w.code}>{w.message}</div>)}<div className="mut">Uyarılar kaydı engellemez.</div></div>
          )}
          {err && (
            <div className="alert" role="alert">
              {err}
              {conflict && <> <button type="button" className="btn sm" onClick={() => { qc.invalidateQueries(); onClose() }}>Yeniden yükle</button></>}
            </div>
          )}
        </div>
        <div className="form-foot">
          <span className="mut" style={{ fontSize: 12 }}>Ctrl+S kaydet - Esc kapat</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
            <button type="submit" className="btn p" disabled={busy}>{busy ? 'Kaydediliyor...' : 'Kaydet'}</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/* ---------- İptal diyaloğu ---------- */

function CancelDialog({ a, onClose }: { a: AppointmentDto; onClose: () => void }) {
  const run = useStatusAction()
  const toast = useToast()
  const [side, setSide] = useState<CancelSide | 'no_show' | ''>('')
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(false)
  const [err, setErr] = useState('')
  const noShowAllowed = canTransition(a.status, 'no_show')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!side) return setErr('İptal nedenini seçin.')
    if (side !== 'no_show' && reason.trim().length < 2) return setErr('Açıklama yazın.')
    const ok =
      side === 'no_show'
        ? await run(a, 'no_show', { version: a.version })
        : await run(a, 'cancelled', { version: a.version, cancelledBySide: side, cancelReason: reason.trim(), notifyOwner: notify })
    if (ok) {
      toast(side === 'no_show' ? 'Gelmedi olarak işaretlendi.' : 'Randevu iptal edildi.')
      onClose()
    }
  }
  return (
    <Modal title={`Randevu iptali - ${a.animalName} ${formatDateTr(a.date)} ${a.time}`} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <legend style={{ fontSize: 12, marginBottom: 4 }}>Neden *</legend>
            <label className="ck"><input type="radio" name="cs" checked={side === 'owner'} onChange={() => setSide('owner')} />Sahip iptal etti</label>
            <label className="ck"><input type="radio" name="cs" checked={side === 'clinic'} onChange={() => setSide('clinic')} />Klinik iptal etti</label>
            {noShowAllowed && <label className="ck"><input type="radio" name="cs" checked={side === 'no_show'} onChange={() => setSide('no_show')} />Gelmedi</label>}
          </fieldset>
          {side && side !== 'no_show' && (
            <>
              <Field label="Açıklama *" htmlFor="cr"><input id="cr" className="inp" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
              {a.ownerId && <label className="ck"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Sahibe iptal mesajı gönder</label>}
            </>
          )}
          {err && <div className="alert" role="alert">{err}</div>}
        </div>
        <div className="form-foot">
          <span />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
            <button type="submit" className="btn p">{side === 'no_show' ? 'Gelmedi işaretle' : 'Randevuyu iptal et'}</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/* ---------- Randevu özeti (takvimde tıklayınca) ---------- */

function SummaryDialog({ a, onClose, onEdit, onCancel }: { a: AppointmentDto; onClose: () => void; onEdit: () => void; onCancel: () => void }) {
  const can = useCan()
  const run = useStatusAction()
  const w = can('appointments.write')
  const row = (k: string, v: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, padding: '4px 0' }}><span className="mut">{k}</span><span>{v}</span></div>
  )
  return (
    <Modal title={`${a.time}-${a.endTime} - ${a.animalName}`} onClose={onClose} width={460}>
      <div style={{ padding: '10px 16px' }}>
        {row('Hasta', <>{a.animalId ? <Link to={`/hayvanlar/${a.animalId}`}>{a.animalName}</Link> : a.animalName}{a.species && <span className="mut"> - {SPECIES_LABEL[a.species]}</span>} <PatientTags a={a} /></>)}
        {row('Sahip', a.ownerName ?? '-')}
        {row('Telefon', <span className="mono">{formatTrPhone(a.ownerPhone) || '-'}</span>)}
        {row('Tarih', `${formatDateTr(a.date)} ${a.time}-${a.endTime} (${a.durationMinutes} dk)`)}
        {row('Hekim', a.vetName ?? <span className="s-amb">Seçilmedi</span>)}
        {row('Tür', a.typeName ?? '-')}
        {row('Neden / not', a.reason || '-')}
        {row('Durum', <><StatusBadge a={a} />{a.overlap && <span className="tag s-amb" style={{ marginLeft: 6 }}>Çift kayıt</span>}</>)}
        {a.status === 'cancelled' && row('İptal', `${a.cancelledBySide === 'owner' ? 'Sahip' : 'Klinik'}: ${a.cancelReason ?? ''}`)}
      </div>
      {w && (
        <div className="form-foot">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canTransition(a.status, 'arrived') && a.status !== 'in_exam' && a.status !== 'done' && (
              <button type="button" className="btn p" onClick={async () => (await run(a, 'arrived')) && onClose()}>Geldi</button>
            )}
            {(a.status === 'arrived' || a.status === 'in_exam') && a.animalId && (
              <Link className="btn" to={`/muayene/yeni?animal=${a.animalId}&appointment=${a.id}`}>Muayeneyi aç</Link>
            )}
            {['planned', 'confirmed', 'arrived'].includes(a.status) && <button type="button" className="btn" onClick={onEdit}>Düzenle</button>}
            {['planned', 'confirmed', 'arrived'].includes(a.status) && <button type="button" className="btn" onClick={onCancel}>İptal</button>}
          </div>
          {a.status === 'no_show' && a.animalId && <Link to={`/randevular?yeni=1&animal=${a.animalId}`} onClick={onClose}>Yeniden randevu</Link>}
        </div>
      )}
    </Modal>
  )
}

/* ---------- Mini ay takvimi ---------- */

function MiniMonth({ value, onPick, holidays }: { value: string; onPick: (d: string) => void; holidays: Set<string> }) {
  const [ym, setYm] = useState(value.slice(0, 7))
  useEffect(() => setYm(value.slice(0, 7)), [value])
  const [y, m] = ym.split('-').map(Number)
  const first = `${ym}-01`
  const lead = (weekdayOf(first) + 6) % 7
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const today = todayIstanbul()
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    setYm(d.toISOString().slice(0, 7))
  }
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)]
  return (
    <section className="pnl">
      <div className="ph">
        <button type="button" className="btn sm" aria-label="Önceki ay" onClick={() => shift(-1)}>‹</button>
        <h2>{MONTHS[m - 1]} {y}</h2>
        <button type="button" className="btn sm" aria-label="Sonraki ay" onClick={() => shift(1)}>›</button>
      </div>
      <div style={{ padding: '6px 8px', display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12 }}>
        {['Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct', 'Pz'].map((d) => <span key={d} className="mut" style={{ padding: '4px 0' }}>{d}</span>)}
        {cells.map((d, i) =>
          d ? (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              title={holidays.has(d) ? 'Tatil' : undefined}
              aria-label={longDate(d)}
              aria-current={d === value ? 'date' : undefined}
              style={{
                font: 'inherit', padding: '4px 0', border: 0, cursor: 'pointer',
                background: d === value ? 'var(--ink)' : 'transparent',
                color: d === value ? '#fff' : weekdayOf(d) === 0 || holidays.has(d) ? 'var(--muted)' : 'inherit',
                outline: d === today && d !== value ? '1px solid var(--accent)' : undefined,
                textDecoration: holidays.has(d) ? 'line-through' : undefined,
              }}
            >
              {Number(d.slice(8))}
            </button>
          ) : <span key={'e' + i} />,
        )}
      </div>
    </section>
  )
}

/* ---------- Zaman ızgarası (gün / hafta) ---------- */

interface Column {
  key: string
  title: ReactNode
  date: string
  vetId: string | null
  items: AppointmentDto[]
}

type Drag = { a: AppointmentDto; kind: 'move' | 'resize'; grabOffsetMin: number } | null

/** Çakışan randevuları yan yana diz */
function layout(items: AppointmentDto[]) {
  const sorted = [...items].sort((x, y) => x.startsAt.localeCompare(y.startsAt))
  const out = new Map<string, { lane: number; lanes: number }>()
  let cluster: AppointmentDto[] = []
  let clusterEnd = ''
  let laneEnds: string[] = []
  const flush = () => {
    for (const c of cluster) out.get(c.id)!.lanes = laneEnds.length
    cluster = []
    laneEnds = []
  }
  for (const a of sorted) {
    if (cluster.length && a.startsAt >= clusterEnd) flush()
    let lane = laneEnds.findIndex((e) => e <= a.startsAt)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(a.endsAt)
    } else laneEnds[lane] = a.endsAt
    out.set(a.id, { lane, lanes: 1 })
    cluster.push(a)
    clusterEnd = clusterEnd > a.endsAt && cluster.length > 1 ? clusterEnd : a.endsAt
  }
  flush()
  return out
}

function TimeGrid({
  cfg,
  columns,
  range,
  compact,
  onSlot,
  onOpen,
  onDrop,
  canWrite,
}: {
  cfg: AppointmentConfigDto
  columns: Column[]
  range: [number, number]
  compact?: boolean
  onSlot: (date: string, time: string, vetId: string | null) => void
  onOpen: (a: AppointmentDto) => void
  onDrop: (a: AppointmentDto, date: string, startMin: number, endMin: number, vetId: string | null) => void
  canWrite: boolean
}) {
  const drag = useRef<Drag>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [nowP, setNowP] = useState(() => istanbulParts(new Date()))
  useEffect(() => {
    const t = setInterval(() => setNowP(istanbulParts(new Date())), 60_000)
    return () => clearInterval(t)
  }, [])
  const slot = cfg.slotMinutes
  const [r0, r1] = range
  const height = (r1 - r0) * PX_PER_MIN
  const holidays = new Map(cfg.holidays.map((h) => [h.date, h.name]))
  const slots: number[] = []
  for (let m = r0; m < r1; m += slot) slots.push(m)
  const hours: number[] = []
  for (let m = Math.ceil(r0 / 30) * 30; m < r1; m += 30) hours.push(m)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(${columns.length}, minmax(${compact ? 110 : 200}px, 1fr))`, minWidth: 56 + columns.length * (compact ? 110 : 200) }}>
      <div style={{ height: 36, borderBottom: '1px solid var(--line)', background: 'var(--head)', position: 'sticky', top: 0 }} />
      {columns.map((c) => (
        <div key={c.key} style={{ height: 36, borderBottom: '1px solid var(--line)', borderLeft: '1px solid var(--line)', background: 'var(--head)', display: 'flex', alignItems: 'center', padding: '0 10px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {c.title}
        </div>
      ))}
      <div style={{ position: 'relative', height }}>
        {hours.map((m) => (
          <div key={m} className="mono mut" style={{ position: 'absolute', top: (m - r0) * PX_PER_MIN, right: 6, fontSize: 11 }}>
            {m % 60 === 0 ? fromMinutes(m) : ''}
          </div>
        ))}
      </div>
      {columns.map((c) => {
        const wh = cfg.workHours.find((w) => w.day === weekdayOf(c.date))
        const closed = !wh || wh.closed || holidays.has(c.date)
        const open = wh ? toMinutes(wh.open) : 0
        const close = wh ? toMinutes(wh.close) : 0
        const bs = wh?.breakStart ? toMinutes(wh.breakStart) : null
        const be = wh?.breakEnd ? toMinutes(wh.breakEnd) : null
        const lay = layout(c.items)
        const isToday = c.date === nowP.date
        return (
          <div
            key={c.key}
            style={{
              position: 'relative',
              height,
              borderLeft: '1px solid var(--line)',
              background: `repeating-linear-gradient(to bottom, #fff 0 ${30 * PX_PER_MIN - 1}px, var(--line-3) ${30 * PX_PER_MIN - 1}px ${30 * PX_PER_MIN}px)`,
            }}
          >
            {slots.map((m) => {
              const off = closed || m < open || m >= close
              const k = `${c.key}|${m}`
              return (
                <div
                  key={m}
                  role={canWrite ? 'button' : undefined}
                  tabIndex={canWrite ? -1 : undefined}
                  aria-label={canWrite ? `${formatDateTr(c.date)} ${fromMinutes(m)} boş, randevu ekle` : undefined}
                  title={off ? (holidays.get(c.date) ?? 'Çalışma saati dışında') : undefined}
                  onClick={() => canWrite && onSlot(c.date, fromMinutes(m), c.vetId)}
                  onDragOver={(e) => {
                    if (!drag.current) return
                    e.preventDefault()
                    setHover(k)
                  }}
                  onDragLeave={() => setHover((h) => (h === k ? null : h))}
                  onDrop={(e) => {
                    e.preventDefault()
                    setHover(null)
                    const d = drag.current
                    drag.current = null
                    if (!d) return
                    if (d.kind === 'resize') {
                      const sp = istanbulParts(d.a.startsAt)
                      if (c.date !== d.a.date || c.vetId !== d.a.vetId) return
                      const end = m + slot
                      if (end - sp.minutes >= 5) onDrop(d.a, d.a.date, sp.minutes, end, d.a.vetId)
                    } else {
                      const start = Math.max(r0, m - Math.floor(d.grabOffsetMin / slot) * slot)
                      onDrop(d.a, c.date, start, start + d.a.durationMinutes, c.vetId ?? d.a.vetId)
                    }
                  }}
                  style={{
                    position: 'absolute', left: 0, right: 0, top: (m - r0) * PX_PER_MIN, height: slot * PX_PER_MIN,
                    background: hover === k ? 'var(--sel)' : off ? 'rgba(207,202,192,.45)' : undefined,
                    cursor: canWrite ? 'pointer' : undefined,
                  }}
                />
              )
            })}
            {!closed && bs !== null && be !== null && (
              <div
                className="mut"
                style={{
                  position: 'absolute', left: 0, right: 0, top: (bs - r0) * PX_PER_MIN, height: (be - bs) * PX_PER_MIN, pointerEvents: 'none',
                  background: 'repeating-linear-gradient(135deg, #F2F0EB 0 6px, #ECE9E3 6px 12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                }}
              >
                Öğle arası
              </div>
            )}
            {closed && (
              <div className="mut" style={{ position: 'absolute', top: 8, left: 0, right: 0, textAlign: 'center', fontSize: 12, pointerEvents: 'none' }}>
                {holidays.get(c.date) ?? 'Kapalı'}
              </div>
            )}
            {c.items.map((a) => {
              const sp = istanbulParts(a.startsAt)
              const top = (Math.max(sp.minutes, r0) - r0) * PX_PER_MIN
              const h = Math.max(a.durationMinutes * PX_PER_MIN, 20)
              const l = lay.get(a.id) ?? { lane: 0, lanes: 1 }
              const movable = canWrite && (a.status === 'planned' || a.status === 'confirmed')
              const dim = a.status === 'no_show' || a.status === 'done'
              return (
                <div
                  key={a.id}
                  draggable={movable}
                  onDragStart={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    drag.current = { a, kind: 'move', grabOffsetMin: (e.clientY - rect.top) / PX_PER_MIN }
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', a.id)
                  }}
                  onDragEnd={() => {
                    drag.current = null
                    setHover(null)
                  }}
                  style={{
                    position: 'absolute',
                    top,
                    height: h,
                    left: `calc(${(100 / l.lanes) * l.lane}% + 3px)`,
                    width: `calc(${100 / l.lanes}% - 6px)`,
                    border: `1px ${a.walkIn ? 'dashed' : 'solid'} ${a.typeColor ?? '#8FA9D3'}`,
                    background: tint(a.typeColor),
                    borderRadius: 2,
                    fontSize: 12,
                    lineHeight: 1.3,
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                    opacity: dim ? 0.65 : 1,
                    outline: a.status === 'in_exam' ? '2px solid var(--accent)' : a.overlap ? '1px solid var(--amb-line)' : undefined,
                    outlineOffset: -1,
                    cursor: movable ? 'grab' : 'pointer',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(a)}
                    style={{ all: 'unset', display: 'block', padding: '3px 6px', width: '100%', height: '100%', boxSizing: 'border-box', cursor: 'inherit', textDecoration: a.status === 'no_show' ? 'line-through' : undefined }}
                    aria-label={`${a.time} ${a.animalName}, ${APPOINTMENT_STATUS_LABEL[a.status]}`}
                  >
                    <strong>{a.time} {a.animalName}</strong>
                    {!compact && <> - {a.reason || a.typeName}</>}
                    {a.status !== 'planned' && <> - <span className={APPOINTMENT_STATUS_CLASS[a.status]}>{APPOINTMENT_STATUS_LABEL[a.status].toLocaleLowerCase('tr-TR')}</span></>}
                    {a.overlap && <> - <span className="s-amb">çift kayıt</span></>}
                    {compact && a.vetName && <div className="mut">{shortName(a.vetName)}</div>}
                    {!compact && h >= 50 && <div className="mut">{[a.ownerName, formatTrPhone(a.ownerPhone)].filter(Boolean).join(' - ')}</div>}
                  </button>
                  {movable && (
                    <div
                      draggable
                      title="Süreyi uzatmak için sürükleyin"
                      onDragStart={(e) => {
                        e.stopPropagation()
                        drag.current = { a, kind: 'resize', grabOffsetMin: 0 }
                        e.dataTransfer.setData('text/plain', a.id)
                      }}
                      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 5, cursor: 'ns-resize' }}
                    />
                  )}
                </div>
              )
            })}
            {isToday && nowP.minutes >= r0 && nowP.minutes <= r1 && (
              <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: (nowP.minutes - r0) * PX_PER_MIN, borderTop: '2px solid var(--red)', pointerEvents: 'none' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- Randevu takvimi ---------- */

type View = 'day' | 'week' | 'list'

export function AppointmentsPage() {
  const [params, setParams] = useSearchParams()
  const can = useCan()
  const canWrite = can('appointments.write')
  const qc = useQueryClient()
  const toast = useToast()
  const today = todayIstanbul()
  const [date, setDate] = useState(params.get('tarih') ?? today)
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem('pk.appt.view') as View) || 'day'
    } catch {
      return 'day'
    }
  })
  const [hiddenVets, setHiddenVets] = useState<Set<string>>(new Set())
  const [form, setForm] = useState<{ edit: AppointmentDto | null; preset: FormPreset } | null>(null)
  const [sel, setSel] = useState<AppointmentDto | null>(null)
  const [cancelA, setCancelA] = useState<AppointmentDto | null>(null)
  const [pendingMove, setPendingMove] = useState<{ a: AppointmentDto; date: string; start: number; end: number; vetId: string } | null>(null)
  const cfgQ = useConfig()
  const cfg = cfgQ.data

  // ?yeni=1&animal=ID&tarih=YYYY-MM-DD -> ön doldurmalı form
  useEffect(() => {
    if (params.get('yeni') === '1') {
      setForm({ edit: null, preset: { animalId: params.get('animal') ?? undefined, date: params.get('tarih') ?? undefined } })
      setParams({}, { replace: true })
    }
  }, [params, setParams])
  useEffect(() => {
    try {
      localStorage.setItem('pk.appt.view', view)
    } catch {
      /* yok say */
    }
  }, [view])

  const from = view === 'day' ? date : mondayOf(date)
  const to = view === 'day' ? date : addDaysIso(from, 6)
  const listQ = useQuery({
    queryKey: ['appointments', from, to],
    queryFn: () => api.get<AppointmentDto[]>('/api/appointments' + qs({ from, to })),
    refetchInterval: 30_000,
  })
  const all = listQ.data ?? []
  const visible = all.filter((a) => !a.vetId || !hiddenVets.has(a.vetId))
  const onGrid = visible.filter((a) => a.status !== 'cancelled')

  const range = useMemo<[number, number]>(() => {
    const open = cfg?.workHours.filter((w) => !w.closed) ?? []
    let r0 = open.length ? Math.min(...open.map((w) => toMinutes(w.open))) : 9 * 60
    let r1 = open.length ? Math.max(...open.map((w) => toMinutes(w.close))) : 18 * 60
    for (const a of onGrid) {
      const s = istanbulParts(a.startsAt).minutes
      r0 = Math.min(r0, Math.floor(s / 60) * 60)
      if (a.date === istanbulParts(a.endsAt).date) r1 = Math.max(r1, Math.ceil(istanbulParts(a.endsAt).minutes / 60) * 60)
    }
    return [r0, r1]
  }, [cfg, onGrid])

  const shift = (n: number) => setDate(addDaysIso(date, view === 'day' ? n : n * 7))
  const vets = (cfg?.vets ?? []).filter((v) => !hiddenVets.has(v.id))

  const columns: Column[] =
    view === 'day'
      ? [
          ...vets.map((v) => {
            const items = onGrid.filter((a) => a.vetId === v.id)
            return { key: v.id, title: <>{v.fullName} <span className="mut" style={{ fontWeight: 400, marginLeft: 6 }}>- {items.length} randevu</span></>, date, vetId: v.id, items }
          }),
          ...(onGrid.some((a) => !a.vetId) ? [{ key: 'none', title: <span className="s-amb">Hekim seçilmedi</span>, date, vetId: null, items: onGrid.filter((a) => !a.vetId) }] : []),
        ]
      : Array.from({ length: 7 }, (_, i) => {
          const d = addDaysIso(from, i)
          const items = onGrid.filter((a) => a.date === d)
          return {
            key: d,
            title: (
              <button type="button" style={{ all: 'unset', cursor: 'pointer', color: d === today ? 'var(--accent)' : undefined }} onClick={() => { setDate(d); setView('day') }}>
                {DAYS_SHORT[weekdayOf(d)]} {formatDateTr(d).slice(0, 5)} <span className="mut" style={{ fontWeight: 400 }}>- {items.length}</span>
              </button>
            ),
            date: d,
            vetId: null,
            items,
          }
        })

  async function doMove(m: NonNullable<typeof pendingMove>, notifyOwner: boolean) {
    setPendingMove(null)
    try {
      const r = await api.patch<AppointmentSaveResult>(`/api/appointments/${m.a.id}/move`, {
        startsAt: istanbulIso(m.date, fromMinutes(m.start)),
        endsAt: istanbulIso(m.date, fromMinutes(m.end)),
        vetId: m.vetId,
        version: m.a.version,
        notifyOwner,
      })
      toast(`Randevu taşındı: ${formatDateTr(m.date)} ${fromMinutes(m.start)}.${r.warnings.length ? ' Uyarı: ' + warnText(r.warnings) : ''}`)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
    qc.invalidateQueries()
  }

  function onDrop(a: AppointmentDto, d: string, start: number, end: number, vetId: string | null) {
    const v = vetId ?? a.vetId
    if (!v) return toast('Önce randevuya hekim atayın.', 'err')
    const sp = istanbulParts(a.startsAt)
    if (d === a.date && start === sp.minutes && end === sp.minutes + a.durationMinutes && v === a.vetId) return
    const m = { a, date: d, start, end, vetId: v }
    const timeChanged = d !== a.date || start !== sp.minutes
    if (a.ownerId && timeChanged) setPendingMove(m)
    else void doMove(m, false)
  }

  const vetName = (id: string) => cfg?.vets.find((v) => v.id === id)?.fullName ?? ''
  const holidaySet = useMemo(() => new Set((cfg?.holidays ?? []).map((h) => h.date)), [cfg])

  return (
    <>
      <div className="page-head" style={{ alignItems: 'center', gap: 8 }}>
        <h1 style={{ marginRight: 8 }}>Randevular</h1>
        <button type="button" className="btn" aria-label={view === 'day' ? 'Önceki gün' : 'Önceki hafta'} onClick={() => shift(-1)}>‹</button>
        <button type="button" className="btn" onClick={() => setDate(today)}>Bugün</button>
        <button type="button" className="btn" aria-label={view === 'day' ? 'Sonraki gün' : 'Sonraki hafta'} onClick={() => shift(1)}>›</button>
        <strong style={{ fontSize: 14, marginLeft: 6 }}>
          {view === 'day' ? longDate(date) : `${formatDateTr(from)} - ${formatDateTr(to)}`}
        </strong>
        {cfg?.holidays.find((h) => h.date === date) && view === 'day' && <span className="tag s-amb">{cfg.holidays.find((h) => h.date === date)!.name}</span>}
        <div className="right">
          <div role="group" aria-label="Görünüm" style={{ display: 'inline-flex', border: '1px solid #bdb7ac', borderRadius: 3, overflow: 'hidden', background: '#fff' }}>
            {(['day', 'week', 'list'] as View[]).map((v, i) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                style={{ font: 'inherit', height: 30, padding: '0 12px', border: 0, borderLeft: i ? '1px solid #bdb7ac' : 0, background: view === v ? 'var(--ink)' : 'transparent', color: view === v ? '#fff' : 'var(--ink-2)', cursor: 'pointer' }}
              >
                {v === 'day' ? 'Gün' : v === 'week' ? 'Hafta' : 'Liste'}
              </button>
            ))}
          </div>
          <Link to="/bekleme" className="btn">Bekleme salonu</Link>
          {canWrite && cfg && <button type="button" className="btn p" onClick={() => setForm({ edit: null, preset: { date } })}>Yeni randevu</button>}
        </div>
      </div>
      {(cfgQ.isError || listQ.isError) && <div className="alert">{((cfgQ.error ?? listQ.error) as Error).message}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <aside style={{ flex: '0 1 220px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 200 }}>
          <MiniMonth value={date} onPick={setDate} holidays={holidaySet} />
          <section className="pnl">
            <div className="ph"><h2>Hekimler</h2></div>
            <div style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column' }}>
              {cfg?.vets.map((v) => (
                <label key={v.id} className="ck">
                  <input
                    type="checkbox"
                    checked={!hiddenVets.has(v.id)}
                    onChange={(e) => {
                      const n = new Set(hiddenVets)
                      if (e.target.checked) n.delete(v.id)
                      else n.add(v.id)
                      setHiddenVets(n)
                    }}
                  />
                  {v.fullName}
                </label>
              ))}
            </div>
          </section>
          <section className="pnl">
            <div className="ph"><h2>Randevu türleri</h2></div>
            <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {cfg?.types.filter((t) => t.active).map((t) => (
                <span key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 12, height: 12, border: `1px solid ${t.color}`, background: tint(t.color) }} />
                  {t.name} - {t.defaultMinutes} dk
                </span>
              ))}
              <span className="mut" style={{ fontSize: 12 }}>Kesik çerçeve: randevusuz gelen</span>
            </div>
          </section>
        </aside>

        <section className="pnl" style={{ flex: '999 1 560px', minWidth: 0, overflowX: 'auto' }}>
          {!cfg ? (
            <div className="empty">Yükleniyor...</div>
          ) : view === 'list' ? (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr><th>Tarih</th><th style={{ width: 56 }}>Saat</th><th>Hasta</th><th>Sahip</th><th>Tür / neden</th><th>Hekim</th><th>Durum</th></tr>
                </thead>
                <tbody>
                  {visible.map((a) => (
                    <tr key={a.id} className="click" tabIndex={0} onClick={() => setSel(a)} onKeyDown={(e) => e.key === 'Enter' && setSel(a)}>
                      <td className="mono">{formatDateTr(a.date)} <span className="mut">{DAYS_SHORT[weekdayOf(a.date)]}</span></td>
                      <td className="mono">{a.time}</td>
                      <td><strong>{a.animalName}</strong> <PatientTags a={a} /></td>
                      <td>{a.ownerName}<div className="mut mono">{formatTrPhone(a.ownerPhone)}</div></td>
                      <td>
                        <span style={{ display: 'inline-block', width: 10, height: 10, marginRight: 6, border: `1px solid ${a.typeColor ?? '#8FA9D3'}`, background: tint(a.typeColor) }} />
                        {a.typeName}{a.reason && <span className="mut"> - {a.reason}</span>}
                      </td>
                      <td>{a.vetName ?? <span className="s-amb">-</span>}</td>
                      <td><StatusBadge a={a} />{a.overlap && <span className="tag s-amb" style={{ marginLeft: 6 }}>Çift</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {listQ.data && visible.length === 0 && <div className="empty">Bu hafta randevu yok.</div>}
            </div>
          ) : columns.length === 0 ? (
            <div className="empty">Gösterilecek hekim yok. Soldan en az bir hekim seçin.</div>
          ) : (
            <TimeGrid
              cfg={cfg}
              columns={columns}
              range={range}
              compact={view === 'week'}
              canWrite={canWrite}
              onSlot={(d, time, vetId) => setForm({ edit: null, preset: { date: d, time, vetId: vetId ?? undefined } })}
              onOpen={setSel}
              onDrop={onDrop}
            />
          )}
        </section>
      </div>

      {sel && (
        <SummaryDialog
          a={all.find((x) => x.id === sel.id) ?? sel}
          onClose={() => setSel(null)}
          onEdit={() => {
            setForm({ edit: all.find((x) => x.id === sel.id) ?? sel, preset: {} })
            setSel(null)
          }}
          onCancel={() => {
            setCancelA(all.find((x) => x.id === sel.id) ?? sel)
            setSel(null)
          }}
        />
      )}
      {form && cfg && <AppointmentForm cfg={cfg} edit={form.edit} preset={form.preset} onClose={() => setForm(null)} />}
      {cancelA && <CancelDialog a={cancelA} onClose={() => setCancelA(null)} />}
      {pendingMove && (
        <Modal title="Randevuyu taşı" onClose={() => setPendingMove(null)} width={460}>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>
              <strong>{pendingMove.a.animalName}</strong>: {formatDateTr(pendingMove.a.date)} {pendingMove.a.time} ->{' '}
              <strong>{formatDateTr(pendingMove.date)} {fromMinutes(pendingMove.start)}</strong>
              {pendingMove.vetId !== pendingMove.a.vetId && <> - {vetName(pendingMove.vetId)}</>}
            </span>
            <span>Sahibe değişiklik mesajı gönderilsin mi?</span>
          </div>
          <div className="form-foot">
            <button type="button" className="btn" onClick={() => setPendingMove(null)}>Vazgeç</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => doMove(pendingMove, false)}>Göndermeden taşı</button>
              <button type="button" className="btn p" onClick={() => doMove(pendingMove, true)} autoFocus>Mesaj gönder ve taşı</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/* ---------- Bekleme salonu ---------- */

type LaneKey = 'waiting' | 'arrived' | 'in_exam' | 'done' | 'no_show'
const LANES: { key: LaneKey; title: string; target: AppointmentStatus; statuses: AppointmentStatus[] }[] = [
  { key: 'waiting', title: 'Bekleniyor', target: 'planned', statuses: ['planned', 'confirmed'] },
  { key: 'arrived', title: 'Geldi - bekliyor', target: 'arrived', statuses: ['arrived'] },
  { key: 'in_exam', title: 'Muayenede', target: 'in_exam', statuses: ['in_exam'] },
  { key: 'done', title: 'Tamamlandı', target: 'done', statuses: ['done'] },
  { key: 'no_show', title: 'Gelmedi', target: 'no_show', statuses: ['no_show'] },
]

function WalkInDialog({ cfg, onClose }: { cfg: AppointmentConfigDto; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [patient, setPatient] = useState<Patient | null>(null)
  const [vetId, setVetId] = useState('')
  const [typeId, setTypeId] = useState('')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!patient) return setErr('Bir hasta seçin ya da yeni hasta bilgilerini girin.')
    setBusy(true)
    try {
      const r = await api.post<AppointmentDto>('/api/appointments/walk-in', { ...patientBody(patient), vetId: vetId || null, typeId: typeId || null, reason: reason || undefined })
      qc.invalidateQueries()
      toast(`${r.animalName} bekleme salonuna eklendi.`)
      onClose()
    } catch (e2) {
      setErr((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Randevusuz hasta" onClose={onClose} width={600}>
      <form onSubmit={submit}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="f"><span className="l">Hasta *</span><PatientPicker value={patient} onChange={setPatient} /></div>
          <div className="g4" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <Field label="Hekim" htmlFor="wi-v">
              <select id="wi-v" className="inp" value={vetId} onChange={(e) => setVetId(e.target.value)}>
                <option value="">- Sonra seçilecek -</option>
                {cfg.vets.map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
              </select>
            </Field>
            <Field label="Tür" htmlFor="wi-t">
              <select id="wi-t" className="inp" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">-</option>
                {cfg.types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Şikâyet / neden" htmlFor="wi-r"><input id="wi-r" className="inp" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
          {err && <div className="alert" role="alert">{err}</div>}
        </div>
        <div className="form-foot">
          <span className="mut" style={{ fontSize: 12 }}>Hasta doğrudan "Geldi - bekliyor" sütununa eklenir.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
            <button type="submit" className="btn p" disabled={busy}>Ekle</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

function WaitCard({ a, canWrite, onDragStart, onAction, onOpen }: {
  a: AppointmentDto
  canWrite: boolean
  onDragStart: () => void
  onAction: (s: AppointmentStatus) => void
  onOpen: () => void
}) {
  const late = a.status === 'arrived' && (a.waitMinutes ?? 0) > WAIT_WARN_MINUTES
  const right =
    a.status === 'arrived' || a.status === 'in_exam' ? (
      <span className="mono" style={{ color: late ? 'var(--amb)' : undefined }}>{a.waitMinutes ?? 0} dk</span>
    ) : a.status === 'done' && a.finishedAt ? (
      <span className="mono">{istanbulParts(a.finishedAt).time}</span>
    ) : (
      <span className="mono">{a.time}</span>
    )
  const next: { s: AppointmentStatus; label: string } | null =
    a.status === 'planned' || a.status === 'confirmed' ? { s: 'arrived', label: 'Geldi' }
    : a.status === 'arrived' ? { s: 'in_exam', label: 'Muayeneye al' }
    : a.status === 'in_exam' ? { s: 'done', label: 'Tamamlandı' }
    : null
  return (
    <div
      draggable={canWrite}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', a.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      style={{
        background: '#fff',
        border: `1px solid ${late ? 'var(--amb-line)' : a.status === 'in_exam' ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 2,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        cursor: canWrite ? 'grab' : undefined,
        opacity: a.status === 'done' ? 0.8 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <button type="button" onClick={onOpen} style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}>{a.animalName}</button>
        {right}
      </div>
      <span className="mut">{[a.species ? SPECIES_LABEL[a.species] : null, a.ownerName].filter(Boolean).join(' - ')}</span>
      <span>
        {a.walkIn ? 'Randevusuz' : a.typeName}{a.reason && ` - ${a.reason}`}{a.vetName && ` - ${shortName(a.vetName)}`}
        {a.status === 'in_exam' && a.room && ` - ${a.room}`}
        {a.status === 'arrived' && !a.walkIn && <> - <span className="mono">{a.time}</span></>}
      </span>
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <PatientTags a={a} />
        {!a.vetId && a.status !== 'no_show' && <span className="tag s-amb">Hekim seçilmedi</span>}
      </span>
      {a.suggestNoShow && canWrite && (
        <span className="s-amb" style={{ fontSize: 12 }}>
          30 dk geçti - <button type="button" className="btn sm" onClick={() => onAction('no_show')}>Gelmedi</button>
        </span>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {canWrite && next && <button type="button" className="btn sm" onClick={() => onAction(next.s)}>{next.label}</button>}
        {(a.status === 'in_exam' || a.status === 'arrived') && a.animalId && (
          <Link to={`/muayene/yeni?animal=${a.animalId}&appointment=${a.id}`} style={{ fontSize: 12 }}>Muayeneyi aç</Link>
        )}
        {a.status === 'no_show' && a.animalId && <Link to={`/randevular?yeni=1&animal=${a.animalId}`} style={{ fontSize: 12 }}>Yeniden randevu</Link>}
      </div>
    </div>
  )
}

export function WaitingRoomPage() {
  const can = useCan()
  const canWrite = can('appointments.write')
  const run = useStatusAction()
  const toast = useToast()
  const cfgQ = useConfig()
  const q = useQuery({ queryKey: ['waiting-room'], queryFn: () => api.get<WaitingRoomDto>('/api/waiting-room'), refetchInterval: 5000 })
  const dragged = useRef<AppointmentDto | null>(null)
  const [over, setOver] = useState<LaneKey | null>(null)
  const [walkIn, setWalkIn] = useState(false)
  const [examFor, setExamFor] = useState<AppointmentDto | null>(null)
  const [room, setRoom] = useState('')
  const [sel, setSel] = useState<AppointmentDto | null>(null)
  const [edit, setEdit] = useState<AppointmentDto | null>(null)
  const [cancelA, setCancelA] = useState<AppointmentDto | null>(null)
  const items = q.data?.items ?? []

  async function change(a: AppointmentDto, s: AppointmentStatus) {
    if (a.status === s || (s === 'planned' && a.status === 'confirmed')) return
    if (!canTransition(a.status, s)) {
      toast(`"${APPOINTMENT_STATUS_LABEL[a.status]}" durumundaki randevu "${APPOINTMENT_STATUS_LABEL[s]}" yapılamaz.`, 'err')
      return
    }
    if (s === 'in_exam') {
      setRoom(a.room ?? '')
      setExamFor(a)
      return
    }
    await run(a, s)
  }

  const counts = { waiting: 0, arrived: 0 }
  for (const a of items) {
    if (a.status === 'planned' || a.status === 'confirmed') counts.waiting++
    if (a.status === 'arrived') counts.arrived++
  }

  return (
    <>
      <div className="page-head">
        <h1>Bekleme salonu</h1>
        <span className="mut">Kartı sürükleyerek durumu değiştirin - tüm bilgisayarlarda anlık güncellenir</span>
        <div className="right">
          <Link to="/randevular" className="btn">Takvim</Link>
          {canWrite && <button type="button" className="btn p" onClick={() => setWalkIn(true)} disabled={!cfgQ.data}>+ Randevusuz hasta</button>}
        </div>
      </div>
      {q.isError && <div className="alert">{(q.error as Error).message}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
        {LANES.map((lane) => {
          const list = items
            .filter((a) => lane.statuses.includes(a.status))
            .sort((x, y) =>
              lane.key === 'done' ? (y.finishedAt ?? '').localeCompare(x.finishedAt ?? '') : lane.key === 'arrived' ? (x.arrivedAt ?? '').localeCompare(y.arrivedAt ?? '') : x.startsAt.localeCompare(y.startsAt),
            )
          return (
            <section
              key={lane.key}
              aria-label={lane.title}
              onDragOver={(e) => {
                if (!dragged.current) return
                e.preventDefault()
                setOver(lane.key)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === lane.key ? null : o))
              }}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const a = dragged.current
                dragged.current = null
                if (a) void change(a, lane.target)
              }}
              style={{
                flex: lane.key === 'no_show' ? '1 1 160px' : '1 1 220px',
                minWidth: 0,
                background: over === lane.key ? 'var(--sel)' : 'var(--side)',
                border: '1px solid var(--line)',
                borderRadius: 3,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 10px', height: 34, fontWeight: 600, borderBottom: '1px solid var(--line)' }}>
                <span>{lane.title}</span>
                <span className="mono mut">{list.length}</span>
              </div>
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 520 }}>
                {list.map((a) => (
                  <WaitCard
                    key={a.id}
                    a={a}
                    canWrite={canWrite}
                    onDragStart={() => (dragged.current = a)}
                    onAction={(s) => change(a, s)}
                    onOpen={() => setSel(a)}
                  />
                ))}
                {q.data && list.length === 0 && <span className="mut" style={{ fontSize: 12, textAlign: 'center', padding: 12 }}>-</span>}
              </div>
            </section>
          )
        })}
      </div>

      {walkIn && cfgQ.data && <WalkInDialog cfg={cfgQ.data} onClose={() => setWalkIn(false)} />}
      {examFor && (
        <Modal title={`Muayeneye al - ${examFor.animalName}`} onClose={() => setExamFor(null)} width={420}>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              const a = examFor
              setExamFor(null)
              await run(a, 'in_exam', { room: room.trim() || undefined })
            }}
          >
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Field label="Oda" htmlFor="ex-room"><input id="ex-room" className="inp" maxLength={20} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="ör. Oda 2" autoFocus /></Field>
              {examFor.animalId ? (
                <span className="mut" style={{ fontSize: 12 }}>Kaydettikten sonra hekim kartındaki "Muayeneyi aç" bağlantısıyla muayeneyi başlatabilir.</span>
              ) : (
                <span className="s-amb" style={{ fontSize: 12 }}>Kayıtsız hasta: muayene açmadan önce hayvan kaydı oluşturun.</span>
              )}
            </div>
            <div className="form-foot">
              <span />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setExamFor(null)}>Vazgeç</button>
                <button type="submit" className="btn p">Muayeneye al</button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {sel && (
        <SummaryDialog
          a={items.find((x) => x.id === sel.id) ?? sel}
          onClose={() => setSel(null)}
          onEdit={() => {
            setEdit(items.find((x) => x.id === sel.id) ?? sel)
            setSel(null)
          }}
          onCancel={() => {
            setCancelA(items.find((x) => x.id === sel.id) ?? sel)
            setSel(null)
          }}
        />
      )}
      {edit && cfgQ.data && <AppointmentForm cfg={cfgQ.data} edit={edit} preset={{}} onClose={() => setEdit(null)} />}
      {cancelA && <CancelDialog a={cancelA} onClose={() => setCancelA(null)} />}
    </>
  )
}

/* ---------- Bugün ekranı: bugünkü randevular ---------- */

const PANEL_ORDER: Record<AppointmentStatus, number> = { in_exam: 0, arrived: 1, planned: 2, confirmed: 2, done: 3, no_show: 4, cancelled: 5 }

export function TodayAppointmentsPanel({ animalId }: { animalId?: string } = {}) {
  const can = useCan()
  const run = useStatusAction()
  const today = todayIstanbul()
  const q = useQuery({
    queryKey: ['appointments', 'today-panel', today, animalId ?? ''],
    queryFn: () =>
      api.get<AppointmentDto[]>('/api/appointments' + qs(animalId ? { animalId, from: today, to: addDaysIso(today, 90) } : { from: today, to: today })),
    refetchInterval: 30_000,
    enabled: can('appointments.read'),
  })
  if (!can('appointments.read')) return null
  const all = (q.data ?? []).filter((a) => a.status !== 'cancelled')
  // Gelen hastalar üstte, sonra saat sırası
  const rows = animalId ? all : [...all].sort((x, y) => PANEL_ORDER[x.status] - PANEL_ORDER[y.status] || x.startsAt.localeCompare(y.startsAt))
  const shown = rows.slice(0, 8)
  const waiting = all.filter((a) => a.status === 'arrived').length

  return (
    <section className="pnl">
      <div className="ph">
        <h2>
          {animalId ? 'Yaklaşan randevular' : 'Randevular'}
          {!animalId && q.data && <span className="mut" style={{ fontWeight: 400, marginLeft: 8 }}>{all.length} randevu - {waiting} kişi bekliyor</span>}
        </h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <Link to="/bekleme" className="btn" style={{ height: 26, fontSize: 12 }}>Bekleme salonu</Link>
          <Link to="/randevular" className="btn" style={{ height: 26, fontSize: 12 }}>Takvim</Link>
          {animalId && can('appointments.write') && <Link to={`/randevular?yeni=1&animal=${animalId}`} className="btn" style={{ height: 26, fontSize: 12 }}>Randevu ver</Link>}
        </div>
      </div>
      {q.isError && <div className="alert">{(q.error as Error).message}</div>}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 56 }}>{animalId ? 'Tarih' : 'Saat'}</th>
              <th>Hasta</th>
              <th>Sahip</th>
              <th>Neden</th>
              <th>Hekim</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id} className={a.status === 'in_exam' ? 'hot' : undefined}>
                <td className="mono">{animalId ? <>{formatDateTr(a.date).slice(0, 5)} {a.time}</> : a.time}</td>
                <td>
                  {a.animalId ? <Link to={`/hayvanlar/${a.animalId}`} style={{ color: 'inherit', textDecoration: 'none' }}><strong>{a.animalName}</strong></Link> : <strong>{a.animalName}</strong>}{' '}
                  <PatientTags a={a} />
                  <div className="mut">
                    {[a.species ? SPECIES_LABEL[a.species] : null, a.breed].filter(Boolean).join(' - ')}
                    {a.animalId && !a.chipNo && <> - <span className="s-red">çipsiz</span></>}
                  </div>
                </td>
                <td>{a.ownerName}</td>
                <td>{a.reason || a.typeName}</td>
                <td>{shortName(a.vetName) || <span className="s-amb">-</span>}</td>
                <td>
                  <StatusBadge a={a} />
                  {can('appointments.write') && (a.status === 'planned' || a.status === 'confirmed') && a.date === today && (
                    <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={() => run(a, 'arrived')}>Geldi</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data && rows.length === 0 && (
          <div className="empty">
            {animalId ? 'Yaklaşan randevu yok.' : 'Bugün randevu yok.'}{' '}
            {can('appointments.write') && <Link to={animalId ? `/randevular?yeni=1&animal=${animalId}` : '/randevular?yeni=1'}>Yeni randevu</Link>}
          </div>
        )}
      </div>
      {rows.length > shown.length && (
        <div className="tfoot mut" style={{ fontSize: 12 }}>
          {shown.length} / {rows.length} gösteriliyor - <Link to="/randevular">tümü</Link>
        </div>
      )}
    </section>
  )
}
