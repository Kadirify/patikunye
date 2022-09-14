// S-107 Çip okuyucu: mod, hız eşiği, canlı test (ham → normalize → doğrulama)
import { useEffect, useRef, useState } from 'react'
import { useCan } from '../../session'
import { cleanChipInput, formatChip, validateChip, type ChipResult } from '@shared/chip'
import { NoAccess, Row, errText, useCtrlS, useSaveSettings, useSettings, type FullSettings } from './common'

type ReaderS = FullSettings['reader']

export function ReaderSettingsPage() {
  const can = useCan()
  const s = useSettings()
  const save = useSaveSettings('Okuyucu ayarları kaydedildi.')
  const [r, setR] = useState<ReaderS | null>(null)
  useEffect(() => {
    if (s.data && !r) setR(s.data.reader)
  }, [s.data, r])
  const dirty = !!r && JSON.stringify(r) !== JSON.stringify(s.data?.reader)
  const submit = () => r && save.mutate({ reader: { ...r, serialPath: r.serialPath || undefined } })
  useCtrlS(submit, dirty)

  if (!can('settings.manage')) return <NoAccess />
  if (!r) return <div className="mut">Yükleniyor…</div>

  return (
    <>
      <div className="page-head"><h1>Çip okuyucu</h1></div>
      <form
        className="pnl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="ph"><h2>Bağlantı</h2></div>
        <Row label="Mod">
          <div className="rad" role="radiogroup" aria-label="Okuyucu modu">
            <label><input type="radio" checked={r.mode === 'keyboard'} onChange={() => setR({ ...r, mode: 'keyboard' })} />Klavye (HID)</label>
            <label><input type="radio" checked={r.mode === 'serial'} onChange={() => setR({ ...r, mode: 'serial' })} />Seri port (COM)</label>
          </div>
        </Row>
        {r.mode === 'serial' && (
          <>
            <Row label="Port" htmlFor="r-port">
              <input id="r-port" className="inp mono" style={{ width: 120 }} placeholder="COM3" value={r.serialPath ?? ''} onChange={(e) => setR({ ...r, serialPath: e.target.value })} />
            </Row>
            <Row label="Baud" htmlFor="r-baud">
              <select id="r-baud" className="inp mono" style={{ width: 120 }} value={r.baudRate ?? 9600} onChange={(e) => setR({ ...r, baudRate: Number(e.target.value) })}>
                {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b}>{b}</option>)}
              </select>
            </Row>
          </>
        )}
        <Row label="Hız eşiği" htmlFor="r-gap">
          <input id="r-gap" type="number" min={5} max={300} className="inp mono" style={{ width: 80 }} value={r.maxGapMs} onChange={(e) => setR({ ...r, maxGapMs: Number(e.target.value) })} />
          <span>ms</span>
          <span className="mut" style={{ fontSize: 12 }}>Tuşlar arası bu süreden kısa gelen giriş okuyucu sayılır. Varsayılan 35 ms ⚠️ okuyucuyla test edin.</span>
        </Row>
        <Row label="Ses" last>
          <label className="ck"><input type="checkbox" checked={r.sound ?? true} onChange={(e) => setR({ ...r, sound: e.target.checked })} />Okumada ses çal</label>
        </Row>
        <div className="form-foot">
          <span className="err">{save.isError ? errText(save.error) : ''}</span>
          <button className="btn p" disabled={!dirty || save.isPending}>Kaydet <span className="k">Ctrl+S</span></button>
        </div>
      </form>
      <LiveTest maxGapMs={r.maxGapMs} />
    </>
  )
}

function LiveTest({ maxGapMs }: { maxGapMs: number }) {
  const [raw, setRaw] = useState('')
  const [res, setRes] = useState<{ raw: string; cleaned: string; result: ChipResult; avgGap: number | null; maxGap: number | null } | null>(null)
  const times = useRef<number[]>([])

  function evaluate(value: string) {
    const t = times.current
    const gaps = t.slice(1).map((x, i) => x - t[i])
    setRes({
      raw: value,
      cleaned: cleanChipInput(value),
      result: validateChip(value),
      avgGap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      maxGap: gaps.length ? Math.max(...gaps) : null,
    })
    times.current = []
    setRaw('')
  }

  return (
    <section className="pnl">
      <div className="ph"><h2>Canlı test</h2><span className="mut" style={{ fontSize: 12 }}>Alana tıklayın ve bir çipi okutun (ya da yazıp Enter'a basın)</span></div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          className="inp mono"
          style={{ height: 38, fontSize: 16 }}
          data-chip-input
          aria-label="Okuyucu test alanı"
          placeholder="Okutulan değer burada görünür"
          value={raw}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (raw.trim()) evaluate(raw)
            } else if (e.key.length === 1) times.current.push(performance.now())
          }}
          onChange={(e) => setRaw(e.target.value)}
        />
        {res && (
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Ham değer</dt>
            <dd className="mono">{JSON.stringify(res.raw)}</dd>
            <dt>Temizlenmiş</dt>
            <dd className="mono">{res.cleaned || '—'}</dd>
            <dt>Sonuç</dt>
            <dd>
              {res.result.ok ? (
                <>
                  <span className="st s-ok">Geçerli · {res.result.format === 'iso' ? 'ISO 15 hane' : 'eski format'}</span>{' '}
                  <strong className="mono">{formatChip(res.result.value)}</strong>
                  {res.result.convertedFromHex && <span className="mut"> (hex'ten çevrildi)</span>}
                  {res.result.warnings.map((w) => <div key={w} className="s-amb" style={{ fontSize: 12 }}>{w}</div>)}
                </>
              ) : (
                <span className="st s-red">{res.result.error}</span>
              )}
            </dd>
            <dt>Tuş aralığı</dt>
            <dd className="mono">
              {res.avgGap === null ? '—' : `ort. ${res.avgGap} ms · en uzun ${res.maxGap} ms`}{' '}
              {res.maxGap !== null && (res.maxGap <= maxGapMs ? <span className="s-ok">okuyucu olarak algılanır</span> : <span className="s-amb">eşikten yavaş ({maxGapMs} ms) — elle yazım gibi görünür</span>)}
            </dd>
          </dl>
        )}
      </div>
    </section>
  )
}
