// Ayarlar > Randevu türleri ve tatiller (randevu modülünün uçlarını kullanır)
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useToast } from '../../ui'
import { formatDateTr } from '@shared/petvet'
import type { AppointmentTypeDto, HolidayDto } from '@shared/appointments'

export function AppointmentSettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const types = useQuery({ queryKey: ['appointment-types-all'], queryFn: () => api.get<AppointmentTypeDto[]>('/api/appointment-types') })
  const year = new Date().getFullYear()
  const holidays = useQuery({
    queryKey: ['holidays', year],
    queryFn: () => api.get<HolidayDto[]>(`/api/holidays?from=${year}-01-01&to=${year + 1}-12-31`),
  })
  const [nt, setNt] = useState({ name: '', color: '#8FA9D3', defaultMinutes: 30 })
  const [nh, setNh] = useState({ date: '', name: '' })

  const onErr = (e: unknown) => toast((e as Error).message, 'err')
  const done = (msg: string) => () => {
    qc.invalidateQueries()
    toast(msg)
  }
  const saveType = useMutation({
    mutationFn: (t: AppointmentTypeDto) => api.put(`/api/appointment-types/${t.id}`, { name: t.name, color: t.color, defaultMinutes: t.defaultMinutes, active: t.active, sort: t.sort }),
    onSuccess: done('Randevu türü kaydedildi.'),
    onError: onErr,
  })
  const addType = useMutation({
    mutationFn: () => api.post('/api/appointment-types', nt),
    onSuccess: () => {
      setNt({ name: '', color: '#8FA9D3', defaultMinutes: 30 })
      done('Randevu türü eklendi.')()
    },
    onError: onErr,
  })
  const addHoliday = useMutation({
    mutationFn: () => api.post('/api/holidays', nh),
    onSuccess: () => {
      setNh({ date: '', name: '' })
      done('Tatil eklendi.')()
    },
    onError: onErr,
  })
  const delHoliday = useMutation({ mutationFn: (id: string) => api.del(`/api/holidays/${id}`), onSuccess: done('Tatil silindi.'), onError: onErr })

  return (
    <>
      <div className="page-head">
        <h1>Randevu türleri ve tatiller</h1>
        <span className="mut">Çalışma saatleri Ayarlar &gt; Klinik'te.</span>
      </div>

      <section className="pnl">
        <div className="ph"><h2>Randevu türleri</h2></div>
        <table>
          <thead><tr><th>Ad</th><th>Renk</th><th>Varsayılan süre</th><th>Etkin</th><th></th></tr></thead>
          <tbody>
            {types.data?.map((t) => (
              <TypeRow key={t.id} t={t} onSave={(x) => saveType.mutate(x)} />
            ))}
            <tr>
              <td><input className="inp" aria-label="Yeni tür adı" placeholder="Yeni tür..." value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} /></td>
              <td><input type="color" aria-label="Renk" value={nt.color} onChange={(e) => setNt({ ...nt, color: e.target.value })} /></td>
              <td><input className="inp mono" style={{ width: 90 }} type="number" min={5} step={5} aria-label="Süre (dk)" value={nt.defaultMinutes} onChange={(e) => setNt({ ...nt, defaultMinutes: Number(e.target.value) })} /> dk</td>
              <td />
              <td><button className="btn sm" disabled={!nt.name.trim() || addType.isPending} onClick={() => addType.mutate()}>Ekle</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="pnl">
        <div className="ph"><h2>Resmî tatiller ve kapalı günler</h2><span className="mut" style={{ fontSize: 12 }}>{year}-{year + 1}</span></div>
        <table>
          <tbody>
            {holidays.data?.map((h) => (
              <tr key={h.id}>
                <td className="mono" style={{ width: 120 }}>{formatDateTr(h.date)}</td>
                <td>{h.name}</td>
                <td style={{ width: 80 }}><button className="btn sm" onClick={() => delHoliday.mutate(h.id)}>Sil</button></td>
              </tr>
            ))}
            <tr>
              <td><input type="date" className="inp" aria-label="Tarih" value={nh.date} onChange={(e) => setNh({ ...nh, date: e.target.value })} /></td>
              <td><input className="inp" aria-label="Ad" placeholder="ör. Cumhuriyet Bayramı" value={nh.name} onChange={(e) => setNh({ ...nh, name: e.target.value })} /></td>
              <td><button className="btn sm" disabled={!nh.date || !nh.name.trim() || addHoliday.isPending} onClick={() => addHoliday.mutate()}>Ekle</button></td>
            </tr>
          </tbody>
        </table>
        {holidays.data?.length === 0 && <div className="tfoot">Tatil girilmemiş. Tatil günlerine verilen randevularda uyarı çıkar.</div>}
      </section>
    </>
  )
}

function TypeRow({ t, onSave }: { t: AppointmentTypeDto; onSave(t: AppointmentTypeDto): void }) {
  const [x, setX] = useState(t)
  const dirty = JSON.stringify(x) !== JSON.stringify(t)
  return (
    <tr style={x.active ? undefined : { opacity: 0.6 }}>
      <td><input className="inp" aria-label="Ad" value={x.name} onChange={(e) => setX({ ...x, name: e.target.value })} /></td>
      <td><input type="color" aria-label="Renk" value={x.color} onChange={(e) => setX({ ...x, color: e.target.value })} /></td>
      <td><input className="inp mono" style={{ width: 90 }} type="number" min={5} step={5} aria-label="Süre (dk)" value={x.defaultMinutes} onChange={(e) => setX({ ...x, defaultMinutes: Number(e.target.value) })} /> dk</td>
      <td><label className="ck"><input type="checkbox" checked={x.active} onChange={(e) => setX({ ...x, active: e.target.checked })} />Etkin</label></td>
      <td><button className="btn sm" disabled={!dirty} onClick={() => onSave(x)}>Kaydet</button></td>
    </tr>
  )
}
