// Hızlı kayıt: çip -> sahip -> hayvan -> uygulama
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError, qs } from '../api'
import { useSession } from '../session'
import { Field, useToast } from '../ui'
import { formatChip, validateChip } from '@shared/chip'
import { formatTrPhone, isValidTckn, normalizeTrMobile, trTitleCase } from '@shared/identity'
import { formatDateTr, petvetDueDate, todayIstanbul } from '@shared/petvet'
import {
  BODY_SITES,
  PETVET_SPECIES,
  SPECIES_LABEL,
  type ChipLookupDto,
  type OwnerListItem,
  type QuickRegisterResult,
  type Sex,
  type Species,
  type UserDto,
} from '@shared/api-types'

const emptyOwner = { firstName: '', lastName: '', tckn: '', phone: '', city: '', district: '', address: '', kvkkNotice: false }
const emptyAnimal = { name: '', species: 'cat' as Species, breed: '', sex: '' as Sex | '', neutered: false, birthDate: '', birthDateEstimated: false, color: '' }

export function QuickRegisterPage() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const { user } = useSession()
  const chipRef = useRef<HTMLInputElement>(null)
  const today = todayIstanbul()

  const [chip, setChip] = useState(params.get('chip') ?? '')
  const [ownerQ, setOwnerQ] = useState('')
  const [owner, setOwner] = useState<{ id: string; label: string; tcknLast4: string | null } | null>(null)
  const [newOwner, setNewOwner] = useState(false)
  const [o, setO] = useState(emptyOwner)
  const [a, setA] = useState(emptyAnimal)
  const [imp, setImp] = useState({ date: today, vetId: '', bodySite: 'Boyun sol', passportNo: '', lotNo: '', verified: false })
  const [campaign, setCampaign] = useState(false)
  const [count, setCount] = useState(0)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const formRef = useRef<HTMLFormElement>(null)
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

  const v = useMemo(() => (chip.trim() ? validateChip(chip) : null), [chip])
  const lookup = useQuery({
    queryKey: ['chip-lookup', v?.ok ? v.value : ''],
    queryFn: () => api.get<ChipLookupDto>('/api/chips/lookup' + qs({ no: v!.ok ? v!.value : '' })),
    enabled: !!v?.ok,
  })
  const vets = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserDto[]>('/api/users') })
  const vetList = (vets.data ?? []).filter((u) => u.role === 'vet' || u.role === 'admin')
  useEffect(() => {
    if (!imp.vetId && vetList.length) {
      const me = vetList.find((u) => u.id === user?.id)
      setImp((x) => ({ ...x, vetId: (me ?? vetList[0]).id }))
    }
  }, [vetList, imp.vetId, user?.id])

  const ownerSearch = useQuery({
    queryKey: ['owners', ownerQ],
    queryFn: () => api.get<OwnerListItem[]>('/api/owners' + qs({ q: ownerQ })),
    enabled: ownerQ.trim().length >= 2 && !owner && !newOwner,
  })

  const registered = lookup.data?.match
  const petvetApplies = PETVET_SPECIES.includes(a.species) && v?.ok && v.format === 'iso' && v.codeKind !== 'test'
  const ownerHasTckn = newOwner ? isValidTckn(o.tckn) : !!owner?.tcknLast4

  function reset() {
    setChip('')
    setOwner(null)
    setOwnerQ('')
    setNewOwner(false)
    setO(emptyOwner)
    setA(emptyAnimal)
    setImp((x) => ({ ...x, passportNo: '', lotNo: '', verified: false }))
    setErr('')
    setTimeout(() => chipRef.current?.focus(), 0)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (!v?.ok) return setErr('Geçerli bir çip numarası girin.')
    if (registered) return setErr('Bu çip zaten kayıtlı.')
    if (!owner && !newOwner) return setErr('Bir sahip seçin ya da yeni sahip ekleyin.')
    if (newOwner && o.tckn && !isValidTckn(o.tckn)) return setErr('TCKN geçersiz.')
    if (newOwner && !normalizeTrMobile(o.phone)) return setErr('Sahibin cep telefonu geçersiz.')
    if (!a.sex) return setErr('Cinsiyet seçin.')
    setBusy(true)
    try {
      const r = await api.post<QuickRegisterResult>('/api/quick-register', {
        chipNo: v.value,
        ownerId: owner?.id,
        owner: newOwner ? { ...o, tckn: o.tckn || undefined } : undefined,
        animal: { ...a, breed: a.breed || undefined, color: a.color || undefined },
        implant: { ...imp, passportNo: imp.passportNo || undefined, lotNo: imp.lotNo || undefined },
      })
      qc.invalidateQueries()
      const name = trTitleCase(a.name)
      const msg =
        r.petvetStatus === 'missing_info'
          ? `${name} kaydedildi. PETVET görevi açıldı ama sahibin TCKN'si eksik.`
          : r.petvetStatus
            ? `${name} kaydedildi. PETVET'e en geç ${formatDateTr(r.dueDate)} tarihinde girilmeli.`
            : `${name} kaydedildi.`
      toast(msg)
      if (campaign) {
        setCount((c) => c + 1)
        reset()
      } else {
        nav(`/hayvanlar/${r.animalId}`)
      }
    } catch (e) {
      const he = e as HttpError
      if (he.code === 'DUPLICATE_TCKN') {
        const id = (he.details as { ownerId?: string })?.ownerId
        setErr(he.message + (id ? ' Mevcut sahibi seçmek için sahip alanında TCKN ile arayın.' : ''))
      } else setErr(he.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Hızlı kayıt</h1>
        <span className="mut">çip -> sahip -> hayvan -> uygulama</span>
        <label className="ck right">
          <input type="checkbox" checked={campaign} onChange={(e) => setCampaign(e.target.checked)} />
          Kampanya modu (kaydettikten sonra formu temizle){campaign && <> - bu oturumda <strong className="mono">{count}</strong></>}
        </label>
      </div>

      <form ref={formRef} className="pnl" onSubmit={submit} style={{ maxWidth: 1080 }}>
        <fieldset className="sec">
          <legend>Çip</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <Field label="Çip numarası *" htmlFor="cip" style={{ flex: '0 1 320px' }}>
              <input
                id="cip"
                ref={chipRef}
                data-chip-input
                className="inp mono"
                style={{ height: 36, fontSize: 16, borderWidth: v ? 2 : 1, borderColor: v ? (v.ok && !registered ? 'var(--ok)' : 'var(--red)') : undefined }}
                value={chip}
                onChange={(e) => setChip(e.target.value)}
                onBlur={() => v?.ok && setChip(formatChip(v.value))}
                placeholder="Okuyucuyu çipe tutun"
                autoFocus
                autoComplete="off"
              />
            </Field>
            <div style={{ minHeight: 36, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {v && !v.ok && <span className="st s-red">{v.error}</span>}
              {v?.ok && lookup.isLoading && <span className="mut">Kontrol ediliyor...</span>}
              {v?.ok && registered && (
                <span className="st s-red">
                  Bu çip {registered.animal.name} adına kayıtlı. <Link to={`/hayvanlar/${registered.animal.id}`}>Kaydı aç</Link>
                </span>
              )}
              {v?.ok && lookup.data && !registered && (
                <span className="st s-ok">
                  Geçerli - {v.code === 792 ? '792 Türkiye' : v.codeKind === 'manufacturer' ? 'üretici kodu' : v.codeKind === 'test' ? 'test çipi' : 'yurt dışı'} - klinikte kayıtlı değil
                </span>
              )}
              {v?.ok && v.warnings.map((w) => <span key={w} className="st s-amb">{w}</span>)}
            </div>
          </div>
        </fieldset>

        <fieldset className="sec">
          <legend>Sahip</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {owner ? (
              <div style={{ border: '1px solid var(--accent)', background: '#eef3fa', borderRadius: 2, padding: '8px 10px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{owner.label}</strong>
                {owner.tcknLast4 ? <span className="st s-ok">TCKN ****{owner.tcknLast4}</span> : <span className="st s-amb">TCKN yok - PETVET için gerekli</span>}
                <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setOwner(null)}>Değiştir</button>
              </div>
            ) : newOwner ? (
              <>
                <div className="g4">
                  <Field label="Ad *" htmlFor="oa"><input id="oa" className="inp" value={o.firstName} onChange={(e) => setO({ ...o, firstName: e.target.value })} required /></Field>
                  <Field label="Soyad *" htmlFor="os"><input id="os" className="inp" value={o.lastName} onChange={(e) => setO({ ...o, lastName: e.target.value })} required /></Field>
                  <Field label="TCKN (PETVET için)" htmlFor="ot" error={o.tckn && !isValidTckn(o.tckn) ? 'TCKN geçersiz' : undefined}>
                    <input id="ot" className="inp mono" inputMode="numeric" maxLength={11} value={o.tckn} onChange={(e) => setO({ ...o, tckn: e.target.value.replace(/\D/g, '') })} />
                  </Field>
                  <Field label="Cep telefonu *" htmlFor="op" error={o.phone && !normalizeTrMobile(o.phone) ? '5XX XXX XX XX' : undefined}>
                    <input id="op" className="inp mono" value={o.phone} onChange={(e) => setO({ ...o, phone: e.target.value })} required />
                  </Field>
                  <Field label="İl" htmlFor="oc"><input id="oc" className="inp" value={o.city} onChange={(e) => setO({ ...o, city: e.target.value })} /></Field>
                  <Field label="İlçe" htmlFor="od"><input id="od" className="inp" value={o.district} onChange={(e) => setO({ ...o, district: e.target.value })} /></Field>
                  <Field label="Adres" htmlFor="oadr" style={{ gridColumn: 'span 2' }}><input id="oadr" className="inp" value={o.address} onChange={(e) => setO({ ...o, address: e.target.value })} /></Field>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="ck"><input type="checkbox" checked={o.kvkkNotice} onChange={(e) => setO({ ...o, kvkkNotice: e.target.checked })} required />KVKK aydınlatma metni verildi *</label>
                  <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setNewOwner(false)}>Mevcut sahip ara</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Ara: ad, telefon, TCKN" htmlFor="oq" style={{ flex: '1 1 320px' }}>
                    <input id="oq" className="inp" value={ownerQ} onChange={(e) => setOwnerQ(e.target.value)} autoComplete="off" />
                  </Field>
                  <button type="button" className="btn" onClick={() => setNewOwner(true)}>Yeni sahip...</button>
                </div>
                {ownerSearch.data && ownerSearch.data.length > 0 && (
                  <div style={{ border: '1px solid var(--line)', borderRadius: 2 }}>
                    {ownerSearch.data.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        className="list-row"
                        style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line-3)', background: '#fff', textAlign: 'left', cursor: 'pointer' }}
                        onClick={() => setOwner({ id: x.id, label: `${x.fullName} - ${formatTrPhone(x.phone)}`, tcknLast4: x.tcknLast4 })}
                      >
                        <span><strong>{x.fullName}</strong> <span className="mut">- {formatTrPhone(x.phone)} - {[x.city, x.district].filter(Boolean).join(' / ')}</span></span>
                        <span className="mut">{x.animalCount} hayvan</span>
                      </button>
                    ))}
                  </div>
                )}
                {ownerSearch.data?.length === 0 && <span className="mut">Sahip bulunamadı. "Yeni sahip" ile ekleyin.</span>}
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="sec">
          <legend>Hayvan</legend>
          <div className="g4">
            <Field label="Ad *" htmlFor="an"><input id="an" className="inp" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} required /></Field>
            <Field label="Tür *" htmlFor="at">
              <select id="at" className="inp" value={a.species} onChange={(e) => setA({ ...a, species: e.target.value as Species })}>
                {Object.entries(SPECIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Irk" htmlFor="ab"><input id="ab" className="inp" value={a.breed} onChange={(e) => setA({ ...a, breed: e.target.value })} /></Field>
            <Field label="Renk / desen" htmlFor="ac"><input id="ac" className="inp" value={a.color} onChange={(e) => setA({ ...a, color: e.target.value })} /></Field>
            <div className="f" style={{ gridColumn: 'span 2' }}>
              <span className="l">Cinsiyet *</span>
              <div className="rad" role="radiogroup" aria-label="Cinsiyet">
                {(['male', 'female', 'unknown'] as const).map((s) => (
                  <label key={s}><input type="radio" name="sex" checked={a.sex === s} onChange={() => setA({ ...a, sex: s })} />{s === 'male' ? 'Erkek' : s === 'female' ? 'Dişi' : 'Bilinmiyor'}</label>
                ))}
              </div>
            </div>
            <Field label="Doğum tarihi *" htmlFor="ad"><input id="ad" type="date" className="inp" max={today} value={a.birthDate} onChange={(e) => setA({ ...a, birthDate: e.target.value })} required /></Field>
            <div className="f">
              <span className="l">&nbsp;</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <label className="ck"><input type="checkbox" checked={a.birthDateEstimated} onChange={(e) => setA({ ...a, birthDateEstimated: e.target.checked })} />Tahmini</label>
                <label className="ck"><input type="checkbox" checked={a.neutered} onChange={(e) => setA({ ...a, neutered: e.target.checked })} />Kısır</label>
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset className="sec" style={{ borderBottom: 0 }}>
          <legend>Çip uygulama</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="g4">
              <Field label="Tarih *" htmlFor="ut"><input id="ut" type="date" className="inp" max={today} value={imp.date} onChange={(e) => setImp({ ...imp, date: e.target.value })} required /></Field>
              <Field label="Uygulayan hekim *" htmlFor="uh">
                <select id="uh" className="inp" value={imp.vetId} onChange={(e) => setImp({ ...imp, vetId: e.target.value })}>
                  {vetList.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                </select>
              </Field>
              <Field label="Vücut bölgesi *" htmlFor="ub">
                <select id="ub" className="inp" value={imp.bodySite} onChange={(e) => setImp({ ...imp, bodySite: e.target.value })}>
                  {BODY_SITES.map((b) => <option key={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Pasaport no" htmlFor="up"><input id="up" className="inp" value={imp.passportNo} onChange={(e) => setImp({ ...imp, passportNo: e.target.value })} /></Field>
              <Field label="Çip lot / seri" htmlFor="ul"><input id="ul" className="inp" value={imp.lotNo} onChange={(e) => setImp({ ...imp, lotNo: e.target.value })} /></Field>
            </div>
            <label className="ck"><input type="checkbox" checked={imp.verified} onChange={(e) => setImp({ ...imp, verified: e.target.checked })} />Uygulamadan sonra tekrar okutuldu, numara aynı *</label>
          </div>
        </fieldset>

        <div className="form-foot">
          <span className="mut">
            {petvetApplies ? (
              <>
                Açılacak PETVET görevi: yeni çip kaydı - son gün <strong className="mono" style={{ color: 'var(--ink)' }}>{formatDateTr(petvetDueDate('CHIP_NEW', imp.date || today))}</strong>
                {!ownerHasTckn && (owner || newOwner) && <span className="s-amb"> - sahip TCKN'si eksik, görev "eksik bilgi" açılır</span>}
              </>
            ) : (
              'Bu kayıt için PETVET görevi açılmayacak.'
            )}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {err && <span className="err" role="alert">{err}</span>}
            <button type="button" className="btn" onClick={reset}>Temizle</button>
            <button className="btn p" disabled={busy || !!registered}>{busy ? 'Kaydediliyor...' : 'Kaydet'} <span className="k">Ctrl+S</span></button>
          </div>
        </div>
      </form>
    </>
  )
}
