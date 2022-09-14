// S-100 Klinik: bilgiler ve çalışma saatleri (resmî tatiller randevu modülündedir)
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useCan } from '../../session'
import { Field, useToast } from '../../ui'
import type { ClinicInfoDto } from '@shared/admin'
import type { ClinicSettings } from '@shared/settings'
import { NoAccess, errText, fieldErr, useCtrlS, useSaveSettings, useSettings } from './common'

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi']
const ORDER = [1, 2, 3, 4, 5, 6, 0]
type WH = ClinicSettings['workHours'][number]

export function ClinicSettingsPage() {
  const can = useCan()
  if (!can('settings.manage')) return <NoAccess />
  return (
    <>
      <div className="page-head"><h1>Klinik</h1></div>
      <ClinicInfoForm />
      <WorkHoursForm />
      <div className="mut" style={{ fontSize: 12 }}>Resmî tatiller ve kapalı günler randevu takviminden yönetilir.</div>
    </>
  )
}

function ClinicInfoForm() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['admin-clinic'], queryFn: () => api.get<ClinicInfoDto>('/api/admin/clinic') })
  const [f, setF] = useState<ClinicInfoDto | null>(null)
  useEffect(() => {
    if (q.data && !f) setF(q.data)
  }, [q.data, f])
  const save = useMutation({
    mutationFn: (v: ClinicInfoDto) => api.put<ClinicInfoDto>('/api/admin/clinic', v),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Klinik bilgileri kaydedildi.')
    },
  })
  const dirty = !!f && JSON.stringify(f) !== JSON.stringify(q.data)
  useCtrlS(() => f && dirty && save.mutate(f), dirty)
  if (!f) return <section className="pnl empty">{q.isError ? errText(q.error) : 'Yükleniyor…'}</section>
  const set = (k: keyof ClinicInfoDto) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })

  return (
    <form
      className="pnl"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(f)
      }}
    >
      <div className="ph"><h2>Klinik bilgileri</h2></div>
      <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 12px' }}>
        <Field label="Klinik adı *" htmlFor="c-name" error={fieldErr(save.error, 'name')}>
          <input id="c-name" className="inp" value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Telefon" htmlFor="c-phone">
          <input id="c-phone" className="inp mono" value={f.phone ?? ''} onChange={set('phone')} />
        </Field>
        <Field label="İl *" htmlFor="c-city" error={fieldErr(save.error, 'city')}>
          <input id="c-city" className="inp" value={f.city ?? ''} onChange={set('city')} />
        </Field>
        <Field label="İlçe *" htmlFor="c-district" error={fieldErr(save.error, 'district')}>
          <input id="c-district" className="inp" value={f.district ?? ''} onChange={set('district')} />
        </Field>
        <Field label="Adres (yazdırma anteti)" htmlFor="c-addr" style={{ gridColumn: '1 / -1' }}>
          <textarea id="c-addr" className="inp" style={{ height: 56, padding: 8 }} value={f.address ?? ''} onChange={set('address')} />
        </Field>
      </div>
      <div className="form-foot">
        <span className="err">{save.isError ? errText(save.error) : ''}</span>
        <button className="btn p" disabled={!dirty || save.isPending}>Kaydet <span className="k">Ctrl+S</span></button>
      </div>
    </form>
  )
}

function WorkHoursForm() {
  const s = useSettings()
  const save = useSaveSettings('Çalışma saatleri kaydedildi.')
  const [rows, setRows] = useState<WH[] | null>(null)
  useEffect(() => {
    if (s.data && !rows) setRows(s.data.workHours)
  }, [s.data, rows])
  if (!rows) return <section className="pnl empty">Yükleniyor…</section>
  const upd = (day: number, patch: Partial<WH>) => setRows(rows.map((r) => (r.day === day ? { ...r, ...patch } : r)))
  const byDay = (d: number): WH => rows.find((r) => r.day === d) ?? { day: d, open: '09:00', close: '18:00', closed: true }

  return (
    <form
      className="pnl"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ workHours: ORDER.map(byDay).map((r) => ({ ...r, breakStart: r.breakStart || undefined, breakEnd: r.breakEnd || undefined })) })
      }}
    >
      <div className="ph"><h2>Çalışma saatleri</h2><span className="mut" style={{ fontSize: 12 }}>Randevu takvimi bu saatleri kullanır</span></div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Gün</th><th>Açık</th><th>Açılış</th><th>Kapanış</th><th>Öğle arası</th></tr>
          </thead>
          <tbody>
            {ORDER.map((d) => {
              const r = byDay(d)
              return (
                <tr key={d}>
                  <td>{DAY_NAMES[d]}</td>
                  <td>
                    <label className="ck"><input type="checkbox" checked={!r.closed} onChange={(e) => upd(d, { closed: !e.target.checked })} aria-label={`${DAY_NAMES[d]} açık`} /></label>
                  </td>
                  <td><input type="time" className="inp mono" style={{ width: 100 }} value={r.open} disabled={r.closed} onChange={(e) => upd(d, { open: e.target.value })} aria-label={`${DAY_NAMES[d]} açılış`} /></td>
                  <td><input type="time" className="inp mono" style={{ width: 100 }} value={r.close} disabled={r.closed} onChange={(e) => upd(d, { close: e.target.value })} aria-label={`${DAY_NAMES[d]} kapanış`} /></td>
                  <td style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="time" className="inp mono" style={{ width: 100 }} value={r.breakStart ?? ''} disabled={r.closed} onChange={(e) => upd(d, { breakStart: e.target.value })} aria-label={`${DAY_NAMES[d]} öğle arası başlangıç`} />
                    –
                    <input type="time" className="inp mono" style={{ width: 100 }} value={r.breakEnd ?? ''} disabled={r.closed} onChange={(e) => upd(d, { breakEnd: e.target.value })} aria-label={`${DAY_NAMES[d]} öğle arası bitiş`} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="form-foot">
        <span className="err">{save.isError ? errText(save.error) : ''}</span>
        <button className="btn p" disabled={save.isPending}>Kaydet</button>
      </div>
    </form>
  )
}
