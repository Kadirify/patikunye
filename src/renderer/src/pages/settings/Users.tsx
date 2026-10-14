// Kullanıcılar: liste, yeni / düzenle, parola sıfırla, devre dışı bırak, oturumları kapat
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useCan, useSession } from '../../session'
import { Field, useToast } from '../../ui'
import { ROLE_LABEL, type Role } from '@shared/api-types'
import type { AdminUserDto, AdminUserInput } from '@shared/admin'
import { formatTrPhone } from '@shared/identity'
import { Modal, NoAccess, errText, fieldErr, fmtDateTime, useCtrlS } from './common'

const ROLES: Role[] = ['admin', 'vet', 'tech', 'secretary']

export function UsersSettingsPage() {
  const can = useCan()
  const { user: me } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<AdminUserDto[]>('/api/admin/users'), enabled: can('users.manage') })
  const [edit, setEdit] = useState<AdminUserDto | 'new' | null>(null)
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null)
  const [actErr, setActErr] = useState('')

  const act = useMutation({
    mutationFn: async ({ u, kind }: { u: AdminUserDto; kind: 'reset' | 'toggle' | 'sessions' }) => {
      if (kind === 'reset') {
        const r = await api.post<{ tempPassword: string }>(`/api/admin/users/${u.id}/reset-password`)
        setTemp({ name: u.fullName, password: r.tempPassword })
        return 'Parola sıfırlandı.'
      }
      if (kind === 'toggle') {
        await api.patch(`/api/admin/users/${u.id}`, { active: !u.active })
        return u.active ? `${u.fullName} devre dışı bırakıldı.` : `${u.fullName} yeniden etkin.`
      }
      const r = await api.post<{ closed: number }>(`/api/admin/users/${u.id}/revoke-sessions`)
      return `${r.closed} oturum kapatıldı.`
    },
    onSuccess: (msg) => {
      setActErr('')
      qc.invalidateQueries()
      toast(msg)
    },
    onError: (e) => setActErr(errText(e)),
  })

  if (!can('users.manage')) return <NoAccess />

  return (
    <>
      <div className="page-head">
        <h1>Kullanıcılar</h1>
        <div className="right"><button className="btn p" onClick={() => setEdit('new')}>+ Yeni kullanıcı</button></div>
      </div>
      {actErr && <div className="alert" role="alert">{actErr}</div>}
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Ad soyad</th><th>Kullanıcı adı</th><th>Rol</th><th>Oda sicil</th><th>PIN</th><th>Durum</th><th>Son giriş</th><th></th></tr>
            </thead>
            <tbody>
              {q.data?.map((u) => (
                <tr key={u.id} className="click" onDoubleClick={() => setEdit(u)}>
                  <td><strong>{u.fullName}</strong>{u.id === me?.id && <span className="mut"> (siz)</span>}</td>
                  <td className="mono">{u.username}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td className="mono">{u.chamberRegNo ?? '-'}</td>
                  <td>{u.pinAllowed ? (u.pinSet ? 'İzinli - belirlendi' : 'İzinli') : <span className="mut">Kapalı</span>}</td>
                  <td>
                    {!u.active ? <span className="st s-gry">Devre dışı</span> : u.mustChangePassword ? <span className="st s-amb">Parola değişikliği bekliyor</span> : <span className="st s-ok">Etkin</span>}
                  </td>
                  <td className="mono">{fmtDateTime(u.lastLoginAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setEdit(u)}>Düzenle</button>{' '}
                    <button
                      className="btn sm"
                      disabled={act.isPending}
                      onClick={() => confirm(`${u.fullName} için geçici parola oluşturulsun mu? Açık oturumları kapanır.`) && act.mutate({ u, kind: 'reset' })}
                    >
                      Parola sıfırla
                    </button>{' '}
                    <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ u, kind: 'sessions' })}>Oturumları kapat</button>{' '}
                    {u.id !== me?.id && (
                      <button
                        className="btn sm"
                        disabled={act.isPending}
                        onClick={() => (!u.active || confirm(`${u.fullName} devre dışı bırakılsın mı? Kayıtları silinmez.`)) && act.mutate({ u, kind: 'toggle' })}
                      >
                        {u.active ? 'Devre dışı bırak' : 'Etkinleştir'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.isError && <div className="alert" style={{ margin: 12 }}>{errText(q.error)}</div>}
        </div>
        <div className="tfoot mut">Kullanıcılar silinmez, devre dışı bırakılır. Son klinik yöneticisi devre dışı bırakılamaz.</div>
      </section>
      {edit && <UserForm user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onCreated={(name, password) => setTemp({ name, password })} />}
      {temp && (
        <Modal title="Geçici parola" onClose={() => setTemp(null)} width={440}>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>{temp.name} için geçici parola:</div>
            <div className="mono" style={{ fontSize: 22, letterSpacing: '0.05em', padding: '8px 12px', border: '1px solid var(--line)', background: 'var(--head)', userSelect: 'all' }}>{temp.password}</div>
            <div className="alert amb" style={{ fontSize: 13 }}>Bu parola yalnızca şimdi gösterilir. Kullanıcıya iletin; ilk girişte kendi parolasını belirlemesi istenir.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => navigator.clipboard.writeText(temp.password).then(() => toast('Kopyalandı.'))}>Kopyala</button>
              <button className="btn p" onClick={() => setTemp(null)}>Tamam</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function UserForm({ user, onClose, onCreated }: { user: AdminUserDto | null; onClose: () => void; onCreated: (name: string, password: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState<AdminUserInput>({
    fullName: user?.fullName ?? '',
    username: user?.username ?? '',
    role: user?.role ?? 'vet',
    chamberRegNo: user?.chamberRegNo ?? '',
    diplomaNo: user?.diplomaNo ?? '',
    email: user?.email ?? '',
    phone: user?.phone ? formatTrPhone(user.phone) : '',
    pinAllowed: user?.pinAllowed ?? false,
  })
  const save = useMutation({
    mutationFn: async () => {
      if (user) {
        const { username: _u, ...rest } = f
        await api.patch(`/api/admin/users/${user.id}`, rest)
        return null
      }
      return api.post<{ user: AdminUserDto; tempPassword: string }>('/api/admin/users', f)
    },
    onSuccess: (r) => {
      qc.invalidateQueries()
      if (r) onCreated(r.user.fullName, r.tempPassword)
      else toast('Kullanıcı kaydedildi.')
      onClose()
    },
  })
  useCtrlS(() => !save.isPending && save.mutate())
  const set = (k: keyof AdminUserInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })

  return (
    <Modal title={user ? `Kullanıcı: ${user.fullName}` : 'Yeni kullanıcı'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 12px' }}>
          <Field label="Ad soyad *" htmlFor="u-name" error={fieldErr(save.error, 'fullName')}>
            <input id="u-name" className="inp" value={f.fullName} onChange={set('fullName')} autoFocus />
          </Field>
          <Field label="Kullanıcı adı *" htmlFor="u-un" error={fieldErr(save.error, 'username')}>
            <input id="u-un" className="inp mono" value={f.username} onChange={set('username')} disabled={!!user} />
          </Field>
          <Field label="Rol *" htmlFor="u-role">
            <select id="u-role" className="inp" value={f.role} onChange={set('role')}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label={`Oda sicil no${f.role === 'vet' ? ' *' : ''}`} htmlFor="u-reg" error={fieldErr(save.error, 'chamberRegNo')}>
            <input id="u-reg" className="inp mono" value={f.chamberRegNo ?? ''} onChange={set('chamberRegNo')} />
          </Field>
          <Field label="Diploma no" htmlFor="u-dip">
            <input id="u-dip" className="inp mono" value={f.diplomaNo ?? ''} onChange={set('diplomaNo')} />
          </Field>
          <Field label="Cep telefonu" htmlFor="u-phone" error={fieldErr(save.error, 'phone')}>
            <input id="u-phone" className="inp mono" value={f.phone ?? ''} onChange={set('phone')} />
          </Field>
          <Field label="E-posta" htmlFor="u-mail" error={fieldErr(save.error, 'email')} style={{ gridColumn: '1 / -1' }}>
            <input id="u-mail" className="inp" value={f.email ?? ''} onChange={set('email')} />
          </Field>
          <label className="ck" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={!!f.pinAllowed} onChange={(e) => setF({ ...f, pinAllowed: e.target.checked })} />
            PIN ile girişe izin ver (kullanıcı PIN'ini Profilim'den belirler)
          </label>
          {!user && <div className="mut" style={{ gridColumn: '1 / -1', fontSize: 12 }}>Kaydedince geçici parola gösterilir; kullanıcı ilk girişte parolasını değiştirir.</div>}
        </div>
        <div className="form-foot">
          <span className="err">{save.isError && !fieldErr(save.error, 'fullName') ? errText(save.error) : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
            <button className="btn p" disabled={save.isPending}>Kaydet <span className="k">Ctrl+S</span></button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
