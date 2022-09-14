// Modül B — S-30 Hayvan listesi, S-32 Hayvan formu, S-33 Hayvan detayı, S-34 durum diyalogları, S-35/S-36 çip işlemleri
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError, qs } from '../api'
import { useCan, useSession } from '../session'
import { ChipNo, Field, PetvetState, age, kindLabel, urgencyText, useToast } from '../ui'
import { Attachments } from '../components/Attachments'
import { openPrint } from '../print'
import { AnimalTreatmentsTab, AnimalVisitsTab } from './Visits'
import { AnimalVaccinesTab } from './Vaccines'
import { DropMenu, HistoryTable, Modal, OwnerPicker, Tabs, fmtDT, useFormKeys } from './Owners'
import { formatChip, validateChip } from '@shared/chip'
import { formatTrPhone, normalizeTrMobile } from '@shared/identity'
import { diffDaysIso, formatDateTr, todayIstanbul } from '@shared/petvet'
import { BODY_SITES, PETVET_SPECIES, SEX_LABEL, SPECIES_LABEL, type Sex, type Species, type UserDto } from '@shared/api-types'
import {
  ANIMAL_SOURCES,
  ANIMAL_STATUS_LABEL,
  BEHAVIORS,
  BEHAVIOR_LABEL,
  BLOOD_GROUPS,
  CITIES,
  DEATH_CAUSES,
  DEATH_CAUSE_LABEL,
  SOURCE_LABEL,
  type AnimalDetailFull,
  type AnimalListRow,
  type AnimalSource,
  type Behavior,
  type ChipActionResult,
  type ChipFullDto,
  type DeathCause,
  type HistoryRow,
  type OwnershipRow,
  type StatusResult,
  type TimelineRow,
  type WeightRow,
} from '@shared/owners'

const statusClass = (s: string) => (s === 'active' ? 's-ok' : s === 'lost' ? 's-red' : 's-gry')
const kg = (n: number) => n.toLocaleString('tr-TR', { maximumFractionDigits: 2 })

function petvetToast(r: StatusResult, base: string) {
  if (!r.petvetKind) return base
  if (r.petvetStatus === 'missing_info') return `${base} PETVET görevi (${kindLabel(r.petvetKind)}) açıldı ama sahibin TCKN'si eksik.`
  return `${base} PETVET görevi (${kindLabel(r.petvetKind)}) açıldı; son gün ${formatDateTr(r.dueDate)}.`
}

function WarnTags({ allergies, behavior, chronic }: { allergies: string[]; behavior: string | null; chronic?: string[] }) {
  return (
    <>
      {allergies.map((x) => <span key={x} className="tag s-red">{x} alerjisi</span>)}
      {chronic?.map((x) => <span key={x} className="tag s-amb">{x}</span>)}
      {behavior && <span className={`tag ${behavior === 'shy' ? 's-gry' : 's-amb'}`}>{BEHAVIOR_LABEL[behavior as Behavior] ?? behavior}</span>}
    </>
  )
}

/* ================= S-30 Hayvan listesi ================= */

const PAGE = 50

