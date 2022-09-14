// Code 128 B barkod (SVG). Kodlama: @shared/reports encodeCode128B (birim testli).
import { code128Bars } from '@shared/reports'

export function Barcode({ value, height = 26, quiet = 10, label }: { value: string; height?: number; quiet?: number; label?: string }) {
  let data: ReturnType<typeof code128Bars>
  try {
    data = code128Bars(value, quiet)
  } catch {
    return null
  }
  return (
    <svg
      viewBox={`0 0 ${data.width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      role="img"
      aria-label={label ?? `Barkod (Code 128): ${value}`}
      style={{ display: 'block' }}
    >
      <g fill="#000">
        {data.bars.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={b.w} height={height} />
        ))}
      </g>
    </svg>
  )
}
