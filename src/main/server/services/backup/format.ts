// .pkb yedek dosya biçimi (sürüm 1)
//
//   [düz başlık, 69 bayt]
//     0  "PKBK"            sihirli bayt
//     4  u8  biçim sürümü (1)
//     5  u8  KDF (1 = scrypt)
//     6  u8  log2(N)   7 u8 r   8 u8 p
//     9  16 bayt tuz
//    25  12 bayt IV (AES-256-GCM)
//    37  32 bayt parola denetimi (scrypt çıktısının ikinci yarısı → yanlış parola hemen anlaşılır)
//   [şifreli gövde]  AES-256-GCM( gzip( kayıt akışı ) )
//   [16 bayt GCM etiketi]
//
// Kayıt akışı: art arda [u8 tür][u32 BE uzunluk][yük] kayıtları.
//   META(1)      JSON: biçim, uygulama sürümü, oluşturma zamanı, migration listesi, tablolar ve sütunlar
//   TABLE(2)     JSON: { name, columns }
//   ROW(3)       satırın JSON metni (to_jsonb) — tablo başına NDJSON
//   TABLE_END(4) JSON: { name, rows, sha256 }
//   FILE(5)      JSON: { attachmentId, size, sha256 }  (çözülmüş içerik)
//   FILE_DATA(6) ham bayt parçası
//   FILE_END(7)  boş
//   TRAILER(9)   JSON manifest: tablo sayıları + sha256'lar, dosya sayısı/özetleri, toplamlar
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, appendFile, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { AppError } from '../../context'

export const MAGIC = Buffer.from('PKBK', 'latin1')
export const FORMAT_VERSION = 1
export const HEADER_LEN = 69
const TAG_LEN = 16

export const REC = { META: 1, TABLE: 2, ROW: 3, TABLE_END: 4, FILE: 5, FILE_DATA: 6, FILE_END: 7, TRAILER: 9 } as const
export type RecordType = (typeof REC)[keyof typeof REC]

export interface KdfParams {
  log2N: number
  r: number
  p: number
  salt: Buffer
}

export const DEFAULT_KDF = { log2N: 15, r: 8, p: 1 }

export function deriveKeys(password: string, k: KdfParams): Promise<{ key: Buffer; check: Buffer }> {
  const N = 2 ** k.log2N
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), k.salt, 64, { N, r: k.r, p: k.p, maxmem: 256 * N * k.r + 32 * 1024 * 1024 }, (err, out) => {
      if (err) reject(err)
      else resolve({ key: out.subarray(0, 32), check: out.subarray(32, 64) })
    }),
  )
}

export function encodeRecord(type: RecordType, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const h = Buffer.alloc(5)
  h.writeUInt8(type, 0)
  h.writeUInt32BE(body.length, 1)
  return Buffer.concat([h, body])
}

export const corrupt = (detail?: string) =>
  new AppError(400, 'Yedek dosyası bozuk ya da eksik' + (detail ? ` (${detail})` : '') + '.', 'BACKUP_CORRUPT')
export const wrongPassword = () => new AppError(400, 'Yedek parolası yanlış.', 'BACKUP_WRONG_PASSWORD')

/**
 * Kayıt akışını şifreli .pkb dosyasına yazar. Bellekte yalnızca o anki parça tutulur.
 * Dönen sha256 dosyanın tamamının (başlık + gövde + etiket) özetidir.
 */
export async function writePkb(path: string, password: string, records: AsyncIterable<Buffer>): Promise<{ size: number; sha256: string }> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const kdf = { ...DEFAULT_KDF, salt }
  const { key, check } = await deriveKeys(password, kdf)
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION, 1, kdf.log2N, kdf.r, kdf.p]),
    salt,
    iv,
    check,
  ])
  const hash = createHash('sha256').update(header)
  let size = header.length
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      size += chunk.length
      cb(null, chunk)
    },
  })
  const fh = await open(path, 'w')
  try {
    await fh.write(header)
  } finally {
    await fh.close()
  }
  await pipeline(Readable.from(records), createGzip({ level: 6 }), cipher, tap, createWriteStream(path, { flags: 'a' }))
  const tag = cipher.getAuthTag()
  hash.update(tag)
  size += tag.length
  await appendFile(path, tag)
  return { size, sha256: hash.digest('hex') }
}

