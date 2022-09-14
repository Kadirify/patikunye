// "log" sağlayıcısı: gerçekten göndermez. Geliştirme ve test içindir; gönderim motoru
// messages tablosuna 'sent' olarak yazar, metin uygulama günlüğüne düşer.
import { randomUUID } from 'node:crypto'
import type { MessageProvider } from './types'

export function logProvider(log?: (m: string) => void, channel: 'sms' | 'email' = 'sms'): MessageProvider {
  return {
    name: 'log',
    async send(to, body, opts) {
      log?.(`[mesaj:log:${channel}] ${to}${opts?.subject ? ` «${opts.subject}»` : ''}: ${body}`)
      return { ok: true, providerMsgId: `log-${randomUUID()}`, error: null }
    },
    async balance() {
      return { amount: null, credits: '∞' }
    },
  }
}
