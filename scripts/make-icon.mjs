// Uygulama simgesi (256x256 PNG): pirinç renkli künye + delik + iki çizgi. electron-builder bundan .ico üretir.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
const S = 256
const px = Buffer.alloc(S * S * 4)
const set = (x, y, r, g, b, a = 255) => { const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a }
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  // Künye gövdesi: 36..220 yatay, 20..236 dikey, köşe yuvarlak 28, üst köşeler pahlı
  const l = 36, r = 220, t = 20, btm = 236, rad = 28
  let inside = x >= l && x <= r && y >= t && y <= btm
  const cx = x < l + rad ? l + rad : x > r - rad ? r - rad : x
  const cy = y > btm - rad ? btm - rad : y
  if (inside && (x < l + rad || x > r - rad) && y > btm - rad) inside = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
  if (inside && y < t + 40) inside = x - l >= (t + 40 - y) * 0.6 || r - x >= (t + 40 - y) * 0.6 ? (x >= l + (t + 40 - y) * 0.0 && x <= r) : false
  const hole = (x - 128) ** 2 + (y - 72) ** 2 < 22 ** 2
  const line1 = y >= 140 && y <= 156 && x >= 76 && x <= 180
  const line2 = y >= 180 && y <= 196 && x >= 76 && x <= 152
  if (inside && !hole && !line1 && !line2) set(x, y, 0xa0, 0x66, 0x1a)
}
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4) }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync(process.argv[2] ?? 'build/icon.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
