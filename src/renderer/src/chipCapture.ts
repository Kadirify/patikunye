// Global çip yakalama.
// USB okuyucular klavye gibi davranır: rakamları çok hızlı yazıp Enter basar.
// İnsan bu hızda yazamaz; tuşlar arası süre eşiğin altındaysa giriş okuyucudan gelmiştir.
import { useEffect, useRef } from 'react'
import { validateChip } from '@shared/chip'

export interface CaptureOptions {
  /** Tuşlar arası en fazla süre (ms). Okuyucuya göre ayarlanır. */
  maxGapMs?: number
  minLength?: number
  onChip(raw: string): void
}

export interface CaptureState {
  buf: string
  last: number
  startEl: Element | null
  startValue: string | null
}

const CHIP_CHAR = /^[0-9A-Fa-f]$/

/** Saf durum makinesi: test edilebilsin diye DOM'dan ayrı. Enter'da okuyucu girişi ise değeri döndürür. */
export function feedKey(
  s: CaptureState,
  key: string,
  now: number,
  opts: { maxGapMs: number; minLength: number },
): { chip?: string; reset?: boolean } {
  if (key === 'Enter') {
    const value = s.buf
    const fast = value.length >= opts.minLength && now - s.last <= opts.maxGapMs * 4
    s.buf = ''
    return fast ? { chip: value } : { reset: true }
  }
  if (!CHIP_CHAR.test(key)) {
    s.buf = ''
    return { reset: true }
  }
  if (s.buf && now - s.last > opts.maxGapMs) s.buf = ''
  s.buf += key
  s.last = now
  return {}
}

/** Çip alanı olarak işaretlenen girişler (data-chip-input) değeri kendisi alır. */
function isChipInput(el: Element | null) {
  return !!el && el instanceof HTMLInputElement && el.dataset.chipInput !== undefined
}

export function useChipCapture({ maxGapMs = 35, minLength = 10, onChip }: CaptureOptions) {
  const cb = useRef(onChip)
  cb.current = onChip

  useEffect(() => {
    const s: CaptureState = { buf: '', last: 0, startEl: null, startValue: null }
    let lastChip = ''
    let lastChipAt = 0

    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const target = document.activeElement
      const now = performance.now()
      // Yeni bir dizi başlıyorsa, alanın o anki değerini sakla (okuyucu girişiyse geri yüklenecek)
      if (e.key !== 'Enter' && (s.buf === '' || now - s.last > maxGapMs)) {
        s.startEl = target
        s.startValue = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : null
      }
      const r = feedKey(s, e.key, now, { maxGapMs, minLength })
      if (!r.chip) return
      // Okuyucu girişi: çip alanındaysa olduğu gibi bırak, değilse yazılanları geri al ve paneli aç
      if (isChipInput(target)) return
      e.preventDefault()
      if ((s.startEl instanceof HTMLInputElement || s.startEl instanceof HTMLTextAreaElement) && s.startValue !== null) {
        const el = s.startEl
        const prev = s.startValue
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
        setter?.call(el, prev)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const v = validateChip(r.chip)
      const key = v.ok ? v.value : r.chip
      const at = Date.now()
      if (key === lastChip && at - lastChipAt < 3000) return // okuyucu tekrarı
      lastChip = key
      lastChipAt = at
      cb.current(r.chip)
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [maxGapMs, minLength])
}
