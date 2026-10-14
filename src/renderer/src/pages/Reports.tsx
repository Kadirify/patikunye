// Raporlar modülü: Raporlar sayfası + yazdırma önizlemesi (PrintPage, ./print/*)
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, qs } from '../api'
import { openPrint } from '../print'
import { useToast } from '../ui'
import { addDaysIso, PETVET_KIND_LABEL, PETVET_TASK_KINDS, type PetvetTaskKind } from '@shared/petvet'
import type { ReportResult, ReportsMetaDto } from '@shared/reports'
import { BarChart, ReportSummary, ReportTableView } from './print/ReportView'

export { PrintPage } from './print/PrintPage'

const monthStart = (iso: string) => iso.slice(0, 8) + '01'
function prevMonth(iso: string): [string, string] {
  const end = addDaysIso(monthStart(iso), -1)
  return [monthStart(end), end]
}

const PRESETS: { label: string; range: (t: string) => [string, string] }[] = [
  { label: 'Bu ay', range: (t) => [monthStart(t), t] },
  { label: 'Geçen ay', range: prevMonth },
  { label: 'Son 30 gün', range: (t) => [addDaysIso(t, -29), t] },
  { label: 'Bu yıl', range: (t) => [t.slice(0, 4) + '-01-01', t] },
]

/** Sol listedeki rapor dışı bölümler */
const EXTRA = [
  { key: 'audit-pack', title: 'PETVET denetim paketi' },
  { key: 'lists', title: 'Yazdırılabilir iş listeleri' },
] as const

