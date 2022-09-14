// ISO 11784/11785 (FDX-B) mikroçip numarası doğrulama ve normalleştirme.
// Ondalık gösterim: 3 hane ülke/üretici kodu + 12 hane kimlik. Kontrol hanesi yoktur.

// ISO 3166-1 sayısal ülke kodları
const COUNTRY_CODES = new Set([
  4, 8, 10, 12, 16, 20, 24, 28, 31, 32, 36, 40, 44, 48, 50, 51, 52, 56, 60, 64, 68, 70, 72, 74, 76, 84, 86, 90,
  92, 96, 100, 104, 108, 112, 116, 120, 124, 132, 136, 140, 144, 148, 152, 156, 158, 162, 166, 170, 174, 175,
  178, 180, 184, 188, 191, 192, 196, 203, 204, 208, 212, 214, 218, 222, 226, 231, 232, 233, 234, 238, 239, 242,
  246, 248, 250, 254, 258, 260, 262, 266, 268, 270, 275, 276, 288, 292, 296, 300, 304, 308, 312, 316, 320, 324,
  328, 332, 334, 336, 340, 344, 348, 352, 356, 360, 364, 368, 372, 376, 380, 384, 388, 392, 398, 400, 404, 408,
  410, 414, 417, 418, 422, 426, 428, 430, 434, 438, 440, 442, 446, 450, 454, 458, 462, 466, 470, 474, 478, 480,
  484, 492, 496, 498, 499, 500, 504, 508, 512, 516, 520, 524, 528, 531, 533, 534, 535, 540, 548, 554, 558, 562,
  566, 570, 574, 578, 580, 581, 583, 584, 585, 586, 591, 598, 600, 604, 608, 612, 616, 620, 624, 626, 630, 634,
  638, 642, 643, 646, 652, 654, 659, 660, 662, 663, 666, 670, 674, 678, 682, 686, 688, 690, 694, 702, 703, 704,
  705, 706, 710, 716, 724, 728, 729, 732, 740, 744, 748, 752, 756, 760, 762, 764, 768, 772, 776, 780, 784, 788,
  792, 795, 796, 798, 800, 804, 807, 818, 826, 831, 832, 833, 834, 840, 850, 854, 858, 860, 862, 876, 882, 887,
  894,
])

export const TURKEY_CODE = 792

export type ChipFormat = 'iso' | 'legacy'
export type ChipCodeKind = 'country' | 'manufacturer' | 'test'

export type ChipResult =
  | {
      ok: true
      value: string
      format: ChipFormat
      code?: number
      codeKind?: ChipCodeKind
      convertedFromHex?: boolean
      warnings: string[]
    }
  | { ok: false; input: string; error: string; suggestion?: string }

/** Okuyucudan ya da elle gelen değeri temizler: boşluk, tire, nokta ve yaygın ön/son ekleri atar. */
export function cleanChipInput(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^(LA|ID|\*|#)+/, '')
    .replace(/[\s.\-_*#]/g, '')
}

/**
 * 16 hane hex FDX-B ham kimliğini ondalık 15 haneye çevirir.
 * Alt 38 bit = ulusal kimlik, sonraki 10 bit = ülke/üretici kodu.
 * Bit sırası okuyucuya göre değişebilir; okuyucu bazında test edilmeli.
 */
export function fdxbHexToDecimal(hex: string): string | null {
  if (!/^[0-9A-F]{16}$/.test(hex)) return null
  const n = BigInt('0x' + hex)
  const national = n & ((1n << 38n) - 1n)
  const code = (n >> 38n) & ((1n << 10n) - 1n)
  if (code > 999n || national > 999_999_999_999n) return null
  return code.toString().padStart(3, '0') + national.toString().padStart(12, '0')
}

export function classifyCode(code: number): ChipCodeKind | null {
  if (code === 999) return 'test'
  if (code >= 900 && code <= 998) return 'manufacturer'
  if (COUNTRY_CODES.has(code)) return 'country'
  return null
}

export function validateChip(raw: string): ChipResult {
  const input = cleanChipInput(raw)
  if (input.length === 0) return { ok: false, input, error: 'Çip numarası boş.' }

  let value = input
  let convertedFromHex = false

  if (/^[0-9A-F]{16}$/.test(input) && /[A-F]/.test(input)) {
    const dec = fdxbHexToDecimal(input)
    if (!dec) return { ok: false, input, error: 'Hex değer FDX-B numarasına çevrilemedi.' }
    value = dec
    convertedFromHex = true
  }

  // Eski 125 kHz (FECAVA/AVID) çipler: 9–10 karakter
  if (/^[0-9A-Z]{9,10}$/.test(value) && !/^\d{15}$/.test(value)) {
    return {
      ok: true,
      value,
      format: 'legacy',
      warnings: ['Eski format çip (ISO değil). PETVET kaydında sorun çıkabilir.'],
    }
  }

  if (!/^\d+$/.test(value)) {
    return { ok: false, input, error: 'Çip numarası yalnızca rakamlardan oluşmalı.' }
  }
  if (value.length !== 15) {
    return { ok: false, input, error: `Çip numarası 15 hane olmalı, ${value.length} hane girildi.` }
  }

  const code = Number(value.slice(0, 3))
  const codeKind = classifyCode(code)
  if (!codeKind) {
    return { ok: false, input, error: `İlk üç hane (${value.slice(0, 3)}) geçerli bir ülke ya da üretici kodu değil.` }
  }

  const warnings: string[] = []
  if (codeKind === 'test') warnings.push('Bu bir test çipidir, gerçek hayvana uygulanmamalı.')
  if (codeKind === 'country' && code !== TURKEY_CODE) warnings.push('Yurt dışı çipi.')
  if (convertedFromHex) warnings.push('Okuyucu hex gönderdi, ondalığa çevrildi. Numarayı kontrol edin.')

  return { ok: true, value, format: 'iso', code, codeKind, convertedFromHex, warnings }
}

/** 792 091 234 567 890 biçiminde gösterim */
export function formatChip(value: string): string {
  if (!/^\d{15}$/.test(value)) return value
  return value.replace(/(\d{3})(?=\d)/g, '$1 ')
}

/** Listelerde kısa gösterim: 792…567 890 */
export function shortChip(value: string): string {
  if (!/^\d{15}$/.test(value)) return value
  return `${value.slice(0, 3)}…${value.slice(9, 12)} ${value.slice(12)}`
}
