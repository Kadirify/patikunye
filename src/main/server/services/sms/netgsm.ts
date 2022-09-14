// Netgsm SMS sağlayıcısı (REST v2).
//
// Kaynaklar:
//  - Resmî doküman: https://www.netgsm.com.tr/dokuman/ (sayfa JS ile yükleniyor; içeriği otomatik okunamadı)
//  - Netgsm'in kendi paketi: https://github.com/netgsm1/sms  → `encoding: 'tr'` Türkçe karakter desteği,
//    yanıt alanları `code`, `bulkid`/`jobid`, `durum`/`aciklama`
//  - Topluluk istemcisi (REST v2): https://pkg.go.dev/github.com/YusufDrymz/go-netgsm
//    → taban `https://api.netgsm.com.tr/sms/rest/v2`, uç `/send`, HTTP Basic (kullanıcı kodu + parola),
//      gövde { msgheader, encoding, messages: [{ msg, no }] }, başarı kodu "00",
//      hata kodları 20 (metin hatalı/uzun), 30 (kimlik/API yetkisi), 40/41 (başlık tanımsız),
//      50/51 (İYS filtresi), 70 (parametre hatalı), 85 (mükerrer gönderim sınırı), 100 (sistem hatası)
//
// ⚠️ doğrulanacak: uç nokta, alan adları ve yanıt biçimi resmî dokümandan değil üçüncü taraf istemcilerden
//    derlendi. Gerçek hesapla denenmedi (anahtar yok).
// ⚠️ doğrulanacak: bakiye ucu. Eski XML/HTTP API'de `https://api.netgsm.com.tr/balance` (usercode, password, stip)
//    olduğu biliniyor; REST v2 karşılığı doğrulanamadı.
import { HTTP_TIMEOUT_MS, toLocalGsm, type FetchLike, type MessageProvider, type SendResult } from './types'

const BASE = 'https://api.netgsm.com.tr'

const ERRORS: Record<string, string> = {
  '20': 'Mesaj metni hatalı ya da çok uzun.',
  '30': 'Netgsm kullanıcı adı/parolası hatalı ya da API yetkisi yok.',
  '40': 'Mesaj başlığı (gönderici adı) Netgsm hesabında tanımlı değil.',
  '41': 'Mesaj başlığı (gönderici adı) Netgsm hesabında tanımlı değil.',
  '50': 'İYS kontrollü gönderim yapılamadı.',
  '51': 'İYS kontrollü gönderim yapılamadı.',
  '70': 'Hatalı ya da eksik parametre.',
  '85': 'Mükerrer gönderim sınırı aşıldı.',
  '100': 'Netgsm sistem hatası.',
}
// Tekrar denemenin anlamı olmayan kodlar
const PERMANENT = new Set(['20', '30', '40', '41', '50', '51', '70'])

export interface NetgsmConfig {
  username: string
  password: string
  header: string
  fetch?: FetchLike
}

export function netgsmProvider(cfg: NetgsmConfig): MessageProvider {
  const doFetch: FetchLike = cfg.fetch ?? (fetch as unknown as FetchLike)
  const auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')

  return {
    name: 'netgsm',
    async send(to, body): Promise<SendResult> {
      try {
        const res = await doFetch(`${BASE}/sms/rest/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({
            msgheader: cfg.header,
            // Türkçe karakterli mesaj Türkçe kodlamayla gider (⚠️ değer 'TR' / 'tr' — doğrulanacak)
            encoding: 'TR',
            messages: [{ msg: body, no: toLocalGsm(to) }],
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        })
        const text = await res.text()
        let data: { code?: string | number; jobid?: string; bulkid?: string; description?: string } = {}
        try {
          data = JSON.parse(text)
        } catch {
          // Eski API'ler düz metin döner: "00 123456789"
          const [code, id] = text.trim().split(/\s+/)
          data = { code, jobid: id }
        }
        const code = String(data.code ?? (res.ok ? '' : res.status))
        if (code === '00' || code === '0') return { ok: true, providerMsgId: String(data.jobid ?? data.bulkid ?? '') || null, error: null }
        return {
          ok: false,
          providerMsgId: null,
          error: `Netgsm ${code}: ${ERRORS[code] ?? data.description ?? 'bilinmeyen hata'}`,
          permanent: PERMANENT.has(code),
        }
      } catch (e) {
        return { ok: false, providerMsgId: null, error: `Netgsm'e bağlanılamadı: ${(e as Error).message}` }
      }
    },
    async balance() {
      // ⚠️ doğrulanacak: uç ve gövde (eski API: stip=2 → TL bakiye)
      const res = await doFetch(`${BASE}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usercode: cfg.username, password: cfg.password, stip: 2 }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      const text = await res.text()
      try {
        const d = JSON.parse(text) as { balance?: { amount?: string; balance_name?: string }[] | string; code?: string }
        if (typeof d.balance === 'string') return { amount: d.balance, credits: null }
        if (Array.isArray(d.balance)) return { amount: null, credits: d.balance.map((b) => `${b.balance_name ?? ''} ${b.amount ?? ''}`.trim()).join(', ') }
        throw new Error(`Netgsm bakiye yanıtı anlaşılamadı (${d.code ?? res.status}).`)
      } catch (e) {
        if (/^\d+([.,]\d+)?$/.test(text.trim())) return { amount: text.trim(), credits: null }
        throw e
      }
    },
  }
}
