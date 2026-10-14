// İletimerkezi SMS sağlayıcısı (JSON API v1).
//
// Kaynaklar (İletimerkezi'nin geliştirici sitesi toplusmsapi.com):
//  - Gönderim: https://www.toplusmsapi.com/en/sms/gonder/json
//    POST https://api.iletimerkezi.com/v1/send-sms/json
//    { request: { authentication: { key, hash }, order: { sender, sendDateTime: [], iys, iysList
//      message: { text, receipents: { number: [...] } } } } }   ("receipents" yazımı API'de böyle)
//    Başarı: response.status.code = 200, response.order.id
//  - Bakiye: https://www.toplusmsapi.com/en/hesap/bakiye/json
//    POST https://api.iletimerkezi.com/v1/get-balance/json -> response.balance.{amount, sms}
//  - Resmî PHP SDK: https://github.com/iletimerkezi/iletimerkezi-php (istemci API anahtarı + API hash alır)
//
// Ayarlar eşlemesi: "kullanıcı adı" = API anahtarı (key), şifreli sır = API hash (panelden alınır).
// Hash'in panelden mi yoksa key+secret'tan mi uretildigi netlesmeli (dokumanda algoritma yazmiyor).
// Gercek hesapla denenmedi.
// IYS: hatirlatmalar bilgilendirme amacli oldugundan iys = "0" gonderilir.
import { HTTP_TIMEOUT_MS, toLocalGsm, type FetchLike, type MessageProvider, type SendResult } from './types'

const BASE = 'https://api.iletimerkezi.com/v1'

export interface IletimerkeziConfig {
  apiKey: string
  apiHash: string
  header: string
  fetch?: FetchLike
}

type Resp = { response?: { status?: { code?: number | string; message?: string }; order?: { id?: string }; balance?: { amount?: string; sms?: string } } }

export function iletimerkeziProvider(cfg: IletimerkeziConfig): MessageProvider {
  const doFetch: FetchLike = cfg.fetch ?? (fetch as unknown as FetchLike)
  const authentication = { key: cfg.apiKey, hash: cfg.apiHash }

  async function post(path: string, payload: object): Promise<Resp> {
    const res = await doFetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ request: { authentication, ...payload } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as Resp
    } catch {
      return { response: { status: { code: res.status, message: text.slice(0, 200) } } }
    }
  }

  return {
    name: 'iletimerkezi',
    async send(to, body): Promise<SendResult> {
      try {
        const r = await post('/send-sms/json', {
          order: {
            sender: cfg.header,
            sendDateTime: [],
            iys: '0',
            message: { text: body, receipents: { number: [toLocalGsm(to)] } },
          },
        })
        const code = Number(r.response?.status?.code ?? 0)
        if (code === 200) return { ok: true, providerMsgId: r.response?.order?.id ?? null, error: null }
        return {
          ok: false,
          providerMsgId: null,
          error: `İletimerkezi ${code}: ${r.response?.status?.message ?? 'bilinmeyen hata'}`,
          // 401 kimlik, 4xx istek hataları kalıcı; 5xx geçici
          permanent: code >= 400 && code < 500,
        }
      } catch (e) {
        return { ok: false, providerMsgId: null, error: `İletimerkezi'ne bağlanılamadı: ${(e as Error).message}` }
      }
    },
    async balance() {
      const r = await post('/get-balance/json', {})
      const code = Number(r.response?.status?.code ?? 0)
      if (code !== 200) throw new Error(`İletimerkezi ${code}: ${r.response?.status?.message ?? 'bakiye okunamadı'}`)
      return { amount: r.response?.balance?.amount ?? null, credits: r.response?.balance?.sms ?? null }
    },
  }
}
