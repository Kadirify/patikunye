// Yazdırma önizlemesi (/yazdir/:kind/:id?): menüsüz, ayrı pencere. Üstte ekranda görünen ama baskıda gizli araç çubuğu.
// Sayfa boyutu ?size=a4|a5|card; sayfa altı "PatiKünye · tarih · sayfa" @page kenar kutularıyla basılır (Chromium 131+).
import { useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { useCan } from '../../session'
import { formatDateTr } from '@shared/petvet'
import type {
  PrintAppointmentCard,
  PrintAuditPack,
  PrintChipCard,
  PrintEnvelope,
  PrintKvkkConsent,
  PrintKvkkResponse,
  PrintVaccineCard,
  PrintVisit,
  PrintWorklist,
  ReportResult,
} from '@shared/reports'
import {
  AppointmentCardDoc,
  AuditPackDoc,
  ChipCardDoc,
  KvkkConsentDoc,
  KvkkResponseDoc,
  PrescriptionDoc,
  ReportDoc,
  VaccineCardDoc,
  VisitDoc,
  WorklistDoc,
} from './outputs'

type Size = 'a4' | 'a5' | 'card'
const SIZE_LABEL: Record<Size, string> = { a4: 'A4', a5: 'A5', card: 'Kart (85,6 × 54 mm)' }

const KIND_META: Record<string, { title: string; sizes: Size[] }> = {
  'vaccine-card': { title: 'Aşı karnesi', sizes: ['a4', 'a5'] },
  'chip-card': { title: 'Kayıt / çip kartı', sizes: ['card', 'a5', 'a4'] },
  visit: { title: 'Muayene özeti', sizes: ['a4', 'a5'] },
  prescription: { title: 'Tedavi talimatı', sizes: ['a4', 'a5'] },
  'kvkk-consent': { title: 'Aydınlatma ve onam formu', sizes: ['a4'] },
  'audit-pack': { title: 'PETVET denetim paketi', sizes: ['a4'] },
  'kvkk-response': { title: 'KVKK başvuru yanıtı', sizes: ['a4'] },
  'appointment-card': { title: 'Randevu kartı', sizes: ['card', 'a5'] },
  worklist: { title: 'İş listesi', sizes: ['a4'] },
  report: { title: 'Rapor', sizes: ['a4'] },
}

const PAGE_SIZE: Record<Size, string> = { a4: 'A4', a5: 'A5', card: '85.6mm 54mm' }
const SHEET_W: Record<Size, string> = { a4: '210mm', a5: '148mm', card: '85.6mm' }

function printCss(size: Size, footer: string, landscape: boolean) {
  const card = size === 'card'
  const esc = footer.replace(/"/g, '\\"')
  return `
  html, body, #root { background: #E3E0D9; height: auto; }
  .prt { font-family: var(--sans); color: #1D1C1A; font-size: ${size === 'a5' ? '8.5pt' : '9.5pt'}; line-height: 1.4; }
  .prt .mut { color: #5E5A53; }
  .prt .mono { font-family: var(--mono); }
  .prt .r { text-align: right; }
  .prt-bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px; background: #F7F6F3; border-bottom: 1px solid #CFCAC0; }
  .prt-sheet { width: ${card ? 'auto' : SHEET_W[size]}; min-height: ${card ? '0' : size === 'a5' ? '210mm' : '297mm'}; margin: 16px auto; background: #fff; padding: ${card ? '8mm' : size === 'a5' ? '10mm 10mm 14mm' : '14mm 14mm 16mm'}; box-shadow: 0 1px 4px rgba(29,28,26,.18); box-sizing: border-box; }
  .prt-foot { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #CFCAC0; font-size: 7.5pt; color: #5E5A53; display: flex; justify-content: space-between; }
  .lh { display: flex; justify-content: space-between; gap: 8mm; padding-bottom: 3mm; border-bottom: 1.5px solid #1D1C1A; margin-bottom: 4mm; }
  .sec-p { margin: 0 0 4mm; break-inside: avoid; }
  .sec-p > h2 { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #5E5A53; margin: 0 0 1.5mm; padding-bottom: 1mm; border-bottom: 1px solid #E4E1DA; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .kvg { display: grid; gap: 1mm 3mm; margin: 0; }
  .kvg dt { color: #5E5A53; white-space: nowrap; }
  .kvg dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .prt table { border-collapse: collapse; width: 100%; }
  .prt th { background: none; font-size: 8pt; color: #5E5A53; font-weight: 600; padding: 1.2mm 1.5mm; border-bottom: 1px solid #1D1C1A; text-align: left; white-space: nowrap; }
  .prt td { padding: 1.2mm 1.5mm; border-bottom: 1px solid #CFCAC0; vertical-align: top; }
  .prt table.small { font-size: 7.5pt; }
  .prt tr { break-inside: avoid; }
  .prt thead { display: table-header-group; }
  .legal { white-space: pre-wrap; font-size: 8.5pt; line-height: 1.5; }
  .note-box { border: 1px solid #1D1C1A; padding: 2mm 3mm; margin: 0 0 4mm; }
  .sigs { display: flex; gap: 10mm; justify-content: flex-end; margin-top: 10mm; break-inside: avoid; }
  .sig { width: 65mm; }
  .sig-line { border-top: 1px solid #1D1C1A; padding-top: 1mm; }
  .cover { min-height: 240mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
  .cards { display: flex; flex-wrap: wrap; gap: 8mm; }
  .card { width: 85.6mm; height: 54mm; box-sizing: border-box; border: 1px solid #9C968B; border-radius: 3mm; background: #fff; padding: 3.5mm 4mm; display: flex; flex-direction: column; overflow: hidden; }
  .photo-box { width: 17mm; height: 21mm; border: 1px solid #CFCAC0; flex: none; display: flex; align-items: center; justify-content: center; font-size: 6pt; color: #5E5A53; }
  .rp-print .rp-table h3 { font-size: 9pt; }
  @page { size: ${PAGE_SIZE[size]}${landscape ? ' landscape' : ''}; margin: ${card ? '0' : size === 'a5' ? '10mm 10mm 14mm' : '14mm 14mm 16mm'};
    ${card ? '' : `@bottom-center { content: "${esc} · Sayfa " counter(page) " / " counter(pages); font-family: 'IBM Plex Sans', sans-serif; font-size: 7.5pt; color: #5E5A53; }`}
  }
  @media print {
    html, body, #root { background: #fff !important; }
    .no-print { display: none !important; }
    .prt-sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .prt-foot { display: none; }
    ${card ? `.cards { display: block; } .card { border: 0; border-radius: 0; break-after: page; }` : ''}
  }`
}

export function PrintPage() {
  const { kind = '', id } = useParams()
  const [sp, setSp] = useSearchParams()
  const can = useCan()
  const meta = KIND_META[kind]
  const size: Size = (meta?.sizes.includes(sp.get('size') as Size) ? sp.get('size') : meta?.sizes[0]) as Size
  const serverQs = useMemo(() => {
    const p = new URLSearchParams(sp)
    p.delete('size')
    p.delete('yatay')
    return p.toString()
  }, [sp])
  const landscape = sp.get('yatay') === '1'

  const q = useQuery({
    queryKey: ['print', kind, id, serverQs],
    queryFn: () => api.get<PrintEnvelope>(`/api/print/${kind}${id ? '/' + id : ''}${serverQs ? '?' + serverQs : ''}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: !!meta,
  })

  const env = q.data
  const docTitle =
    kind === 'audit-pack' && env
      ? (env.data as PrintAuditPack).fileName.replace(/\.pdf$/, '')
      : `PatiKunye_${meta?.title.replace(/[^\p{L}\p{N}]+/gu, '_') ?? kind}_${env?.today ?? ''}`
  useEffect(() => {
    document.title = docTitle
  }, [docTitle])

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(sp)
    if (v === null) p.delete(k)
    else p.set(k, v)
    setSp(p, { replace: true })
  }

  const footer = `PatiKünye ile oluşturuldu · ${env ? formatDateTr(env.today) : ''}`
  let body: React.ReactNode = null
  if (env) {
    const c = env.clinic
    const t = env.today
    switch (kind) {
      case 'vaccine-card': body = <VaccineCardDoc d={env.data as PrintVaccineCard} clinic={c} today={t} />; break
      case 'chip-card': body = <ChipCardDoc d={env.data as PrintChipCard} clinic={c} />; break
      case 'visit': body = <VisitDoc d={env.data as PrintVisit} clinic={c} today={t} />; break
      case 'prescription': body = <PrescriptionDoc d={env.data as PrintVisit} clinic={c} today={t} />; break
      case 'kvkk-consent': body = <KvkkConsentDoc d={env.data as PrintKvkkConsent} clinic={c} today={t} />; break
      case 'audit-pack': body = <AuditPackDoc d={env.data as PrintAuditPack} clinic={c} today={t} />; break
      case 'kvkk-response': body = <KvkkResponseDoc d={env.data as PrintKvkkResponse} clinic={c} today={t} />; break
      case 'appointment-card': body = <AppointmentCardDoc d={env.data as PrintAppointmentCard} clinic={c} />; break
      case 'worklist': body = <WorklistDoc d={env.data as PrintWorklist} clinic={c} today={t} />; break
      case 'report': body = <ReportDoc d={env.data as ReportResult} clinic={c} today={t} />; break
    }
  }

  return (
    <div className="prt">
      <style>{printCss(size, footer, landscape)}</style>
      <div className="prt-bar no-print" role="toolbar" aria-label="Yazdırma">
        <strong>{meta?.title ?? 'Yazdırma'}</strong>
        {meta && meta.sizes.length > 1 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
            Boyut
            <select className="inp" style={{ width: 'auto' }} value={size} onChange={(e) => setParam('size', e.target.value)}>
              {meta.sizes.map((s) => <option key={s} value={s}>{SIZE_LABEL[s]}</option>)}
            </select>
          </label>
        )}
        {(kind === 'audit-pack' || kind === 'worklist' || kind === 'report') && (
          <label className="ck" style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={landscape} onChange={(e) => setParam('yatay', e.target.checked ? '1' : null)} /> Yatay sayfa
          </label>
        )}
        {kind === 'visit' && can('visits.read') && (
          <div className="rad" style={{ marginLeft: 12 }} role="radiogroup" aria-label="Sürüm">
            <label><input type="radio" checked={sp.get('full') !== '1'} onChange={() => setParam('full', null)} /> Sahip sürümü</label>
            <label><input type="radio" checked={sp.get('full') === '1'} onChange={() => setParam('full', '1')} /> Tam sürüm (iç notlar)</label>
          </div>
        )}
        {kind === 'chip-card' && (
          <label className="ck" style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={sp.get('owner') === '1'} onChange={(e) => setParam('owner', e.target.checked ? '1' : null)} /> Sahip adı ve telefonu (sahip onayıyla)
          </label>
        )}
        {kind === 'kvkk-response' && <span className="mut" style={{ marginLeft: 12 }}>Şablon metin; gönderilmeden önce hukukçu tarafından gözden geçirilmelidir.</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn p" onClick={() => window.print()} disabled={!env}>Yazdır</button>
          <button className="btn" onClick={() => window.close()}>Kapat</button>
        </span>
      </div>
      {!meta && <div className="alert" style={{ margin: 16 }}>Bilinmeyen çıktı türü: {kind}</div>}
      {q.isLoading && <div className="mut" style={{ padding: 24 }}>Hazırlanıyor…</div>}
      {q.isError && <div className="alert" style={{ margin: 16 }}>{(q.error as Error).message}</div>}
      {env && (
        <main className="prt-sheet">
          {body}
          {size !== 'card' && (
            <footer className="prt-foot">
              <span>PatiKünye ile oluşturuldu · {formatDateTr(env.today)}</span>
              <span>Sayfa numaraları baskıda eklenir</span>
            </footer>
          )}
        </main>
      )}
    </div>
  )
}
