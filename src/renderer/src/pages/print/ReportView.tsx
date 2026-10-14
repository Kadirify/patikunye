// Rapor gösterimi: özet, sade çubuk grafik (inline SVG) ve tablolar - Raporlar sayfası ve yazdırma çıktısı ortak kullanır.
import { fmtNum, type CellValue, type ReportChart, type ReportColumn, type ReportResult, type ReportTable } from '@shared/reports'

const ACCENT = '#1E4E9C'

export function cellText(v: CellValue, col: ReportColumn): string {
  if (v === null || v === undefined || v === '') return col.num ? '-' : ''
  if (typeof v === 'number') return Number.isInteger(v) ? fmtNum(v) : fmtNum(v, 1)
  return v
}

/** Sade çubuk grafik: az kalemde yatay, çok kalemde (zaman serisi) dikey sütun */
export function BarChart({ chart }: { chart: ReportChart }) {
  const bars = chart.bars
  if (!bars.length) return null
  const max = Math.max(...bars.map((b) => b.value), chart.unit === '%' ? 100 : 1)
  const fmt = (v: number) => (chart.unit === '%' ? `%${fmtNum(v, Number.isInteger(v) ? 0 : 1)}` : fmtNum(v))
  if (bars.length <= 12) {
    const row = 22
    const labelW = 150
    const W = 640
    const barW = W - labelW - 70
    const H = bars.length * row + 4
    return (
      <figure style={{ margin: 0 }}>
        <figcaption style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{chart.title}</figcaption>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} role="img" aria-label={chart.title}>
          {bars.map((b, i) => {
            const y = i * row + 2
            const w = Math.max(b.value > 0 ? 1 : 0, (b.value / max) * barW)
            return (
              <g key={i}>
                <text x={labelW - 8} y={y + 14} textAnchor="end" fontSize="11" fill="#2E2C29">
                  {b.label.length > 24 ? b.label.slice(0, 23) + '...' : b.label}
                </text>
                <rect x={labelW} y={y + 3} width={barW} height={row - 8} fill="#F2F0EB" />
                <rect x={labelW} y={y + 3} width={w} height={row - 8} fill={ACCENT} />
                <text x={labelW + w + 6} y={y + 14} fontSize="11" fill="#1D1C1A" fontFamily="IBM Plex Mono, monospace">
                  {fmt(b.value)}
                </text>
              </g>
            )
          })}
        </svg>
      </figure>
    )
  }
  // Dikey sütunlar (gün/ay serisi)
  const W = 640
  const H = 170
  const base = H - 30
  const step = W / bars.length
  const colW = Math.max(2, step * 0.7)
  const labelEvery = Math.ceil(bars.length / 16)
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{chart.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} role="img" aria-label={chart.title}>
        <line x1={0} x2={W} y1={base + 0.5} y2={base + 0.5} stroke="#CFCAC0" />
        <text x={2} y={10} fontSize="10" fill="#5E5A53" fontFamily="IBM Plex Mono, monospace">
          en yüksek {fmt(Math.max(...bars.map((b) => b.value)))}
        </text>
        {bars.map((b, i) => {
          const h = (b.value / max) * (base - 18)
          const x = i * step + (step - colW) / 2
          return (
            <g key={i}>
              <rect x={x} y={base - h} width={colW} height={h} fill={ACCENT}>
                <title>{`${b.label}: ${fmt(b.value)}`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={x + colW / 2} y={base + 14} fontSize="9" textAnchor="middle" fill="#5E5A53">
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

export function ReportTableView({ table, compact }: { table: ReportTable; compact?: boolean }) {
  const pad = compact ? '3px 6px' : undefined
  return (
    <div className="rp-table">
      <h3 style={{ fontSize: compact ? 11 : 13, fontWeight: 600, margin: compact ? '10px 0 4px' : '0', padding: compact ? 0 : '10px 12px 6px' }}>{table.title}</h3>
      {table.rows.length === 0 ? (
        <div className={compact ? undefined : 'empty'} style={compact ? { fontSize: 10, color: '#5E5A53' } : { padding: '12px 16px' }}>
          {table.empty ?? 'Kayıt yok.'}
        </div>
      ) : (
        <div className={compact ? undefined : 'tbl-wrap'}>
          <table>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} style={{ textAlign: c.num ? 'right' : 'left', padding: pad }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} style={r[table.columns[0].key] === 'Toplam' ? { fontWeight: 600 } : undefined}>
                  {table.columns.map((c) => (
                    <td key={c.key} className={c.mono || c.num ? 'mono' : undefined} style={{ textAlign: c.num ? 'right' : 'left', padding: pad }}>
                      {cellText(r[c.key] ?? null, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.total && table.total > table.rows.length && (
            <div className="tfoot">
              İlk {fmtNum(table.rows.length)} satır gösteriliyor (toplam {fmtNum(table.total)}). Tamamı için CSV'ye aktarın.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ReportSummary({ r }: { r: ReportResult }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid #CFCAC0', borderRadius: 3, background: '#fff' }}>
      {r.summary.map((s) => (
        <div key={s.label} style={{ padding: '8px 14px', borderRight: '1px solid #E4E1DA', minWidth: 110 }}>
          <div className="mono" style={{ fontSize: 18 }}>{s.value}</div>
          <div style={{ fontSize: 11, color: '#5E5A53' }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}
