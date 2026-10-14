// Kilit ekranı: işlem yapılmazsa ya da Ctrl+L ile. Açık sayfa bulanıklaşır, kişisel veri görünmez.
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { Logo } from '../ui'

export function useIdleLock(minutes: number, onLock: () => void) {
  const cb = useRef(onLock)
  cb.current = onLock
  useEffect(() => {
    if (!minutes) return
    let t: ReturnType<typeof setTimeout>
    const reset = () => {
      clearTimeout(t)
      t = setTimeout(() => cb.current(), minutes * 60_000)
    }
    const evs = ['mousemove', 'keydown', 'mousedown', 'wheel'] as const
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(t)
      evs.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [minutes])
}

export function LockScreen({ onUnlock }: { onUnlock(): void }) {
  const { user, signOut } = useSession()
  const [secret, setSecret] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      // PIN (4-6 hane) ya da parola
      await api.post('/api/auth/unlock', /^\d{4,6}$/.test(secret) ? { pin: secret } : { password: secret })
      onUnlock()
    } catch (er) {
      setErr((er as Error).message)
      setSecret('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, backdropFilter: 'blur(14px)', background: 'rgba(236,234,229,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form className="pnl" style={{ width: 380, padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={submit}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Logo size={20} hole="#fff" />
          <strong>Ekran kilitli</strong>
        </div>
        <div className="mut">{user?.fullName}</div>
        <label className="f">
          <span style={{ fontSize: 12 }}>PIN ya da parola</span>
          <input className="inp" type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} style={{ height: 36 }} />
        </label>
        {err && <span className="err">{err}</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <button type="button" className="btn" onClick={() => signOut()}>Başka kullanıcı</button>
          <button className="btn p" disabled={busy || !secret}>Kilidi aç</button>
        </div>
      </form>
    </div>
  )
}