export function ReportsPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const meta = useQuery({ queryKey: ['reports-meta'], queryFn: () => api.get<ReportsMetaDto>('/api/reports/meta'), staleTime: 60_000 })
  const m = meta.data
  const sel = params.get('r') ?? m?.reports[0]?.key ?? ''
  const def = m?.reports.find((r) => r.key === sel)
  const extras = EXTRA.filter((e) => (e.key === 'audit-pack' ? m?.canAuditPack : true))

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [vetId, setVetId] = useState('')
  const [lotInput, setLotInput] = useState('')
  const [lot, setLot] = useState('')
  useEffect(() => {
    if (m && !from) {
      setFrom(monthStart(m.today))
      setTo(m.today)
    }
  }, [m, from])

  const effVet = m?.fixedVetId ?? vetId
  const filter = { from, to, vetId: def?.usesVet ? effVet || undefined : undefined, lot: sel === 'vaccines' ? lot || undefined : undefined }
  const rangeOk = !!from && !!to && from <= to
  const report = useQuery({
    queryKey: ['report', sel, filter],
    queryFn: () => api.get<ReportResult>(`/api/reports/${sel}${qs(filter)}`),
    enabled: !!def && rangeOk,
  })

  async function downloadCsv() {
    try {
      const url = await api.blobUrl(`/api/reports/${sel}/csv${qs(filter)}`)
      const a = document.createElement('a')
      a.href = url
      a.download = `PatiKunye_${sel}_${from}_${to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      toast((e as Error).message)
    }
  }
  const printParams = () => Object.fromEntries(Object.entries(filter).filter(([, v]) => !!v)) as Record<string, string>

  if (meta.isError) return <div className="alert">{(meta.error as Error).message}</div>
  if (!m) return <div className="mut">Yükleniyor...</div>

  const r = report.data
  return (
    <>
      <div className="page-head">
        <h1>Raporlar</h1>
        <span className="mut">{m.fixedVetId ? 'Yalnızca kendi kayıtlarınız gösterilir.' : 'Tarih aralığı ve hekime göre'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <nav aria-label="Raporlar" style={{ flex: '0 1 210px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span className="grp" style={{ padding: '4px 10px 6px' }}>Raporlar</span>
          {m.reports.map((x) => (
            <button
              key={x.key}
              type="button"
              className={`nav${sel === x.key ? ' active' : ''}`}
              style={{ height: 30, background: sel === x.key ? undefined : 'transparent', cursor: 'pointer', textAlign: 'left' }}
              aria-current={sel === x.key ? 'page' : undefined}
              onClick={() => setParams({ r: x.key })}
            >
              {x.title}
            </button>
          ))}
          <span className="grp" style={{ padding: '14px 10px 6px' }}>Çıktılar</span>
          {extras.map((x) => (
            <button
              key={x.key}
              type="button"
              className={`nav${sel === x.key ? ' active' : ''}`}
              style={{ height: 30, background: sel === x.key ? undefined : 'transparent', cursor: 'pointer', textAlign: 'left' }}
              aria-current={sel === x.key ? 'page' : undefined}
              onClick={() => setParams({ r: x.key })}
            >
              {x.title}
            </button>
          ))}
        </nav>

        <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sel === 'audit-pack' && m.canAuditPack ? (
            <AuditPackPanel meta={m} />
          ) : sel === 'lists' ? (
            <ListsPanel meta={m} />
          ) : !def ? (
            <div className="alert amb">Bu raporu görme yetkiniz yok.</div>
          ) : (
            <>
              <section className="pnl">
                <div className="ph">
                  <h2>{def.title}</h2>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {m.canExport && (
                      <>
                        <button className="btn sm" disabled={!r} onClick={() => openPrint('report', sel, printParams())}>Yazdır</button>
                        <button className="btn sm" disabled={!r} onClick={downloadCsv}>CSV</button>
                      </>
                    )}
                  </span>
                </div>
                <div style={{ padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: '10px 14px', alignItems: 'flex-end' }}>
                  {def.usesRange && (
                    <>
                      <div className="f">
                        <label htmlFor="rp-from">Başlangıç</label>
                        <input id="rp-from" className="inp" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
                      </div>
                      <div className="f">
                        <label htmlFor="rp-to">Bitiş</label>
                        <input id="rp-to" className="inp" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {PRESETS.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            className="btn sm"
                            onClick={() => {
                              const [a, b] = p.range(m.today)
                              setFrom(a)
                              setTo(b)
                            }}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {def.usesVet && (
                    <div className="f">
                      <label htmlFor="rp-vet">Hekim</label>
                      <select id="rp-vet" className="inp" style={{ width: 200 }} value={effVet} disabled={!!m.fixedVetId} onChange={(e) => setVetId(e.target.value)}>
                        <option value="">Tüm hekimler</option>
                        {m.vets.map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
                      </select>
                    </div>
                  )}
                  {sel === 'vaccines' && (
                    <form
                      style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}
                      onSubmit={(e) => {
                        e.preventDefault()
                        setLot(lotInput.trim())
                      }}
                    >
                      <div className="f">
                        <label htmlFor="rp-lot">Lot geri çağırma: bu lot kimlere yapıldı?</label>
                        <input id="rp-lot" className="inp mono" value={lotInput} onChange={(e) => setLotInput(e.target.value)} placeholder="Lot no" style={{ width: 200 }} />
                      </div>
                      <button className="btn" type="submit">Ara</button>
                      {lot && <button className="btn" type="button" onClick={() => { setLot(''); setLotInput('') }}>Temizle</button>}
                    </form>
                  )}
                </div>
                {!rangeOk && def.usesRange && <div className="alert" style={{ margin: '0 12px 12px' }}>Başlangıç tarihi bitişten sonra olamaz.</div>}
                <div className="mut" style={{ padding: '0 12px 10px', fontSize: 12 }}>{def.description}</div>
              </section>

              {report.isError && <div className="alert">{(report.error as Error).message}</div>}
              {report.isLoading && <div className="mut">Hazırlanıyor...</div>}
              {r && (
                <>
                  <ReportSummary r={r} />
                  {r.chart && r.chart.bars.length > 0 && (
                    <section className="pnl" style={{ padding: '10px 12px' }}>
                      <BarChart chart={r.chart} />
                    </section>
                  )}
                  {r.tables.map((t) => (
                    <section key={t.title} className="pnl">
                      <ReportTableView table={t} />
                    </section>
                  ))}
                  {r.notes?.map((n) => <p key={n} className="mut" style={{ margin: 0, fontSize: 12 }}>{n}</p>)}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// PETVET denetim paketi - tarih araligi + filtreler -> yazdirma onizlemesi (PDF olarak kaydedilebilir)
function AuditPackPanel({ meta }: { meta: ReportsMetaDto }) {
  const [[from, to], setRange] = useState<[string, string]>(prevMonth(meta.today))
  const [kinds, setKinds] = useState<PetvetTaskKind[]>([])
  const [vetId, setVetId] = useState('')
  const [doneOnly, setDoneOnly] = useState(false)
  const ok = !!from && !!to && from <= to
  const toggle = (k: PetvetTaskKind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))
  return (
    <section className="pnl">
      <div className="ph"><h2>PETVET denetim paketi</h2></div>
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="mut" style={{ margin: 0 }}>
          Kapak, tür bazında özet, satır satır görev listesi (çip, hayvan, sahip - TCKN maskeli, uygulama ve PETVET giriş tarihi, gün farkı, referans no) ve yüklenen belge listesi.
          Önizlemede "Yazdır" -> "PDF olarak kaydet" ile dosya adı otomatik gelir. Oluşturma denetim kaydına yazılır.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px', alignItems: 'flex-end' }}>
          <div className="f">
            <label htmlFor="ap-from">Başlangıç *</label>
            <input id="ap-from" className="inp" type="date" value={from} onChange={(e) => setRange([e.target.value, to])} style={{ width: 150 }} />
          </div>
          <div className="f">
            <label htmlFor="ap-to">Bitiş *</label>
            <input id="ap-to" className="inp" type="date" value={to} onChange={(e) => setRange([from, e.target.value])} style={{ width: 150 }} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn sm" onClick={() => setRange(p.range(meta.today))}>{p.label}</button>
            ))}
          </div>
          <div className="f">
            <label htmlFor="ap-vet">Hekim</label>
            <select id="ap-vet" className="inp" style={{ width: 200 }} value={vetId} onChange={(e) => setVetId(e.target.value)}>
              <option value="">Tüm hekimler</option>
              {meta.vets.map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
            </select>
          </div>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, color: '#3d3a35', marginBottom: 4 }}>Görev türleri (seçilmezse tümü)</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 14px' }}>
            {PETVET_TASK_KINDS.map((k) => (
              <label key={k} className="ck">
                <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} /> {PETVET_KIND_LABEL[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="ck">
          <input type="checkbox" checked={doneOnly} onChange={(e) => setDoneOnly(e.target.checked)} /> Yalnızca tamamlananlar (PETVET'e girilenler)
        </label>
        {!ok && <div className="alert">Geçerli bir tarih aralığı seçin.</div>}
        <div>
          <button
            className="btn p"
            disabled={!ok}
            onClick={() =>
              openPrint('audit-pack', undefined, {
                from,
                to,
                ...(kinds.length ? { kinds: kinds.join(',') } : {}),
                ...(vetId ? { vetId } : {}),
                ...(doneOnly ? { doneOnly: '1' } : {}),
              })
            }
          >
            Denetim paketini oluştur
          </button>
        </div>
      </div>
    </section>
  )
}

// Is listeleri (sade tablo, elle not almak icin)
function ListsPanel({ meta }: { meta: ReportsMetaDto }) {
  const [days, setDays] = useState(7)
  const [vetId, setVetId] = useState(meta.fixedVetId ?? '')
  return (
    <section className="pnl">
      <div className="ph"><h2>Yazdırılabilir iş listeleri</h2></div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div className="f">
            <label htmlFor="wl-vet">PETVET iş listesi - hekim</label>
            <select id="wl-vet" className="inp" style={{ width: 200 }} value={vetId} onChange={(e) => setVetId(e.target.value)}>
              <option value="">Tüm hekimler</option>
              {meta.vets.map((v) => <option key={v.id} value={v.id}>{v.fullName}</option>)}
            </select>
          </div>
          <button className="btn" onClick={() => openPrint('worklist', undefined, { list: 'petvet', ...(vetId ? { vetId } : {}) })}>PETVET iş listesini yazdır</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div className="f">
            <label htmlFor="wl-days">Aşı arama listesi - kaç gün içinde vadesi gelen</label>
            <input id="wl-days" className="inp mono" type="number" min={0} max={90} value={days} onChange={(e) => setDays(Math.max(0, Math.min(90, Number(e.target.value) || 0)))} style={{ width: 100 }} />
          </div>
          <button className="btn" onClick={() => openPrint('worklist', undefined, { list: 'vaccine-calls', days: String(days) })}>Aşı arama listesini yazdır</button>
        </div>
        <p className="mut" style={{ margin: 0, fontSize: 12 }}>Aşı arama listesi gecikmiş aşıları da içerir. Telefonlar sahip kaydından gelir.</p>
      </div>
    </section>
  )
}
