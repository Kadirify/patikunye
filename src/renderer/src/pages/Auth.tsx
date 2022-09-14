// S-04 Giriş (Ayarlar modülü F): kullanıcı kartları, parola / PIN girişi, ilk girişte zorunlu parola değişikliği
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, HttpError } from '../api'
import { useSession } from '../session'
import { TitleBar } from '../Layout'
import { Field, Logo } from '../ui'
import { ROLE_LABEL, type SessionDto } from '@shared/api-types'
import type { LoginResult, LoginUserCard } from '@shared/admin'

/** "dün 18:42", "bugün 09:10", "12.10.2026" */
export function relativeLogin(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  if (diff === 0) return `bugün ${hm}`
  if (diff === 1) return `dün ${hm}`
  return d.toLocaleDateString('tr-TR')
}

function errMsg(e: unknown, fallback: string) {
  return e instanceof HttpError ? e.message : fallback
}

export function LoginPage() {
  const { signIn } = useSession()
  const users = useQuery({ queryKey: ['login-users'], queryFn: () => api.get<LoginUserCard[]>('/api/login-users') })
  const [picked, setPicked] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [manualName, setManualName] = useState('')
  const [usePin, setUsePin] = useState<boolean | null>(null)
  const [secret, setSecret] = useState('')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [change, setChange] = useState<{ token: string; fullName: string } | null>(null)

  const cards = users.data ?? []
  const cardMode = !manual && cards.length > 0
  const selected = cardMode ? (picked ?? cards[0]?.username ?? '') : manualName.trim().toLowerCase()
  const sel = cardMode ? cards.find((u) => u.username === selected) : undefined
  const pinMode = !!sel?.pinEnabled && (usePin ?? true)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setInfo('')
    setBusy(true)
    try {
      const r = pinMode
        ? await api.post<LoginResult>('/api/auth/pin-login', { username: selected, pin: secret })
        : await api.post<LoginResult>('/api/auth/login', { username: selected, password: secret })
      if ('mustChangePassword' in r) setChange({ token: r.changeToken, fullName: r.fullName })
      else signIn(r)
    } catch (e) {
      setErr(errMsg(e, 'Giriş yapılamadı.'))
    } finally {
      setSecret('')
      setBusy(false)
    }
  }

  function pick(u: LoginUserCard) {
    setPicked(u.username)
    setUsePin(null)
    setErr('')
    setSecret('')
    setTimeout(() => document.getElementById('secret')?.focus(), 0)
  }

  if (change) return <ForcePasswordChange token={change.token} fullName={change.fullName} onDone={signIn} onCancel={() => setChange(null)} />

  return (
    <div className="app">
      <TitleBar />
      <div className="center">
        <div className="pnl" style={{ width: '100%', maxWidth: 760, display: 'flex', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 300px', padding: 28, borderRight: '1px solid var(--line-2)', background: 'var(--head)', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Logo size={28} hole="#f7f6f3" />
              <div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>PatiKünye</div>
              </div>
            </div>
            {cardMode ? (
              <div role="radiogroup" aria-label="Kullanıcı" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.map((u) => (
                  <button key={u.username} type="button" role="radio" aria-checked={u.username === selected} className={`u${u.username === selected ? ' on' : ''}`} onClick={() => pick(u)}>
                    <strong>{u.fullName}</strong>
                    <span className="mut" style={{ fontSize: 12 }}>{u.pinEnabled ? 'PIN' : ''}</span>
                    <span className="mut" style={{ fontSize: 12 }}>
                      {ROLE_LABEL[u.role]}
                      {u.lastLoginAt ? ` · son giriş ${relativeLogin(u.lastLoginAt)}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mut" style={{ fontSize: 13 }}>Kullanıcı adınız ve parolanızla giriş yapın.</div>
            )}
            {cards.length > 0 && (
              <button
                type="button"
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  setManual(!manual)
                  setErr('')
                  setSecret('')
                }}
              >
                {manual ? 'Kullanıcı kartlarını göster' : 'Kullanıcı adıyla giriş'}
              </button>
            )}
          </div>
          <form style={{ flex: '1 1 300px', padding: 28, display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={submit}>
            <h1 style={{ fontSize: 18 }}>{sel?.fullName ?? 'Giriş'}</h1>
            {!cardMode && (
              <Field label="Kullanıcı adı" htmlFor="un">
                <input id="un" className="inp" style={{ height: 36 }} value={manualName} onChange={(e) => setManualName(e.target.value)} autoFocus autoComplete="username" />
              </Field>
            )}
            <Field label={pinMode ? 'PIN' : 'Parola'} htmlFor="secret" error={err}>
              <input
                id="secret"
                key={pinMode ? 'pin' : 'pw'}
                type="password"
                className={`inp${pinMode ? ' mono' : ''}`}
                style={pinMode ? { letterSpacing: '0.4em', fontSize: 18, height: 40 } : { height: 36 }}
                inputMode={pinMode ? 'numeric' : undefined}
                maxLength={pinMode ? 6 : 200}
                value={secret}
                onChange={(e) => setSecret(pinMode ? e.target.value.replace(/\D/g, '') : e.target.value)}
                autoFocus={cardMode}
                autoComplete="current-password"
              />
            </Field>
            <button className="btn p" style={{ height: 38 }} disabled={busy || !selected || !secret}>
              {busy ? 'Giriş yapılıyor…' : 'Giriş'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
              {sel?.pinEnabled ? (
                <button type="button" className="btn sm" onClick={() => { setUsePin(!pinMode); setSecret(''); setErr('') }}>
                  {pinMode ? 'Parola ile giriş' : 'PIN ile giriş'}
                </button>
              ) : (
                <span />
              )}
              <button type="button" className="btn sm" onClick={() => setInfo('Parolanızı klinik yöneticisi Ayarlar → Kullanıcılar ekranından sıfırlar. Size verilen geçici parolayla girdiğinizde yeni parola belirlersiniz.')}>
                Parolamı unuttum
              </button>
            </div>
            {info && <div className="alert amb" role="status" style={{ fontSize: 13 }}>{info}</div>}
            <div className="mut" style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--line-2)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>5 hatalı denemede kullanıcı 5 dakika kilitlenir.</span>
              {window.patikunye?.version && <span>Sürüm {window.patikunye.version}</span>}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

/** Geçici parola ile ilk girişte yeni parola belirleme (oturum bundan sonra açılır) */
function ForcePasswordChange({ token, fullName, onDone, onCancel }: { token: string; fullName: string; onDone: (s: SessionDto) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (pw.length < 10) return setErr('Parola en az 10 karakter olmalı.')
    if (pw !== pw2) return setErr('Parolalar aynı değil.')
    setBusy(true)
    try {
      onDone(await api.post<SessionDto>('/api/auth/first-password', { changeToken: token, newPassword: pw }))
    } catch (e) {
      setErr(errMsg(e, 'Parola değiştirilemedi.'))
      if (e instanceof HttpError && e.status === 401) setTimeout(onCancel, 1500)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="center">
        <form className="pnl" style={{ width: '100%', maxWidth: 420, padding: 28, display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={submit}>
          <h1 style={{ fontSize: 18 }}>Yeni parola belirleyin</h1>
          <div className="mut" style={{ fontSize: 13 }}>
            {fullName}, geçici parolayla giriş yaptınız. Devam etmek için kendi parolanızı belirleyin (en az 10 karakter).
          </div>
          <Field label="Yeni parola" htmlFor="np">
            <input id="np" type="password" className="inp" style={{ height: 36 }} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="new-password" />
          </Field>
          <Field label="Yeni parola (tekrar)" htmlFor="np2" error={err}>
            <input id="np2" type="password" className="inp" style={{ height: 36 }} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onCancel}>Vazgeç</button>
            <button className="btn p" disabled={busy || !pw || !pw2}>{busy ? 'Kaydediliyor…' : 'Parolayı kaydet ve gir'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
