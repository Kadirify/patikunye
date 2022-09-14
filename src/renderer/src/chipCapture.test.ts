import { describe, expect, it } from 'vitest'
import { feedKey, type CaptureState } from './chipCapture'

const opts = { maxGapMs: 35, minLength: 10 }
const fresh = (): CaptureState => ({ buf: '', last: 0, startEl: null, startValue: null })

function type(s: CaptureState, text: string, start: number, gap: number) {
  let t = start
  let out: ReturnType<typeof feedKey> = {}
  for (const ch of text) {
    out = feedKey(s, ch === '\n' ? 'Enter' : ch, t, opts)
    t += gap
  }
  return out
}

describe('çip yakalama', () => {
  it('okuyucu hızında 15 rakam + Enter yakalanır', () => {
    expect(type(fresh(), '792091234567890\n', 1000, 5)).toEqual({ chip: '792091234567890' })
  })
  it('insan hızında yazılan rakamlar yakalanmaz', () => {
    expect(type(fresh(), '792091234567890\n', 1000, 120)).toEqual({ reset: true })
  })
  it('kısa sayı (ör. telefon uzantısı) yakalanmaz', () => {
    expect(type(fresh(), '12345\n', 1000, 5)).toEqual({ reset: true })
  })
  it('yavaş başlangıçtan sonra gelen hızlı dizi yakalanır', () => {
    const s = fresh()
    type(s, '12', 0, 300)
    expect(type(s, '792091234567890\n', 2000, 4)).toEqual({ chip: '792091234567890' })
  })
  it('hex okuyucu çıktısı da yakalanır', () => {
    expect(type(fresh(), '0C6000153F1A2B3C\n', 0, 3)).toEqual({ chip: '0C6000153F1A2B3C' })
  })
})
