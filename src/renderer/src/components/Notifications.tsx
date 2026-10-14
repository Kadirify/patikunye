// Bildirim merkezi: modüllerin özet uçlarından türetilir (ayrı bildirim tablosu yok).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { useCan } from '../session'
import type { PetvetSummary } from '@shared/api-types'
import type { MessagingSummary } from '@shared/messaging'
import type { BackupStatusDto } from '@shared/backup'

interface Note {
  key: string
  level: 'red' | 'amb' | 'gry'
  text: string
  to: string
}


export function useNotifications(): Note[] {
  const can = useCan()
  const petvet = useQuery({ queryKey: ['petvet-summary'], queryFn: () => api.get<PetvetSummary>('/api/petvet/summary'), refetchInterval: 60_000, enabled: can('petvet.read') })
  const msg = useQuery({ queryKey: ['messaging-summary'], queryFn: () => api.get<MessagingSummary>('/api/messaging/summary'), refetchInterval: 120_000, enabled: can('messages.send') })
  const backup = useQuery({ queryKey: ['backup-status'], queryFn: () => api.get<BackupStatusDto>('/api/backup/status'), refetchInterval: 300_000, enabled: can('backup.run'), retry: false })

  const out: Note[] = []
  const p = petvet.data
  if (p?.overdue) out.push({ key: 'pv-over', level: 'red', text: `${p.overdue} PETVET kaydının süresi doldu`, to: '/petvet?f=overdue' })
  if (p?.today) out.push({ key: 'pv-today', level: 'amb', text: `${p.today} PETVET kaydı için bugün son gün`, to: '/petvet?f=today' })
  if (p?.missing) out.push({ key: 'pv-miss', level: 'amb', text: `${p.missing} PETVET görevinde eksik bilgi var`, to: '/petvet?f=missing' })
  const m = msg.data
  if (m?.tabs.failed) out.push({ key: 'msg-fail', level: 'amb', text: `${m.tabs.failed} mesaj gönderilemedi`, to: '/mesajlar' })
  if (m && m.provider === 'none' && !m.emailEnabled && m.tabs.planned > 0)
    out.push({ key: 'msg-none', level: 'gry', text: 'SMS/e-posta ayarlı değil; hatırlatmalar gönderilmiyor', to: '/ayarlar/mesajlasma' })
  const b = backup.data
  if (b && b.state !== 'ok')
    out.push({
      key: 'bk',
      level: b.state === 'err' ? 'red' : 'amb',
      text: !b.passwordSet
        ? 'Yedek parolası belirlenmemiş; otomatik yedek alınmıyor'
        : b.lastSuccessAt
          ? `Son yedek ${Math.round(b.hoursAgo ?? 0)} saat önce alındı`
          : 'Henüz yedek alınmadı',
      to: '/ayarlar/yedekleme',
    })
  return out
}

export function NotificationBell() {
  const notes = useNotifications()
  const [open, setOpen] = useState(false)
  const hot = notes.filter((n) => n.level !== 'gry').length
  return (
    <div style={{ position: 'relative' }}>
      <button className="tb" aria-label={`Bildirimler, ${notes.length}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9M10 20.5a2 2 0 0 0 4 0" />
        </svg>
        {notes.length > 0 && <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: hot ? 'var(--red)' : 'var(--muted)' }}>{notes.length}</span>}
      </button>
      {open && (
        <div className="pnl" style={{ position: 'absolute', right: 0, top: 36, width: 360, zIndex: 30, boxShadow: '0 8px 24px rgba(29,28,26,.15)' }} onMouseLeave={() => setOpen(false)}>
          <div className="ph"><h2>Bildirimler</h2></div>
          {notes.length === 0 && <div className="empty">Bildirim yok.</div>}
          {notes.map((n) => (
            <Link key={n.key} to={n.to} className="list-row" onClick={() => setOpen(false)}>
              <span className={`st s-${n.level}`}>{n.text}</span>
              <span className="mut">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
