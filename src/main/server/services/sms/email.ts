// E-posta sağlayıcısı: nodemailer ile SMTP.
import nodemailer from 'nodemailer'
import type { MessageProvider } from './types'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  from: string
}

export function smtpProvider(cfg: SmtpConfig): MessageProvider {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
  return {
    name: 'smtp',
    async send(to, body, opts) {
      try {
        const info = await transport.sendMail({ from: cfg.from, to, subject: opts?.subject || 'Bilgilendirme', text: body })
        return { ok: true, providerMsgId: info.messageId ?? null, error: null }
      } catch (e) {
        const err = e as { message?: string; responseCode?: number; code?: string }
        // 5xx SMTP yanıtları (alıcı yok, kimlik hatası) kalıcıdır
        const permanent = (err.responseCode ?? 0) >= 500 || err.code === 'EAUTH'
        return { ok: false, providerMsgId: null, error: `E-posta gönderilemedi: ${err.message ?? 'bilinmeyen hata'}`, permanent }
      }
    },
  }
}
