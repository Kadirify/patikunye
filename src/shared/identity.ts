// TCKN ve telefon doğrulama

/** T.C. Kimlik No (ve 99 ile başlayan yabancı kimlik no) algoritma kontrolü */
export function isValidTckn(raw: string): boolean {
  const s = raw.replace(/\s/g, '')
  if (!/^[1-9]\d{10}$/.test(s)) return false
  const d = s.split('').map(Number)
  const odd = d[0] + d[2] + d[4] + d[6] + d[8]
  const even = d[1] + d[3] + d[5] + d[7]
  const d10 = (((odd * 7 - even) % 10) + 10) % 10
  if (d10 !== d[9]) return false
  const d11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10
  return d11 === d[10]
}

export function maskTckn(tckn: string | null | undefined): string {
  if (!tckn) return ''
  return '*******' + tckn.slice(-4)
}

/** TR cep telefonu -> E.164 (+905XXXXXXXXX). Geçersizse null. */
export function normalizeTrMobile(raw: string): string | null {
  let s = raw.replace(/[\s()\-.]/g, '')
  if (s.startsWith('+90')) s = s.slice(3)
  else if (s.startsWith('0090')) s = s.slice(4)
  else if (s.startsWith('90') && s.length === 12) s = s.slice(2)
  if (s.startsWith('0')) s = s.slice(1)
  return /^5\d{9}$/.test(s) ? '+90' + s : null
}

/** +905321234567 -> 0532 123 45 67 */
export function formatTrPhone(e164: string | null | undefined): string {
  if (!e164) return ''
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(e164)
  return m ? `0${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164
}

/** PETVET'e kopyalanacak bicim: bastaki 0 olmadan 10 hane */
export function phoneForPetvet(e164: string | null | undefined): string {
  return e164?.startsWith('+90') ? e164.slice(3) : (e164 ?? '')
}

/** Türkçe büyük harf (i -> İ) */
export function trUpper(s: string): string {
  return s.toLocaleUpperCase('tr-TR')
}

/** "ayşe nur" -> "Ayşe Nur" */
export function trTitleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w ? w[0].toLocaleUpperCase('tr-TR') + w.slice(1).toLocaleLowerCase('tr-TR') : w))
    .join(' ')
}
