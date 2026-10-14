// Mesaj sağlayıcılarının ortak arayüzü (SMS sağlayıcıları ve e-posta).

export interface SendResult {
  ok: boolean
  providerMsgId: string | null
  error: string | null
  /** true ise tekrar denemek anlamsız (kimlik bilgisi hatalı, başlık tanımsız, numara geçersiz...) */
  permanent?: boolean
}

export interface BalanceResult {
  /** TL bakiye */
  amount: string | null
  /** SMS kredisi */
  credits: string | null
}

export interface MessageProvider {
  /** messages.provider sütununa yazılan ad */
  name: string
  send(to: string, body: string, opts?: { subject?: string | null }): Promise<SendResult>
  /** Sağlayıcı destekliyorsa bakiye */
  balance?(): Promise<BalanceResult>
}

/** Testlerde HTTP isteğini taklit etmek için */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** +905321234567 -> 5321234567 (Türk sağlayıcılarının beklediği 10 hane) */
export function toLocalGsm(e164: string): string {
  const d = e164.replace(/\D/g, '')
  if (d.startsWith('90') && d.length === 12) return d.slice(2)
  if (d.startsWith('0') && d.length === 11) return d.slice(1)
  return d
}

export const HTTP_TIMEOUT_MS = 15_000
