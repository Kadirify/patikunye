import { describe, expect, it } from 'vitest'
import { cleanChipInput, fdxbHexToDecimal, formatChip, shortChip, validateChip } from './chip'
import { formatTrPhone, isValidTckn, maskTckn, normalizeTrMobile, phoneForPetvet, trTitleCase } from './identity'
import { addDaysIso, diffDaysIso, formatDateTr, parseDateTr, petvetDueDate, petvetUrgency, todayIstanbul } from './petvet'

describe('çip doğrulama', () => {
  it('geçerli Türkiye çipini kabul eder', () => {
    const r = validateChip('792091234567890')
    expect(r).toMatchObject({ ok: true, value: '792091234567890', format: 'iso', code: 792, codeKind: 'country' })
    if (r.ok) expect(r.warnings).toEqual([])
  })

  it('boşluk, tire ve okuyucu ön ekini temizler', () => {
    expect(cleanChipInput(' LA 792-091.234 567 890\r\n')).toBe('792091234567890')
    expect(validateChip('792 091 234 567 890').ok).toBe(true)
  })

  it('yanlış uzunluğu reddeder', () => {
    const r = validateChip('79209123456')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('11 hane')
  })

  it('harf içeren 15 haneyi reddeder', () => {
    expect(validateChip('79209123456789A').ok).toBe(false)
  })

  it('tanımsız ülke kodunu reddeder', () => {
    const r = validateChip('000123456789012')
    expect(r.ok).toBe(false)
  })

  it('üretici kodunu (900-998) kabul eder', () => {
    expect(validateChip('900164001234567')).toMatchObject({ ok: true, codeKind: 'manufacturer' })
  })

  it('test çipini (999) uyarıyla kabul eder', () => {
    const r = validateChip('999000000000001')
    expect(r).toMatchObject({ ok: true, codeKind: 'test' })
    if (r.ok) expect(r.warnings[0]).toContain('test')
  })

  it('yurt dışı çipine uyarı verir', () => {
    const r = validateChip('276098100123456')
    expect(r).toMatchObject({ ok: true, codeKind: 'country', code: 276 })
    if (r.ok) expect(r.warnings).toContain('Yurt dışı çipi.')
  })

  it('eski 10 haneli çipi uyarıyla kabul eder', () => {
    const r = validateChip('0A01234567')
    expect(r).toMatchObject({ ok: true, format: 'legacy' })
  })

  it('16 hane hex FDX-B değerini ondalığa çevirir', () => {
    const n = (792n << 38n) | 91234567890n
    const hex = n.toString(16).toUpperCase().padStart(16, '0')
    expect(fdxbHexToDecimal(hex)).toBe('792091234567890')
    const r = validateChip(hex)
    expect(r).toMatchObject({ ok: true, value: '792091234567890', convertedFromHex: true })
  })

  it('gösterim biçimleri', () => {
    expect(formatChip('792091234567890')).toBe('792 091 234 567 890')
    expect(shortChip('792091234567890')).toBe('792...567 890')
  })
})

describe('TCKN', () => {
  it('geçerli numarayı kabul eder', () => {
    expect(isValidTckn('12345678950')).toBe(true)
    expect(isValidTckn('10000000146')).toBe(true)
  })
  it('geçersizleri reddeder', () => {
    expect(isValidTckn('12345678951')).toBe(false)
    expect(isValidTckn('02345678950')).toBe(false)
    expect(isValidTckn('1234567895')).toBe(false)
    expect(isValidTckn('1234567895a')).toBe(false)
  })
  it('maskeler', () => {
    expect(maskTckn('12345678950')).toBe('*******8950')
  })
})

describe('telefon', () => {
  it('farklı yazımları normalleştirir', () => {
    for (const s of ['0532 123 45 67', '+90 532 123 4567', '5321234567', '(0532) 123-45-67', '905321234567']) {
      expect(normalizeTrMobile(s)).toBe('+905321234567')
    }
  })
  it('sabit hattı ve kısa numarayı reddeder', () => {
    expect(normalizeTrMobile('0312 123 45 67')).toBeNull()
    expect(normalizeTrMobile('532123')).toBeNull()
  })
  it('biçimler', () => {
    expect(formatTrPhone('+905321234567')).toBe('0532 123 45 67')
    expect(phoneForPetvet('+905321234567')).toBe('5321234567')
  })
})

describe('metin', () => {
  it('Türkçe baş harf büyütme', () => {
    expect(trTitleCase('  ayşe   nur ışık ')).toBe('Ayşe Nur Işık')
    expect(trTitleCase('İSMAİL')).toBe('İsmail')
  })
})

describe('PETVET tarihleri', () => {
  it('yeni çip için 15 gün ekler, ay geçişinde doğru çalışır', () => {
    expect(petvetDueDate('CHIP_NEW', '2026-10-27')).toBe('2026-11-11')
    expect(addDaysIso('2026-12-20', 15)).toBe('2027-01-04')
  })
  it('aciliyet', () => {
    expect(petvetUrgency('2026-10-22', '2026-10-27')).toEqual({ urgency: 'overdue', daysLeft: -5 })
    expect(petvetUrgency('2026-10-27', '2026-10-27').urgency).toBe('today')
    expect(petvetUrgency('2026-10-30', '2026-10-27').urgency).toBe('soon')
    expect(petvetUrgency('2026-11-11', '2026-10-27').urgency).toBe('normal')
    expect(diffDaysIso('2026-03-28', '2026-03-30')).toBe(2)
  })
  it('tarih çevirme', () => {
    expect(formatDateTr('2026-10-27')).toBe('27.10.2026')
    expect(parseDateTr('7.3.2026')).toBe('2026-03-07')
    expect(parseDateTr('31.02.2026')).toBeNull()
    expect(todayIstanbul(new Date('2026-10-26T22:30:00Z'))).toBe('2026-10-27')
  })
})
