// S-115 Profilim: parola değiştir, PIN belirle/kaldır, bildirim tercihleri
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { Field, useToast } from '../../ui'
import { ROLE_LABEL } from '@shared/api-types'
import type { ProfileDto, UserPrefs } from '@shared/admin'
import { Row, errText, fmtDateTime } from './common'

export function ProfilePage() {
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api.get<ProfileDto>('/api/auth/profile') })
  const p = q.data
  if (q.isError) return <div className="alert">{errText(q.error)}</div>
  if (!p) return <div className="mut">Yükleniyor…</div>
  return (
    <>
      <div className="page-head"><h1>Profilim</h1><span className="mut">{p.fullName} · {ROLE_LABEL[p.role]} · <span className="mono">{p.username}</span></span></div>
      <PasswordForm changedAt={p.passwordChangedAt} />
      <PinForm p={p} />
      <PrefsForm prefs={p.prefs} />
    </>
  )
}

function PasswordForm({ changedAt }: { changedAt: string | null }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { currentPassword: cur, newPassword: pw }),
    onSuccess: () => {
      setCur('')
      setPw('')
      setPw2('')
      qc.invalidateQueries({ queryKey: ['profile'] })
      toast('Parola değiştirildi. Diğer bilgisayarlardaki oturumlarınız kapatıldı.')
    },
    onError: (e) => setErr(errText(e)),
  })
  return (
    <form
      className="pnl"
      onSubmit={(e) => {
        e.preventDefault()
        setErr('')
        if (pw.length < 10) return setErr('Yeni parola en az 10 karakter olmalı.')
        if (pw !== pw2) return setErr('Yeni parolalar aynı değil.')
        save.mutate()
      }}
    >
      <div className="ph"><h2>Parola</h2><span className="mut" style={{ fontSize: 12 }}>{changedAt ? `Son değişiklik ${fmtDateTime(changedAt)}` : ''}</span></div>
      <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 12px' }}>
        <Field label="Mevcut parola" htmlFor="pf-cur"><input id="pf-cur" type="password" className="inp" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="Yeni parola" htmlFor="pf-new"><input id="pf-new" type="password" className="inp" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Yeni parola (tekrar)" htmlFor="pf-new2"><input id="pf-new2" type="password" className="inp" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <div className="form-foot">
        <span className="err">{err}</span>
        <button className="btn p" disabled={!cur || !pw || save.isPending}>Parolayı değiştir</button>
      </div>
    </form>
  )
}

function PinForm({ p }: { p: ProfileDto }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const done = (msg: string) => {
    setCur('')
    setPin('')
    setErr('')
    qc.invalidateQueries()
    toast(msg)
  }
  const set = useMutation({ mutationFn: () => api.put('/api/auth/pin', { currentPassword: cur, pin }), onSuccess: () => done('PIN kaydedildi.'), onError: (e) => setErr(errText(e)) })
  const del = useMutation({ mutationFn: () => api.del('/api/auth/pin'), onSuccess: () => done('PIN kaldırıldı.'), onError: (e) => setErr(errText(e)) })

  return (
    <form
      className="pnl"
      onSubmit={(e) => {
        e.preventDefault()
        set.mutate()
      }}
    >
      <div className="ph"><h2>PIN ile giriş</h2><span className="mut" style={{ fontSize: 12 }}>{p.pinSet ? 'PIN belirlenmiş' : 'PIN yok'}</span></div>
      {!p.pinAllowed ? (
        <div style={{ padding: 12 }} className="mut">Klinik yöneticisi sizin için PIN girişine izin vermemiş (Ayarlar → Kullanıcılar).</div>
      ) : (
        <>
          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 12px' }}>
            <Field label="Mevcut parola" htmlFor="pin-cur"><input id="pin-cur" type="password" className="inp" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
            <Field label="Yeni PIN (4–6 rakam)" htmlFor="pin-new">
              <input id="pin-new" type="password" inputMode="numeric" maxLength={6} className="inp mono" style={{ letterSpacing: '0.3em' }} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
            </Field>
          </div>
          <div className="form-foot">
            <span className="err">{err}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {p.pinSet && <button type="button" className="btn" disabled={del.isPending} onClick={() => del.mutate()}>PIN'i kaldır</button>}
              <button className="btn p" disabled={!cur || pin.length < 4 || set.isPending}>{p.pinSet ? "PIN'i değiştir" : 'PIN belirle'}</button>
            </div>
          </div>
        </>
      )}
    </form>
  )
}

function PrefsForm({ prefs }: { prefs: UserPrefs }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState<Required<UserPrefs>>({ notifyPetvet: prefs.notifyPetvet ?? true, notifyKvkk: prefs.notifyKvkk ?? true, notifyBackup: prefs.notifyBackup ?? true })
  const save = useMutation({
    mutationFn: () => api.put('/api/auth/prefs', v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] })
      toast('Tercihler kaydedildi.')
    },
  })
  const ck = (k: keyof UserPrefs, label: string) => (
    <label className="ck"><input type="checkbox" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />{label}</label>
  )
  return (
    <form
      className="pnl"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="ph"><h2>Bildirim tercihleri</h2></div>
      <Row label="PETVET">{ck('notifyPetvet', 'Süresi yaklaşan / geçen PETVET işleri')}</Row>
      <Row label="KVKK">{ck('notifyKvkk', 'Yanıt süresi yaklaşan KVKK talepleri')}</Row>
      <Row label="Yedekleme" last>{ck('notifyBackup', 'Yedek alınamadığında uyar')}</Row>
      <div className="form-foot">
        <span className="err">{save.isError ? errText(save.error) : ''}</span>
        <button className="btn p" disabled={save.isPending}>Kaydet</button>
      </div>
    </form>
  )
}