export function AnimalsPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const can = useCan()
  const q = params.get('q') ?? ''
  const status = params.get('durum') ?? 'active'
  const species = params.get('tur') ?? ''
  const chip = params.get('cip') ?? (params.get('cipsiz') === '1' ? 'no' : '')
  const risk6m = params.get('risk') === '1'
  const petvet = params.get('petvet') ?? ''
  const offset = Number(params.get('s') ?? 0) || 0
  const [text, setText] = useState(q)
  useEffect(() => setText(q), [q])

  const query = qs({ q, status, species, chip, risk6m: risk6m ? '1' : undefined, petvet, offset, limit: PAGE })
  const list = useQuery({ queryKey: ['animals', query], queryFn: () => api.get<AnimalListRow[]>('/api/animals' + query) })

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v)
    else p.delete(k)
    if (k === 'cip') p.delete('cipsiz')
    if (k !== 's') p.delete('s')
    setParams(p)
  }
  const n = list.data?.length ?? 0

  return (
    <>
      <div className="page-head">
        <h1>Hayvanlar</h1>
        {list.data && <span className="mut">{offset + n} kayıt{n === PAGE ? '+' : ''}</span>}
        <div className="right">
          {can('chips.implant') && <Link to="/kayit" className="btn">Hızlı kayıt (çipli)</Link>}
          {can('animals.write') && <Link to="/hayvanlar/yeni" className="btn p">Yeni hayvan</Link>}
        </div>
      </div>
      <form
        className="pnl"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px' }}
        onSubmit={(e) => {
          e.preventDefault()
          setParam('q', text.trim() || null)
        }}
      >
        <input className="inp" style={{ width: 280 }} placeholder="Ad, sahip, telefon, çip, pasaport" aria-label="Ara" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn">Ara</button>
        <select className="inp" style={{ width: 120 }} aria-label="Tür" value={species} onChange={(e) => setParam('tur', e.target.value || null)}>
          <option value="">Tüm türler</option>
          {Object.entries(SPECIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="inp" style={{ width: 110 }} aria-label="Durum" value={status} onChange={(e) => setParam('durum', e.target.value)}>
          <option value="active">Aktif</option>
          <option value="lost">Kayıp</option>
          <option value="dead">Ölü</option>
          <option value="all">Tümü</option>
        </select>
        <select className="inp" style={{ width: 120 }} aria-label="Çip" value={chip} onChange={(e) => setParam('cip', e.target.value || null)}>
          <option value="">Çipli / çipsiz</option>
          <option value="yes">Çipli</option>
          <option value="no">Çipsiz</option>
        </select>
        <label className="ck"><input type="checkbox" checked={risk6m} onChange={(e) => setParam('risk', e.target.checked ? '1' : null)} />6 aydan büyük ve çipsiz</label>
        <label className="ck"><input type="checkbox" checked={petvet === 'open'} onChange={(e) => setParam('petvet', e.target.checked ? 'open' : null)} />PETVET bekleyen</label>
      </form>
      {risk6m && <div className="alert amb">Yasal risk listesi: 6 aylıktan büyük olup çipi kayıtlı olmayan hayvanlar. ⚠️ Yaş sınırı pilot hekimle doğrulanacak.</div>}
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Ad</th><th>Tür / ırk</th><th>Sahip</th><th>Yaş</th><th>Cinsiyet</th><th>Çip</th><th>Pasaport</th><th>Durum</th><th>Son ziyaret</th><th>PETVET</th></tr>
            </thead>
            <tbody>
              {list.data?.map((a) => (
                <tr key={a.id} className="click" onClick={() => nav(`/hayvanlar/${a.id}`)}>
                  <td>
                    <strong>{a.name}</strong>{' '}
                    {a.allergies.length > 0 && <span className="tag s-red">Alerji</span>}{' '}
                    {(a.behavior === 'aggressive' || a.behavior === 'bites') && <span className="tag s-amb">{BEHAVIOR_LABEL[a.behavior as Behavior]}</span>}
                  </td>
                  <td>{[SPECIES_LABEL[a.species], a.breed].filter(Boolean).join(' · ')}</td>
                  <td>{a.ownerName}<div className="mono mut" style={{ fontSize: 12 }}>{formatTrPhone(a.ownerPhone)}</div></td>
                  <td>{age(a.birthDate)}</td>
                  <td>{SEX_LABEL[a.sex]}{a.neutered ? ', kısır' : ''}</td>
                  <td><ChipNo value={a.chipNo} /></td>
                  <td className="mono">{a.passportNo ?? ''}</td>
                  <td><span className={`st ${statusClass(a.status)}`}>{ANIMAL_STATUS_LABEL[a.status] ?? a.status}</span></td>
                  <td className="mono">{formatDateTr(a.lastVisit) || <span className="mut">—</span>}</td>
                  <td>{a.petvet ? <PetvetState {...a.petvet} /> : <span className="mut">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.isLoading && <div className="empty">Yükleniyor…</div>}
          {list.data?.length === 0 && (
            <div className="empty">
              {q ? `"${q}" için kayıt bulunamadı.` : 'Bu filtrelerle kayıt yok.'} {can('animals.write') && <Link to="/hayvanlar/yeni">Yeni hayvan ekle</Link>}
            </div>
          )}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{(list.error as Error).message}</div>}
        </div>
        {(offset > 0 || n === PAGE) && (
          <div className="tfoot">
            <button className="btn sm" disabled={offset === 0} onClick={() => setParam('s', offset - PAGE > 0 ? String(offset - PAGE) : null)}>Önceki</button>
            <button className="btn sm" disabled={n < PAGE} onClick={() => setParam('s', String(offset + PAGE))}>Sonraki</button>
          </div>
        )}
      </section>
    </>
  )
}

/* ================= S-32 Hayvan formu ================= */

interface AnimalFormState {
  name: string
  species: Species
  breed: string
  sex: Sex | ''
  neutered: boolean
  neuteredAt: string
  birthDate: string
  birthDateEstimated: boolean
  color: string
  marks: string
  passportNo: string
  bloodGroup: string
  allergies: string
  chronicDiseases: string
  behavior: Behavior | ''
  diet: string
  source: AnimalSource | ''
  sourceDetail: string
  notes: string
  weightKg: string
}

const emptyAnimal: AnimalFormState = {
  name: '', species: 'cat', breed: '', sex: '', neutered: false, neuteredAt: '', birthDate: '', birthDateEstimated: false, color: '', marks: '',
  passportNo: '', bloodGroup: '', allergies: '', chronicDiseases: '', behavior: '', diet: '', source: '', sourceDetail: '', notes: '', weightKg: '',
}

const splitTags = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function useBreeds(species: string) {
  return useQuery({
    queryKey: ['dictionaries', 'breed', species],
    queryFn: async () => {
      try {
        const r = await api.get<({ value?: string; label?: string; name?: string } | string)[]>('/api/dictionaries/breed' + qs({ species }))
        return r.map((x) => (typeof x === 'string' ? x : (x.label ?? x.value ?? x.name ?? ''))).filter(Boolean)
      } catch {
        return [] as string[]
      }
    },
    staleTime: 5 * 60_000,
  }).data ?? []
}

function AnimalForm({ existing }: { existing?: AnimalDetailFull }) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [params] = useSearchParams()
  const today = todayIstanbul()
  const initial = useMemo<AnimalFormState>(
    () =>
      existing
        ? {
            ...emptyAnimal,
            name: existing.name,
            species: existing.species,
            breed: existing.breed ?? '',
            sex: existing.sex,
            neutered: existing.neutered,
            neuteredAt: existing.neuteredAt ?? '',
            birthDate: existing.birthDate ?? '',
            birthDateEstimated: existing.birthDateEstimated,
            color: existing.color ?? '',
            marks: existing.marks ?? '',
            passportNo: existing.passportNo ?? '',
            bloodGroup: existing.bloodGroup ?? '',
            allergies: existing.allergies.join(', '),
            chronicDiseases: existing.chronicDiseases.join(', '),
            behavior: (existing.behavior as Behavior) ?? '',
            diet: existing.diet ?? '',
            source: (existing.source as AnimalSource) ?? '',
            sourceDetail: existing.sourceDetail ?? '',
            notes: existing.notes ?? '',
          }
        : emptyAnimal,
    [existing],
  )
  const [s, setS] = useState(initial)
  const presetOwner = params.get('sahip')
  const ownerQ = useQuery({
    queryKey: ['owner', presetOwner],
    queryFn: () => api.get<{ id: string; fullName: string; phone: string | null }>(`/api/owners/${presetOwner}`),
    enabled: !!presetOwner && !existing,
  })
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null)
  useEffect(() => {
    if (ownerQ.data && !owner) setOwner({ id: ownerQ.data.id, label: `${ownerQ.data.fullName} · ${formatTrPhone(ownerQ.data.phone)}` })
  }, [ownerQ.data, owner])
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const breeds = useBreeds(s.species)
  const dirty = JSON.stringify(s) !== JSON.stringify(initial)
  const set = <K extends keyof AnimalFormState>(k: K, v: AnimalFormState[K]) => setS((x) => ({ ...x, [k]: v }))
  const petvetSpecies = PETVET_SPECIES.includes(s.species)

  const cancel = () => {
    if (dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Çıkmak istiyor musunuz?')) return
    nav(existing ? `/hayvanlar/${existing.id}` : presetOwner ? `/sahipler/${presetOwner}` : '/hayvanlar')
  }
  useFormKeys(() => formRef.current?.requestSubmit(), cancel)

  function validate() {
    const e: Record<string, string> = {}
    if (!s.name.trim()) e.name = 'Hayvan adı gerekli.'
    if (!s.sex) e.sex = 'Cinsiyet seçin.'
    if (!s.birthDate) e.birthDate = 'Doğum tarihi gerekli (tahmini olabilir).'
    else if (s.birthDate > today) e.birthDate = 'Doğum tarihi ileri bir tarih olamaz.'
    if (petvetSpecies && !s.color.trim()) e.color = 'Kedi, köpek ve gelincikte renk / desen zorunlu.'
    if (s.source === 'adoption' && !s.sourceDetail.trim()) e.sourceDetail = 'Barınak / belediye adını yazın.'
    if (s.weightKg) {
      const w = Number(s.weightKg.replace(',', '.'))
      if (!(w >= 0.01 && w <= 150)) e.weightKg = 'Kilo 0,01–150 kg arasında olmalı.'
    }
    if (!existing && !owner) e.owner = 'Sahip seçin.'
    return e
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    setErr('')
    const v = validate()
    setErrs(v)
    if (Object.keys(v).length) return setErr('Formda düzeltilmesi gereken alanlar var.')
    setBusy(true)
    const body = {
      name: s.name,
      species: s.species,
      breed: s.breed || undefined,
      sex: s.sex,
      neutered: s.neutered,
      neuteredAt: s.neutered ? s.neuteredAt || undefined : undefined,
      birthDate: s.birthDate,
      birthDateEstimated: s.birthDateEstimated,
      color: s.color || undefined,
      marks: s.marks || undefined,
      passportNo: s.passportNo || undefined,
      bloodGroup: s.bloodGroup || undefined,
      allergies: splitTags(s.allergies),
      chronicDiseases: splitTags(s.chronicDiseases),
      behavior: s.behavior,
      diet: s.diet || undefined,
      source: s.source,
      sourceDetail: s.source === 'adoption' ? s.sourceDetail || undefined : undefined,
      notes: s.notes || undefined,
    }
    try {
      if (existing) {
        await api.put(`/api/animals/${existing.id}`, { ...body, version: existing.version })
        toast('Hayvan bilgileri güncellendi.')
        qc.invalidateQueries()
        nav(`/hayvanlar/${existing.id}`, { replace: true })
      } else {
        const r = await api.post<{ id: string }>('/api/animals', { ...body, ownerId: owner!.id, weightKg: s.weightKg ? Number(s.weightKg.replace(',', '.')) : undefined })
        toast(`${s.name} kaydedildi.${petvetSpecies ? ' Çip uygulamak için "İşlemler → Çip uygula"yı kullanın.' : ''}`)
        qc.invalidateQueries()
        nav(`/hayvanlar/${r.id}`, { replace: true })
      }
    } catch (e) {
      const he = e as HttpError
      if (he.code === 'VERSION_CONFLICT') setConflict(he.message)
      else setErr(he.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <nav className="crumb" aria-label="Konum">
        <Link to="/hayvanlar">Hayvanlar</Link> › {existing ? <><Link to={`/hayvanlar/${existing.id}`}>{existing.name}</Link> › Düzenle</> : 'Yeni hayvan'}
      </nav>
      {conflict && (
        <div className="alert" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{conflict} Değişiklikleriniz kaydedilmedi.</span>
          <button className="btn sm" onClick={() => { setConflict(null); qc.invalidateQueries({ queryKey: ['animal', existing?.id] }) }}>Yeniden yükle</button>
        </div>
      )}
      <form ref={formRef} className="pnl" onSubmit={submit} noValidate style={{ maxWidth: 1080 }}>
        <div className="ph"><h2>{existing ? 'Hayvan bilgilerini düzenle' : 'Yeni hayvan (çipsiz kayıt)'}</h2></div>
        {!existing && (
          <fieldset className="sec">
            <legend>Sahip *</legend>
            <div>
              <OwnerPicker value={owner} onChange={setOwner} id="ao" />
              {errs.owner && <span className="err">{errs.owner}</span>}
              {!owner && <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>Sahip kayıtlı değilse önce <Link to="/sahipler/yeni">yeni sahip</Link> ekleyin ("Kaydet ve hayvan ekle").</div>}
            </div>
          </fieldset>
        )}
        <fieldset className="sec">
          <legend>Kimlik</legend>
          <div className="g4">
            <Field label="Ad *" htmlFor="an" error={errs.name}><input id="an" className={`inp${errs.name ? ' bad' : ''}`} maxLength={40} value={s.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
            <Field label="Tür *" htmlFor="at">
              <select id="at" className="inp" value={s.species} onChange={(e) => set('species', e.target.value as Species)}>
                {Object.entries(SPECIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Irk" htmlFor="ab">
              <input id="ab" className="inp" list="breeds" value={s.breed} onChange={(e) => set('breed', e.target.value)} placeholder="Melez / yazın" />
              <datalist id="breeds">{['Melez', ...breeds].map((b) => <option key={b} value={b} />)}</datalist>
            </Field>
            <Field label={`Renk / desen${petvetSpecies ? ' *' : ''}`} htmlFor="ac" error={errs.color}><input id="ac" className={`inp${errs.color ? ' bad' : ''}`} value={s.color} onChange={(e) => set('color', e.target.value)} /></Field>
            <div className="f" style={{ gridColumn: 'span 2' }}>
              <span className="l">Cinsiyet *</span>
              <div className="rad" role="radiogroup" aria-label="Cinsiyet">
                {(['male', 'female', 'unknown'] as const).map((x) => (
                  <label key={x}><input type="radio" name="sex" checked={s.sex === x} onChange={() => set('sex', x)} />{SEX_LABEL[x]}</label>
                ))}
              </div>
              {errs.sex && <span className="err">{errs.sex}</span>}
            </div>
            <Field label="Doğum tarihi *" htmlFor="ad" error={errs.birthDate}><input id="ad" type="date" className={`inp${errs.birthDate ? ' bad' : ''}`} max={today} value={s.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></Field>
            <div className="f">
              <span className="l">{s.birthDate ? `Yaş: ${age(s.birthDate)}` : ' '}</span>
              <label className="ck"><input type="checkbox" checked={s.birthDateEstimated} onChange={(e) => set('birthDateEstimated', e.target.checked)} />Tahmini</label>
            </div>
            <div className="f">
              <span className="l">&nbsp;</span>
              <label className="ck"><input type="checkbox" checked={s.neutered} onChange={(e) => set('neutered', e.target.checked)} />Kısırlaştırılmış</label>
            </div>
            {s.neutered && <Field label="Kısırlaştırma tarihi" htmlFor="nt"><input id="nt" type="date" className="inp" max={today} value={s.neuteredAt} onChange={(e) => set('neuteredAt', e.target.value)} /></Field>}
            <Field label="Pasaport no" htmlFor="pp"><input id="pp" className="inp mono" maxLength={40} value={s.passportNo} onChange={(e) => set('passportNo', e.target.value)} /></Field>
            <Field label="Ayırt edici işaret" htmlFor="mk" style={{ gridColumn: 'span 2' }}><input id="mk" className="inp" value={s.marks} onChange={(e) => set('marks', e.target.value)} /></Field>
          </div>
        </fieldset>
        <fieldset className="sec">
          <legend>Sağlık ve davranış</legend>
          <div className="g4">
            <Field label="Alerjiler (virgülle)" htmlFor="al" style={{ gridColumn: 'span 2' }}><input id="al" className="inp" value={s.allergies} onChange={(e) => set('allergies', e.target.value)} placeholder="Penisilin, …" /></Field>
            <Field label="Kronik hastalıklar (virgülle)" htmlFor="kr" style={{ gridColumn: 'span 2' }}><input id="kr" className="inp" value={s.chronicDiseases} onChange={(e) => set('chronicDiseases', e.target.value)} /></Field>
            <Field label="Davranış uyarısı" htmlFor="bh">
              <select id="bh" className="inp" value={s.behavior} onChange={(e) => set('behavior', e.target.value as Behavior | '')}>
                <option value="">Yok</option>
                {BEHAVIORS.map((b) => <option key={b} value={b}>{BEHAVIOR_LABEL[b]}</option>)}
              </select>
            </Field>
            <Field label="Kan grubu" htmlFor="kg">
              <input id="kg" className="inp" list="bloods" value={s.bloodGroup} onChange={(e) => set('bloodGroup', e.target.value)} />
              <datalist id="bloods">{(BLOOD_GROUPS[s.species] ?? []).map((b) => <option key={b} value={b} />)}</datalist>
            </Field>
            {!existing && <Field label="Kilo (kg)" htmlFor="wk" error={errs.weightKg}><input id="wk" className="inp mono" inputMode="decimal" value={s.weightKg} onChange={(e) => set('weightKg', e.target.value)} /></Field>}
            <Field label="Beslenme" htmlFor="dt" style={{ gridColumn: existing ? 'span 2' : undefined }}><input id="dt" className="inp" value={s.diet} onChange={(e) => set('diet', e.target.value)} /></Field>
          </div>
        </fieldset>
        <fieldset className="sec" style={{ borderBottom: 0 }}>
          <legend>Kaynak ve not</legend>
          <div className="g4">
            <Field label="Kaynak" htmlFor="sr">
              <select id="sr" className="inp" value={s.source} onChange={(e) => set('source', e.target.value as AnimalSource | '')}>
                <option value="">—</option>
                {ANIMAL_SOURCES.map((x) => <option key={x} value={x}>{SOURCE_LABEL[x]}</option>)}
              </select>
            </Field>
            {s.source === 'adoption' && <Field label="Barınak / belediye *" htmlFor="sd" error={errs.sourceDetail}><input id="sd" className="inp" value={s.sourceDetail} onChange={(e) => set('sourceDetail', e.target.value)} /></Field>}
            <Field label="Not" htmlFor="no" style={{ gridColumn: 'span 4' }}><textarea id="no" className="inp" style={{ height: 52, paddingTop: 4 }} value={s.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          </div>
        </fieldset>
        <div className="form-foot">
          <span className="mut" style={{ fontSize: 12 }}>
            {existing ? <>Oluşturan: {existing.createdByName ?? '—'} · {fmtDT(existing.createdAt)} · Son değiştiren: {existing.updatedByName ?? '—'} · {fmtDT(existing.updatedAt)}</> : 'Fotoğraf ekleme sonraki sürümde.'}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {err && <span className="err" role="alert">{err}</span>}
            <button type="button" className="btn" onClick={cancel}>Vazgeç</button>
            <button className="btn p" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'} <span className="k">Ctrl+S</span></button>
          </div>
        </div>
      </form>
    </>
  )
}

/* ================= S-33 Hayvan detayı ================= */

type Dialog = null | 'death' | 'lost' | 'found' | 'transfer' | 'implant' | 'second' | 'correct'

export function AnimalDetailPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const isNew = id === 'yeni'
  const q = useQuery({ queryKey: ['animal', id], queryFn: () => api.get<AnimalDetailFull>(`/api/animals/${id}`), enabled: !isNew })
  if (isNew) return <AnimalForm key="new" />
  if (q.isError) return <div className="alert">{(q.error as Error).message}</div>
  if (!q.data) return <div className="mut">Yükleniyor…</div>
  if (params.get('duzenle') === '1') return <AnimalForm key={`${id}-${q.data.version}`} existing={q.data} />
  return <AnimalView a={q.data} tab={params.get('sekme') ?? 'ozet'} setTab={(t) => setParams({ sekme: t }, { replace: true })} />
}

function AnimalView({ a, tab, setTab }: { a: AnimalDetailFull; tab: string; setTab(t: string): void }) {
  const nav = useNavigate()
  const can = useCan()
  const [dialog, setDialog] = useState<Dialog>(null)
  const chip = a.chips.find((c) => c.status === 'active')
  const owner = a.owners[0]
  const openTask = a.petvetTasks.find((t) => t.status === 'pending' || t.status === 'missing_info')
  const today = todayIstanbul()
  const dead = a.status === 'dead'

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'm' && can('visits.write') && !dead) {
        e.preventDefault()
        nav(`/muayene/yeni?animal=${a.id}`)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [a.id, can, dead, nav])

  const tabs = [
    { key: 'ozet', label: 'Özet' },
    { key: 'muayeneler', label: 'Muayeneler', hidden: !can('visits.read') },
    { key: 'asilar', label: 'Aşılar' },
    { key: 'cip', label: 'Çip ve kimlik' },
    { key: 'tedaviler', label: 'Tedaviler', hidden: !can('visits.read') },
    { key: 'kilo', label: 'Kilo' },
    { key: 'belgeler', label: 'Belgeler' },
    { key: 'petvet', label: `PETVET${a.petvetTasks.length ? ` (${a.petvetTasks.length})` : ''}` },
    { key: 'sahiplik', label: 'Sahiplik' },
    { key: 'gecmis', label: 'Geçmiş' },
  ]

  return (
    <>
      <nav className="crumb" aria-label="Konum"><Link to="/hayvanlar">Hayvanlar</Link> › {a.name}</nav>
      <section className="pnl" style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start', borderRadius: '3px 3px 0 0' }}>
        <div className="photo" style={{ width: 96, height: 96 }}>{SPECIES_LABEL[a.species].toLocaleLowerCase('tr-TR')}</div>
        <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 22 }}>{a.name}</h1>
            <span className={`st ${statusClass(a.status)}`}>{ANIMAL_STATUS_LABEL[a.status] ?? a.status}{a.statusDate && a.status !== 'active' ? ` (${formatDateTr(a.statusDate)})` : ''}</span>
            <WarnTags allergies={a.allergies} behavior={a.behavior} chronic={a.chronicDiseases} />
          </div>
          <div className="mut">
            {[
              SPECIES_LABEL[a.species],
              a.breed,
              `${SEX_LABEL[a.sex]}${a.neutered ? `, kısır${a.neuteredAt ? ` (${formatDateTr(a.neuteredAt).slice(3)})` : ''}` : ''}`,
              a.birthDate ? `${a.birthDateEstimated ? '~' : ''}${formatDateTr(a.birthDate)} doğumlu (${age(a.birthDate)})` : null,
              a.lastWeight ? `${kg(a.lastWeight.kg)} kg` : null,
              a.color,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <dl className="kv" style={{ marginTop: 4 }}>
            <dt>Çip</dt>
            <dd>{chip ? <><ChipNo value={chip.chipNo} /> <span className="mut">· {formatDateTr(chip.implantedAt)} · {chip.bodySite}</span></> : <span className="s-red">çipsiz</span>}</dd>
            <dt>Pasaport</dt>
            <dd className="mono">{a.passportNo ?? '—'}</dd>
            <dt>Sahip</dt>
            <dd>{owner ? <><Link to={`/sahipler/${owner.id}`}>{owner.fullName}</Link> · <span className="mono">{formatTrPhone(owner.phone)}</span>{a.owners.length > 1 && <span className="mut"> +{a.owners.length - 1}</span>}</> : '—'}</dd>
          </dl>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            {can('visits.write') && !dead && <Link className="btn p" to={`/muayene/yeni?animal=${a.id}`}>Yeni muayene <span className="k">Ctrl+M</span></Link>}
            {can('vaccinations.write') && !dead && <Link className="btn" to={`/asilar/uygula?animal=${a.id}`}>Aşı uygula</Link>}
            {can('appointments.write') && !dead && <Link className="btn" to={`/randevular?yeni=1&animal=${a.id}&tarih=${today}`}>Randevu</Link>}
            <DropMenu
              label="Yazdır"
              items={[
                { label: 'Aşı karnesi', onClick: () => openPrint('vaccine-card', a.id) },
                { label: 'Kayıt / çip kartı', onClick: () => openPrint('chip-card', a.id), disabled: !chip },
              ]}
            />
            <DropMenu
              label="İşlemler"
              items={[
                { label: 'Düzenle', onClick: () => nav(`/hayvanlar/${a.id}?duzenle=1`), hidden: !can('animals.write') },
                { label: 'Çip uygula', onClick: () => setDialog('implant'), hidden: !can('chips.implant') || !!chip || dead },
                { label: 'Çip düzelt (yanlış numara)', onClick: () => setDialog('correct'), hidden: !can('chips.correct') || !a.chipsFull.some((c) => c.status !== 'corrected') },
                { label: 'İkinci çip ekle', onClick: () => setDialog('second'), hidden: !can('chips.implant') || !chip || dead },
                { label: 'Kayıp bildir', onClick: () => setDialog('lost'), hidden: !can('animals.status') || a.status !== 'active' },
                { label: 'Bulundu', onClick: () => setDialog('found'), hidden: !can('animals.status') || a.status !== 'lost' },
                { label: 'Sahip değişikliği (devir)', onClick: () => setDialog('transfer'), hidden: !can('animals.status') || a.status !== 'active' },
                { label: 'Ölüm kaydı', onClick: () => setDialog('death'), hidden: !can('animals.death') || dead, danger: true },
              ]}
            />
          </div>
          {openTask && (
            <Link to={`/petvet/${openTask.id}`} className="alert amb" style={{ textDecoration: 'none', color: 'var(--ink)', padding: '6px 10px' }}>
              <strong className="st s-amb">PETVET</strong> {kindLabel(openTask.kind)} · {openTask.status === 'missing_info' ? 'eksik bilgi' : urgencyText(openTask.urgency, openTask.daysLeft)} ›
            </Link>
          )}
        </div>
      </section>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'ozet' && <SummaryTab a={a} onTab={setTab} />}
      {tab === 'muayeneler' && <AnimalVisitsTab animalId={a.id} />}
      {tab === 'asilar' && <AnimalVaccinesTab animalId={a.id} />}
      {tab === 'cip' && <ChipTab a={a} onAction={setDialog} />}
      {tab === 'tedaviler' && <AnimalTreatmentsTab animalId={a.id} />}
      {tab === 'kilo' && <WeightTab animalId={a.id} />}
      {tab === 'belgeler' && <Attachments ownerType="animal" ownerId={a.id} canUpload={can('animals.write')} />}
      {tab === 'petvet' && <PetvetTab a={a} />}
      {tab === 'sahiplik' && <OwnershipTab animalId={a.id} />}
      {tab === 'gecmis' && <AnimalHistoryTab animalId={a.id} />}

      <p className="mut" style={{ margin: 0, fontSize: 12 }}>
        Oluşturan: {a.createdByName ?? '—'} · {fmtDT(a.createdAt)} · Son değiştiren: {a.updatedByName ?? '—'} · {fmtDT(a.updatedAt)}
      </p>

      {dialog === 'death' && <DeathDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'lost' && <LostDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'found' && <FoundDialog a={a} onClose={() => setDialog(null)} />}
      {dialog === 'transfer' && <TransferDialog a={a} onClose={() => setDialog(null)} />}
      {(dialog === 'implant' || dialog === 'second') && <ImplantDialog a={a} second={dialog === 'second'} onClose={() => setDialog(null)} />}
      {dialog === 'correct' && <CorrectDialog a={a} onClose={() => setDialog(null)} />}
    </>
  )
}

/* ---------- Sekmeler ---------- */

function SummaryTab({ a, onTab }: { a: AnimalDetailFull; onTab(t: string): void }) {
  const tl = useQuery({ queryKey: ['animal-timeline', a.id], queryFn: () => api.get<TimelineRow[]>(`/api/animals/${a.id}/timeline`) })
  const weights = useQuery({ queryKey: ['animal-weights', a.id], queryFn: () => api.get<WeightRow[]>(`/api/animals/${a.id}/weights`) })
  return (
    <div className="row2" style={{ paddingTop: 0 }}>
      <section className="pnl" style={{ flex: '3 1 520px', minWidth: 0 }}>
        <div className="ph">
          <h2>Son olaylar</h2>
          <button type="button" className="btn sm" onClick={() => onTab('gecmis')}>Tüm geçmiş</button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th style={{ width: 92 }}>Tarih</th><th style={{ width: 190 }}>Olay</th><th>Ayrıntı</th><th>Kullanıcı</th></tr></thead>
            <tbody>
              {tl.data?.slice(0, 10).map((x, i) => (
                <tr key={i}>
                  <td className="mono" title={fmtDT(x.at)}>{new Date(x.at).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                  <td>{x.title}</td>
                  <td>{x.petvetStatus === 'done' ? <span className="st s-ok">{x.detail || 'girildi'}</span> : x.kind === 'chip' ? <span className="mono">{x.detail}</span> : x.detail}</td>
                  <td>{x.userName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tl.data?.length === 0 && <div className="empty">Olay yok.</div>}
        </div>
        <div className="tfoot">Muayene ve aşı olayları "Muayeneler" ve "Aşılar" sekmelerindedir.</div>
      </section>
      <div style={{ flex: '2 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(a.allergies.length > 0 || a.chronicDiseases.length > 0 || a.behavior) && (
          <section className="pnl">
            <div className="ph"><h2>Uyarılar</h2></div>
            <div style={{ padding: '10px 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <WarnTags allergies={a.allergies} behavior={a.behavior} chronic={a.chronicDiseases} />
            </div>
          </section>
        )}
        <section className="pnl">
          <div className="ph"><h2>Kilo</h2><button type="button" className="btn sm" onClick={() => onTab('kilo')}>Ölçüm ekle</button></div>
          <div style={{ padding: '10px 12px' }}>
            {weights.data && weights.data.length > 0 ? <WeightChart rows={weights.data} height={70} /> : <span className="mut">Ölçüm yok.</span>}
          </div>
        </section>
        {(a.notes || a.diet) && (
          <section className="pnl">
            <div className="ph"><h2>Notlar</h2></div>
            <p style={{ margin: 0, padding: '10px 12px', whiteSpace: 'pre-wrap' }}>
              {a.notes}
              {a.diet && <><br /><span className="mut">Beslenme:</span> {a.diet}</>}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}

const CHIP_STATUS: Record<string, [string, string]> = { active: ['Aktif', 's-ok'], inactive: ['Pasif', 's-gry'], corrected: ['Düzeltildi (geçersiz)', 's-red'] }
const CHIP_EVENT: Record<string, string> = { IMPLANT: 'Uygulama', CORRECTION: 'Düzeltme', DEACTIVATE: 'Pasif yapıldı' }

function ChipTab({ a, onAction }: { a: AnimalDetailFull; onAction(d: Dialog): void }) {
  const can = useCan()
  const chipTask = (c: ChipFullDto) => a.petvetTasks.find((t) => t.kind === 'CHIP_NEW' && t.status !== 'cancelled' && c.status === 'active')
  const hasActive = a.chipsFull.some((c) => c.status === 'active')
  return (
    <div className="row2">
      <section className="pnl" style={{ flex: '3 1 520px', minWidth: 0 }}>
        <div className="ph">
          <h2>Çipler</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {can('chips.implant') && a.status !== 'dead' && !hasActive && <button className="btn sm" onClick={() => onAction('implant')}>Çip uygula</button>}
            {can('chips.correct') && a.chipsFull.some((c) => c.status !== 'corrected') && <button className="btn sm" onClick={() => onAction('correct')}>Düzelt</button>}
            {can('chips.implant') && a.status !== 'dead' && hasActive && <button className="btn sm" onClick={() => onAction('second')}>İkinci çip ekle</button>}
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Çip no</th><th>Biçim</th><th>Uygulama</th><th>Hekim</th><th>Bölge</th><th>Lot</th><th>Durum</th><th>PETVET</th></tr></thead>
            <tbody>
              {a.chipsFull.map((c) => {
                const v = validateChip(c.chipNo)
                const t = chipTask(c)
                const [label, cls] = CHIP_STATUS[c.status] ?? [c.status, 's-gry']
                return (
                  <tr key={c.id}>
                    <td><ChipNo value={c.chipNo} /> <button type="button" className="btn sm" aria-label="Çip numarasını kopyala" onClick={() => navigator.clipboard.writeText(c.chipNo)}>Kopyala</button></td>
                    <td>{c.format === 'iso' ? `ISO${v.ok && v.code ? ` · ${v.code === 792 ? 'Türkiye' : v.codeKind === 'manufacturer' ? 'üretici' : v.codeKind === 'test' ? 'test' : 'yurt dışı'}` : ''}` : 'Eski biçim'}</td>
                    <td className="mono">{formatDateTr(c.implantedAt)}</td>
                    <td>{c.implantedByName}</td>
                    <td>{c.bodySite}</td>
                    <td className="mono">{c.lotNo}</td>
                    <td><span className={`st ${cls}`}>{label}</span></td>
                    <td>{t ? <PetvetState status={t.status} urgency={t.urgency} daysLeft={t.daysLeft} /> : <span className="mut">—</span>}{t?.petvetRef ? <span className="mono mut"> {t.petvetRef}</span> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {a.chipsFull.length === 0 && <div className="empty">Bu hayvanda çip kaydı yok.</div>}
        </div>
      </section>
      <section className="pnl" style={{ flex: '2 1 320px', minWidth: 0 }}>
        <div className="ph"><h2>Çip olayları</h2></div>
        <table>
          <tbody>
            {a.chipEvents.map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDT(e.at)}</td>
                <td>
                  {CHIP_EVENT[e.kind] ?? e.kind} · <span className="mono">{formatChip(e.chipNo)}</span>
                  {e.kind === 'CORRECTION' && <div className="mut">eski: <span className="mono">{String(e.data.oldChipNo ?? '')}</span> · {String(e.data.reason ?? '')}</div>}
                  {typeof e.data.bodySiteReason === 'string' && <div className="mut">Bölge nedeni: {e.data.bodySiteReason}</div>}
                </td>
                <td>{e.userName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {a.chipEvents.length === 0 && <div className="empty">Olay yok.</div>}
      </section>
    </div>
  )
}

function WeightChart({ rows, height = 140 }: { rows: WeightRow[]; height?: number }) {
  const pts = [...rows].reverse()
  const W = 300
  const H = height
  const min = Math.min(...pts.map((p) => p.kg))
  const max = Math.max(...pts.map((p) => p.kg))
  const span = max - min || 1
  const xy = pts.map((p, i) => [pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W, H - 4 - ((p.kg - min) / span) * (H - 10)] as const)
  const first = pts[0]
  const last = pts[pts.length - 1]
  const fmtM = (iso: string) => new Date(iso).toLocaleDateString('tr-TR', { month: 'short', year: '2-digit' })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <svg viewBox={`-4 0 ${W + 8} ${H}`} width="100%" height={H} role="img" aria-label={`Kilo: ${fmtM(first.measuredAt)} ${kg(first.kg)} kg, ${fmtM(last.measuredAt)} ${kg(last.kg)} kg`}>
        <path d={`M-4 ${H - 2}H${W + 4}`} stroke="var(--line-2)" />
        <polyline points={xy.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
        <g fill="var(--accent)">{xy.map(([x, y], i) => <rect key={i} x={x - 2} y={y - 2} width={4} height={4} />)}</g>
      </svg>
      <div className="mono mut" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <span>{fmtM(first.measuredAt)} {kg(first.kg)}</span>
        <span>{fmtM(last.measuredAt)} {kg(last.kg)} kg</span>
      </div>
    </div>
  )
}

function WeightTab({ animalId }: { animalId: string }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['animal-weights', animalId], queryFn: () => api.get<WeightRow[]>(`/api/animals/${animalId}/weights`) })
  const [val, setVal] = useState('')
  const [date, setDate] = useState(todayIstanbul())
  const [err, setErr] = useState('')

  async function add(e: React.FormEvent, confirm = false) {
    e.preventDefault?.()
    setErr('')
    const n = Number(val.replace(',', '.'))
    if (!(n >= 0.01 && n <= 150)) return setErr('Kilo 0,01–150 kg arasında olmalı.')
    try {
      await api.post(`/api/animals/${animalId}/weights`, { kg: n, date, confirm })
      setVal('')
      qc.invalidateQueries()
      toast('Kilo ölçümü eklendi.')
    } catch (ex) {
      const he = ex as HttpError
      if (he.code === 'CONFIRM_REQUIRED' && window.confirm(he.message)) return add(e, true)
      setErr(he.message)
    }
  }

  return (
    <div className="row2">
      <section className="pnl" style={{ flex: '3 1 480px', minWidth: 0 }}>
        <div className="ph"><h2>Kilo grafiği</h2></div>
        <div style={{ padding: 12 }}>{q.data?.length ? <WeightChart rows={q.data} /> : <span className="mut">Ölçüm yok.</span>}</div>
        {can('animals.write') && (
          <form onSubmit={(e) => add(e)} className="form-foot" style={{ justifyContent: 'flex-start' }}>
            <Field label="Kilo (kg)" htmlFor="wkg"><input id="wkg" className="inp mono" style={{ width: 110 }} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} /></Field>
            <Field label="Tarih" htmlFor="wdt"><input id="wdt" type="date" className="inp" max={todayIstanbul()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <button className="btn p" style={{ alignSelf: 'flex-end' }}>Ölçüm ekle</button>
            {err && <span className="err" style={{ alignSelf: 'flex-end' }}>{err}</span>}
          </form>
        )}
      </section>
      <section className="pnl" style={{ flex: '2 1 320px', minWidth: 0 }}>
        <div className="ph"><h2>Ölçümler</h2></div>
        <table>
          <thead><tr><th>Tarih</th><th>Kilo</th><th>Kaynak</th><th>Kullanıcı</th></tr></thead>
          <tbody>
            {q.data?.map((w) => (
              <tr key={w.id}>
                <td className="mono">{fmtDT(w.measuredAt)}</td>
                <td className="mono">{kg(w.kg)} kg</td>
                <td>{w.source === 'visit' ? 'Muayene' : 'Elle'}</td>
                <td>{w.userName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function PetvetTab({ a }: { a: AnimalDetailFull }) {
  const nav = useNavigate()
  return (
    <section className="pnl">
      <div className="ph"><h2>PETVET görevleri</h2></div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>İş</th><th>Olay</th><th>Son gün</th><th>Durum</th><th>Sahip</th><th>Referans</th></tr></thead>
          <tbody>
            {a.petvetTasks.map((t) => (
              <tr key={t.id} className={`click${t.urgency === 'overdue' && (t.status === 'pending' || t.status === 'missing_info') ? ' hot' : ''}`} onClick={() => nav(`/petvet/${t.id}`)}>
                <td>{kindLabel(t.kind)}</td>
                <td className="mono">{formatDateTr(t.eventDate)}</td>
                <td className="mono">{formatDateTr(t.dueDate)}</td>
                <td><PetvetState status={t.status} urgency={t.urgency} daysLeft={t.daysLeft} /></td>
                <td>{t.ownerName}</td>
                <td className="mono">{t.petvetRef ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {a.petvetTasks.length === 0 && <div className="empty">PETVET görevi yok.{!PETVET_SPECIES.includes(a.species) && ' Bu tür PETVET kapsamında değil.'}</div>}
      </div>
    </section>
  )
}

function OwnershipTab({ animalId }: { animalId: string }) {
  const q = useQuery({ queryKey: ['animal-ownership', animalId], queryFn: () => api.get<OwnershipRow[]>(`/api/animals/${animalId}/ownership`) })
  const nav = useNavigate()
  return (
    <section className="pnl">
      <div className="ph"><h2>Sahiplik geçmişi</h2></div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Sahip</th><th>Telefon</th><th>Başlangıç</th><th>Bitiş</th><th>Neden</th></tr></thead>
          <tbody>
            {q.data?.map((o, i) => (
              <tr key={i} className="click" onClick={() => nav(`/sahipler/${o.ownerId}`)}>
                <td><strong>{o.ownerName}</strong>{o.isPrimary && !o.toDate && <span className="mut"> · birincil</span>}</td>
                <td className="mono">{formatTrPhone(o.phone)}</td>
                <td className="mono">{formatDateTr(o.fromDate)}</td>
                <td className="mono">{o.toDate ? formatDateTr(o.toDate) : <span className="st s-ok">devam ediyor</span>}</td>
                <td>{o.endReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AnimalHistoryTab({ animalId }: { animalId: string }) {
  const q = useQuery({ queryKey: ['animal-history', animalId], queryFn: () => api.get<HistoryRow[]>(`/api/animals/${animalId}/history`) })
  return <HistoryTable rows={q.data} />
}

/* ---------- S-34 Durum diyalogları ---------- */

function useAction(onClose: () => void) {
  const qc = useQueryClient()
  const toast = useToast()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function run<T>(fn: () => Promise<T>, msg: (r: T) => string) {
    setBusy(true)
    setErr('')
    try {
      const r = await fn()
      qc.invalidateQueries()
      toast(msg(r))
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { err, setErr, busy, run }
}

function Foot({ err, busy, onClose, label, disabled, danger }: { err: string; busy: boolean; onClose(): void; label: string; disabled?: boolean; danger?: boolean }) {
  return (
    <>
      <span className="err" role="alert">{err}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
        <button type="submit" form="dlg" className="btn p" disabled={busy || disabled} style={danger ? { background: 'var(--red)', borderColor: 'var(--red)' } : undefined}>{busy ? 'Kaydediliyor…' : label}</button>
      </div>
    </>
  )
}

function DeathDialog({ a, onClose }: { a: AnimalDetailFull; onClose(): void }) {
  const today = todayIstanbul()
  const [d, setD] = useState({ date: today, cause: '' as DeathCause | '', note: '', noMsg: false, typed: '' })
  const { err, setErr, busy, run } = useAction(onClose)
  const ok = d.typed.trim().toLocaleUpperCase('tr-TR') === 'ÖLÜM'
  return (
    <Modal title={`Ölüm kaydı — ${a.name}`} onClose={onClose} footer={<Foot err={err} busy={busy} onClose={onClose} label="Ölüm kaydını onayla" disabled={!ok || !d.noMsg} danger />}>
      <form
        id="dlg"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!d.cause) return setErr('Ölüm nedenini seçin.')
          run(() => api.post<StatusResult>(`/api/animals/${a.id}/death`, { date: d.date, cause: d.cause, note: d.note || undefined, confirm: true }), (r) => petvetToast(r, 'Ölüm kaydedildi.'))
        }}
      >
        <div className="alert">Bu işlem geri alınamaz. Bekleyen hatırlatmalar iptal edilir; hayvan durumu "Öldü" olur.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Ölüm tarihi *" htmlFor="dd"><input id="dd" type="date" className="inp" max={today} min={a.birthDate ?? undefined} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Neden *" htmlFor="dc">
            <select id="dc" className="inp" value={d.cause} onChange={(e) => setD({ ...d, cause: e.target.value as DeathCause })}>
              <option value="">Seçin</option>
              {DEATH_CAUSES.map((c) => <option key={c} value={c}>{DEATH_CAUSE_LABEL[c]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Açıklama" htmlFor="dn"><textarea id="dn" className="inp" style={{ height: 52, paddingTop: 4 }} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></Field>
        {d.cause === 'euthanasia' && <span className="mut" style={{ fontSize: 12 }}>Ötanazi onam belgesini kayıttan sonra "Belgeler" sekmesine ekleyin.</span>}
        {PETVET_SPECIES.includes(a.species) && a.chips.some((c) => c.status === 'active') && <span className="mut">PETVET'te ölüm bildirimi görevi açılacak (sahip bildirimi 30 gün ⚠️ doğrulanacak).</span>}
        <label className="ck"><input type="checkbox" checked={d.noMsg} onChange={(e) => setD({ ...d, noMsg: e.target.checked })} />Bundan sonra bu hayvan için hiçbir mesaj gönderilmeyecek.</label>
        <Field label='Onay için "ÖLÜM" yazın' htmlFor="dt"><input id="dt" className="inp" value={d.typed} onChange={(e) => setD({ ...d, typed: e.target.value })} autoComplete="off" /></Field>
      </form>
    </Modal>
  )
}

function LostDialog({ a, onClose }: { a: AnimalDetailFull; onClose(): void }) {
  const today = todayIstanbul()
  const [d, setD] = useState({ date: today, city: '', district: '', place: '', note: '', openPetvet: true })
  const { err, busy, run } = useAction(onClose)
  const petvet = PETVET_SPECIES.includes(a.species) && a.chips.some((c) => c.status === 'active')
  return (
    <Modal title={`Kayıp bildirimi — ${a.name}`} onClose={onClose} footer={<Foot err={err} busy={busy} onClose={onClose} label="Kayıp olarak işaretle" />}>
      <form
        id="dlg"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          run(
            () => api.post<StatusResult>(`/api/animals/${a.id}/lost`, { ...d, city: d.city || undefined, district: d.district || undefined, place: d.place || undefined, note: d.note || undefined }),
            (r) => petvetToast(r, 'Kayıp bildirildi.'),
          )
        }}
      >
        <div className="alert amb">Sahibin 7 gün içinde il/ilçe müdürlüğüne bildirmesi gerekir. ⚠️ doğrulanacak. Çip okunduğunda kırmızı uyarı gösterilir.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Kayıp tarihi *" htmlFor="ld"><input id="ld" type="date" className="inp" max={today} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="İl" htmlFor="lc">
            <select id="lc" className="inp" value={d.city} onChange={(e) => setD({ ...d, city: e.target.value })}>
              <option value="">—</option>
              {CITIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="İlçe" htmlFor="li"><input id="li" className="inp" value={d.district} onChange={(e) => setD({ ...d, district: e.target.value })} /></Field>
          <Field label="Yer" htmlFor="lp"><input id="lp" className="inp" value={d.place} onChange={(e) => setD({ ...d, place: e.target.value })} /></Field>
        </div>
        <Field label="Not" htmlFor="ln"><input id="ln" className="inp" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></Field>
        {petvet && <label className="ck"><input type="checkbox" checked={d.openPetvet} onChange={(e) => setD({ ...d, openPetvet: e.target.checked })} />Klinik PETVET'e kayıp bildirimi girecek (görev aç)</label>}
      </form>
    </Modal>
  )
}

function FoundDialog({ a, onClose }: { a: AnimalDetailFull; onClose(): void }) {
  const today = todayIstanbul()
  const [d, setD] = useState({ date: today, note: '' })
  const { err, busy, run } = useAction(onClose)
  return (
    <Modal title={`Bulundu — ${a.name}`} onClose={onClose} footer={<Foot err={err} busy={busy} onClose={onClose} label="Bulundu olarak işaretle" />}>
      <form
        id="dlg"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          run(
            () => api.post<StatusResult & { cancelledTasks?: number }>(`/api/animals/${a.id}/found`, { date: d.date, note: d.note || undefined }),
            (r) => petvetToast(r, `Hayvan yeniden aktif.${r.cancelledTasks ? ' Açık kayıp görevi iptal edildi.' : ''}`),
          )
        }}
      >
        <Field label="Bulunma tarihi *" htmlFor="fd"><input id="fd" type="date" className="inp" max={today} min={a.statusDate ?? undefined} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
        <Field label="Not" htmlFor="fn"><input id="fn" className="inp" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></Field>
        <span className="mut" style={{ fontSize: 12 }}>Kayıp PETVET'e henüz girilmediyse açık görev iptal edilir; girildiyse "Bulundu" görevi açılır.</span>
      </form>
    </Modal>
  )
}

function TransferDialog({ a, onClose }: { a: AnimalDetailFull; onClose(): void }) {
  const today = todayIstanbul()
  const [owner, setOwner] = useState<{ id: string; label: string; tcknLast4: string | null; kvkk: boolean } | null>(null)
  const [d, setD] = useState({ date: today, reason: '', removeOld: true })
  const [mode, setMode] = useState<'pick' | 'new'>('pick')
  const [no, setNo] = useState({ firstName: '', lastName: '', phone: '', city: '', district: '', kvkkNotice: false })
  const { err, setErr, busy, run } = useAction(onClose)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    let ownerId = owner?.id
    if (mode === 'new') {
      if (!normalizeTrMobile(no.phone)) return setErr('Yeni sahibin cep telefonu geçersiz.')
      if (!no.kvkkNotice) return setErr('Yeni sahibe aydınlatma metni verilmeli.')
    } else if (!ownerId) return setErr('Yeni sahibi seçin.')
    run(
      async () => {
        if (mode === 'new') ownerId = (await api.post<{ id: string }>('/api/owners', { ...no, kvkkMethod: 'printed' })).id
        return api.post<StatusResult>(`/api/animals/${a.id}/transfer`, { date: d.date, newOwnerId: ownerId, reason: d.reason || undefined, removeOldOwners: d.removeOld })
      },
      (r) => petvetToast(r, 'Devir kaydedildi.'),
    )
  }

  return (
    <Modal title={`Sahip değişikliği — ${a.name}`} width={640} onClose={onClose} footer={<Foot err={err} busy={busy} onClose={onClose} label="Devri kaydet" />}>
      <form id="dlg" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={submit}>
        <span className="mut">Mevcut sahip: {a.owners.map((o) => o.fullName).join(', ') || '—'}</span>
        <div className="rad" role="radiogroup" aria-label="Yeni sahip">
          <label><input type="radio" checked={mode === 'pick'} onChange={() => setMode('pick')} />Kayıtlı sahip seç</label>
          <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />Yeni sahip oluştur</label>
        </div>
        {mode === 'pick' ? (
          <>
            <OwnerPicker value={owner} onChange={setOwner} exclude={a.owners.map((o) => o.id)} id="tq" label="Yeni sahip *" />
            {owner && !owner.kvkk && <div className="alert">Bu sahibe KVKK aydınlatma metni verilmemiş. Önce sahip kaydında aydınlatmayı işaretleyin.</div>}
            {owner && !owner.tcknLast4 && <div className="alert amb">Yeni sahibin TCKN'si yok; PETVET devir görevi "eksik bilgi" açılır.</div>}
          </>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Ad *" htmlFor="nf"><input id="nf" className="inp" value={no.firstName} onChange={(e) => setNo({ ...no, firstName: e.target.value })} /></Field>
            <Field label="Soyad *" htmlFor="nl"><input id="nl" className="inp" value={no.lastName} onChange={(e) => setNo({ ...no, lastName: e.target.value })} /></Field>
            <Field label="Cep telefonu *" htmlFor="np"><input id="np" className="inp mono" value={no.phone} onChange={(e) => setNo({ ...no, phone: e.target.value })} /></Field>
            <Field label="İl" htmlFor="nc">
              <select id="nc" className="inp" value={no.city} onChange={(e) => setNo({ ...no, city: e.target.value })}>
                <option value="">—</option>
                {CITIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="İlçe" htmlFor="nd"><input id="nd" className="inp" value={no.district} onChange={(e) => setNo({ ...no, district: e.target.value })} /></Field>
            <label className="ck" style={{ alignSelf: 'end' }}><input type="checkbox" checked={no.kvkkNotice} onChange={(e) => setNo({ ...no, kvkkNotice: e.target.checked })} />Aydınlatma metni verildi *</label>
            <span className="mut" style={{ gridColumn: 'span 2', fontSize: 12 }}>TCKN ve diğer bilgileri sonra sahip kaydından tamamlayabilirsiniz.</span>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <Field label="Devir tarihi *" htmlFor="tdt"><input id="tdt" type="date" className="inp" max={today} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Devir nedeni" htmlFor="trs"><input id="trs" className="inp" value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
        </div>
        <label className="ck"><input type="checkbox" checked={d.removeOld} onChange={(e) => setD({ ...d, removeOld: e.target.checked })} />Eski sahip(ler) tamamen çıkarılsın</label>
        <span className="mut" style={{ fontSize: 12 }}>Bekleyen hatırlatmalar iptal edilir; PETVET'te sahip devri görevi açılır.</span>
      </form>
    </Modal>
  )
}

/* ---------- S-35 Çip uygula / ikinci çip ---------- */

function ImplantDialog({ a, second, onClose }: { a: AnimalDetailFull; second: boolean; onClose(): void }) {
  const { user } = useSession()
  const today = todayIstanbul()
  const vets = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserDto[]>('/api/users') })
  const vetList = (vets.data ?? []).filter((u) => u.role === 'vet' || u.role === 'admin')
  const [d, setD] = useState({ chipNo: '', chipNo2: '', date: today, vetId: '', bodySite: 'Boyun sol', bodySiteReason: '', lotNo: '', passportNo: '', verified: false })
  const { err, setErr, busy, run } = useAction(onClose)
  useEffect(() => {
    if (!d.vetId && vetList.length) setD((x) => ({ ...x, vetId: (vetList.find((v) => v.id === user?.id) ?? vetList[0]).id }))
  }, [vetList, d.vetId, user?.id])
  const v = d.chipNo.trim() ? validateChip(d.chipNo) : null
  const vetSel = vetList.find((x) => x.id === d.vetId)
  const old = d.date && diffDaysIso(d.date, today) > 15

  return (
    <Modal
      title={`${second ? 'İkinci çip ekle' : 'Çip uygula'} — ${a.name}`}
      width={640}
      onClose={onClose}
      footer={<Foot err={err} busy={busy} onClose={onClose} label="Kaydet" />}
    >
      <form
        id="dlg"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!v?.ok) return setErr('Geçerli bir çip numarası girin.')
          const v2 = validateChip(d.chipNo2)
          if (!v2.ok || v2.value !== v.value) return setErr('Çip numarası ikinci girişle aynı değil. Okuyucu ile okutun ya da iki kez yazın.')
          if (d.bodySite !== 'Boyun sol' && !d.bodySiteReason.trim()) return setErr('Varsayılan dışındaki bölge için nedeni yazın.')
          run(
            () =>
              api.post<ChipActionResult>(`/api/animals/${a.id}/chips`, {
                chipNo: v.value,
                date: d.date,
                vetId: d.vetId,
                bodySite: d.bodySite,
                bodySiteReason: d.bodySiteReason || undefined,
                lotNo: d.lotNo || undefined,
                passportNo: d.passportNo || undefined,
                verified: d.verified,
                second,
              }),
            (r) => petvetToast(r, `Çip kaydedildi.${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''}`),
          )
        }}
      >
        {second && <div className="alert amb">Mevcut aktif çip "pasif" işaretlenir; aramada bulunmaya devam eder.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Çip no *" htmlFor="cn">
            <input id="cn" data-chip-input className="inp mono" autoFocus autoComplete="off" value={d.chipNo} onChange={(e) => setD({ ...d, chipNo: e.target.value, chipNo2: d.chipNo2 })} onBlur={() => v?.ok && setD((x) => ({ ...x, chipNo: formatChip(v.value), chipNo2: x.chipNo2 || formatChip(v.value) }))} placeholder="Okuyucuyu çipe tutun" />
          </Field>
          <Field label="Çip no (tekrar) *" htmlFor="cn2"><input id="cn2" className="inp mono" autoComplete="off" value={d.chipNo2} onChange={(e) => setD({ ...d, chipNo2: e.target.value })} /></Field>
        </div>
        {v && !v.ok && <span className="st s-red">{v.error}</span>}
        {v?.ok && <span className="st s-ok">Geçerli · {v.code === 792 ? '792 Türkiye' : v.codeKind === 'manufacturer' ? 'üretici kodu' : v.codeKind === 'test' ? 'test çipi' : 'yurt dışı çipi'}</span>}
        {v?.ok && v.warnings.map((w) => <span key={w} className="st s-amb">{w}</span>)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Uygulama tarihi *" htmlFor="cd"><input id="cd" type="date" className="inp" max={today} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Uygulayan hekim *" htmlFor="cv">
            <select id="cv" className="inp" value={d.vetId} onChange={(e) => setD({ ...d, vetId: e.target.value })}>
              {vetList.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </Field>
          <Field label="Vücut bölgesi *" htmlFor="cb">
            <select id="cb" className="inp" value={d.bodySite} onChange={(e) => setD({ ...d, bodySite: e.target.value })}>
              {BODY_SITES.map((b) => <option key={b}>{b}</option>)}
            </select>
          </Field>
          {d.bodySite !== 'Boyun sol' && <Field label="Bölge nedeni *" htmlFor="cr"><input id="cr" className="inp" value={d.bodySiteReason} onChange={(e) => setD({ ...d, bodySiteReason: e.target.value })} /></Field>}
          <Field label="Çip lot / seri" htmlFor="cl"><input id="cl" className="inp" value={d.lotNo} onChange={(e) => setD({ ...d, lotNo: e.target.value })} /></Field>
          <Field label="Pasaport no" htmlFor="cp"><input id="cp" className="inp mono" value={d.passportNo} onChange={(e) => setD({ ...d, passportNo: e.target.value })} placeholder={a.passportNo ?? ''} /></Field>
        </div>
        {old && <div className="alert amb">Uygulama 15 günden eski: PETVET kayıt süresi geçmiş olabilir.</div>}
        {vetSel && !vetSel.chamberRegNo && <div className="alert amb">Seçilen hekimin oda sicil numarası eksik.</div>}
        <label className="ck"><input type="checkbox" checked={d.verified} onChange={(e) => setD({ ...d, verified: e.target.checked })} />Çip uygulandıktan sonra okutuldu ve aynı numara okundu *</label>
      </form>
    </Modal>
  )
}

/* ---------- S-36 Çip düzelt ---------- */

function CorrectDialog({ a, onClose }: { a: AnimalDetailFull; onClose(): void }) {
  const chips = a.chipsFull.filter((c) => c.status !== 'corrected')
  const [d, setD] = useState({ chipId: chips.find((c) => c.status === 'active')?.id ?? chips[0]?.id ?? '', no1: '', no2: '', reason: '' })
  const { err, setErr, busy, run } = useAction(onClose)
  const sel = chips.find((c) => c.id === d.chipId)
  const v = d.no1.trim() ? validateChip(d.no1) : null
  const entered = a.petvetTasks.some((t) => t.kind === 'CHIP_NEW' && t.status === 'done')

  return (
    <Modal title={`Çip numarası düzelt — ${a.name}`} width={600} onClose={onClose} footer={<Foot err={err} busy={busy} onClose={onClose} label="Düzeltmeyi kaydet" />}>
      <form
        id="dlg"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!v?.ok) return setErr('Yeni çip numarası geçersiz.')
          const v2 = validateChip(d.no2)
          if (!v2.ok || v2.value !== v.value) return setErr('Yeni numara ikinci girişle aynı değil.')
          if (d.reason.trim().length < 3) return setErr('Düzeltme nedenini yazın.')
          run(
            () => api.post<ChipActionResult>(`/api/chips/${d.chipId}/correct`, { newChipNo: v.value, reason: d.reason }),
            (r) => petvetToast(r, 'Çip numarası düzeltildi; eski kayıt geçmişte tutuluyor.'),
          )
        }}
      >
        <span className="mut">Yanlış girilmiş numara içindir. Eski kayıt silinmez, "düzeltildi" olarak saklanır.{entered && " Çip PETVET'e girildiği için bilgi düzeltme görevi açılacak."}</span>
        <Field label="Düzeltilecek çip" htmlFor="cc">
          <select id="cc" className="inp mono" value={d.chipId} onChange={(e) => setD({ ...d, chipId: e.target.value })}>
            {chips.map((c) => <option key={c.id} value={c.id}>{formatChip(c.chipNo)} ({c.status === 'active' ? 'aktif' : 'pasif'})</option>)}
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Yeni numara *" htmlFor="c1"><input id="c1" data-chip-input className="inp mono" autoComplete="off" value={d.no1} onChange={(e) => setD({ ...d, no1: e.target.value })} /></Field>
          <Field label="Yeni numara (tekrar) *" htmlFor="c2"><input id="c2" className="inp mono" autoComplete="off" value={d.no2} onChange={(e) => setD({ ...d, no2: e.target.value })} /></Field>
        </div>
        {v && !v.ok && <span className="st s-red">{v.error}</span>}
        {v?.ok && sel && v.value === sel.chipNo && <span className="st s-amb">Yeni numara eskisiyle aynı.</span>}
        <Field label="Neden *" htmlFor="cz"><input id="cz" className="inp" value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} placeholder="ör. hane yanlış yazılmış" /></Field>
      </form>
    </Modal>
  )
}
