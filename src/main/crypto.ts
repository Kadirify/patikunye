// Hassas alan şifreleme (TCKN). Anahtar veritabanında durmaz.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, createHash } from 'node:crypto'

export class FieldCrypto {
  private dataKey: Buffer
  private hashKey: Buffer
  constructor(dataKeyB64: string, hashKeyB64: string) {
    this.dataKey = Buffer.from(dataKeyB64, 'base64')
    this.hashKey = Buffer.from(hashKeyB64, 'base64')
    if (this.dataKey.length !== 32 || this.hashKey.length !== 32) throw new Error('Geçersiz anahtar uzunluğu')
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.dataKey, iv)
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
  }

  decrypt(payload: string): string {
    const [v, iv, tag, enc] = payload.split('.')
    if (v !== 'v1') throw new Error('Bilinmeyen şifreleme sürümü')
    const d = createDecipheriv('aes-256-gcm', this.dataKey, Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8')
  }

  /** Eşitlik araması için deterministik özet */
  hash(plain: string): string {
    return createHmac('sha256', this.hashKey).update(plain).digest('base64url')
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