export interface ParsedRecord {
  type: RecordType
  payload: Buffer
}

/** Dosya başlığını okur ve parolayı denetler; gövde için şifre çözme anahtarını döndürür. */
async function openPkb(path: string, password: string) {
  let st
  try {
    st = await stat(path)
  } catch {
    throw new AppError(404, 'Yedek dosyası bulunamadı.', 'BACKUP_NOT_FOUND')
  }
  if (!st.isFile()) throw new AppError(400, 'Seçilen yol bir dosya değil.', 'BACKUP_NOT_FILE')
  if (st.size < HEADER_LEN + TAG_LEN) throw corrupt('dosya çok kısa')
  const fh = await open(path, 'r')
  const header = Buffer.alloc(HEADER_LEN)
  const tag = Buffer.alloc(TAG_LEN)
  try {
    await fh.read(header, 0, HEADER_LEN, 0)
    await fh.read(tag, 0, TAG_LEN, st.size - TAG_LEN)
  } finally {
    await fh.close()
  }
  if (!header.subarray(0, 4).equals(MAGIC)) throw new AppError(400, 'Bu dosya bir PatiKünye yedeği değil.', 'BACKUP_NOT_PKB')
  const version = header.readUInt8(4)
  if (version !== FORMAT_VERSION) throw new AppError(400, `Desteklenmeyen yedek biçimi (sürüm ${version}). Uygulamayı güncelleyin.`, 'BACKUP_FORMAT')
  if (header.readUInt8(5) !== 1) throw corrupt('bilinmeyen anahtar türetme')
  const kdf: KdfParams = { log2N: header.readUInt8(6), r: header.readUInt8(7), p: header.readUInt8(8), salt: header.subarray(9, 25) }
  if (kdf.log2N < 10 || kdf.log2N > 22 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 16) throw corrupt('anahtar türetme ayarları')
  const iv = header.subarray(25, 37)
  const check = header.subarray(37, 69)
  const { key, check: got } = await deriveKeys(password, kdf)
  if (!timingSafeEqual(check, got)) throw wrongPassword()
  return { key, iv, tag, size: st.size }
}

/**
 * Yedeği açar ve kayıtları sırayla verir. Akışın sonunda GCM etiketi doğrulanır;
 * etiket tutmazsa (dosya değiştirilmiş/bozuk) yineleme hata fırlatır. Bu yüzden
 * geri yükleme, yineleme hatasız bitmeden commit ETMEMELİDİR.
 */
export async function* readPkb(path: string, password: string): AsyncGenerator<ParsedRecord> {
  const { key, iv, tag, size } = await openPkb(path, password)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const gunzip = createGunzip()
  const src = createReadStream(path, { start: HEADER_LEN, end: size - TAG_LEN - 1 })
  const done = pipeline(src, decipher, gunzip).catch((e: Error) => e)

  let buf: Buffer = Buffer.alloc(0)
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      let off = 0
      while (buf.length - off >= 5) {
        const len = buf.readUInt32BE(off + 1)
        if (buf.length - off < 5 + len) break
        const type = buf.readUInt8(off) as RecordType
        yield { type, payload: buf.subarray(off + 5, off + 5 + len) }
        off += 5 + len
      }
      buf = off ? buf.subarray(off) : buf
    }
  } catch (e) {
    throw mapStreamError(e)
  } finally {
    // Yarıda bırakılırsa akışları kapat
    src.destroy()
    gunzip.destroy()
  }
  const err = await done
  if (err) throw mapStreamError(err)
  if (buf.length) throw corrupt('yarım kayıt')
}

function mapStreamError(e: unknown): Error {
  if (e instanceof AppError) return e
  const msg = e instanceof Error ? e.message : String(e)
  if (/authenticate|auth tag/i.test(msg)) return corrupt('bütünlük denetimi başarısız')
  if (/incorrect header|invalid|unexpected end|zlib|gzip/i.test(msg)) return corrupt('sıkıştırılmış veri açılamadı')
  return corrupt(msg)
}

/** Kayıtlardan JSON okuyan yardımcı */
export function json<T>(r: ParsedRecord): T {
  try {
    return JSON.parse(r.payload.toString('utf8')) as T
  } catch {
    throw corrupt('geçersiz kayıt')
  }
}
