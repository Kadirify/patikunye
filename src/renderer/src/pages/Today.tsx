// Bugün
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { ChipNo, PetvetState, animalLine, kindLabel, urgencyClass, urgencyText } from '../ui'
import { formatDateTr } from '@shared/petvet'
import type { DashboardDto } from '@shared/api-types'
import { TodayAppointmentsPanel } from './Appointments'
import { TodayVaccinesPanel } from './Vaccines'

export function TodayPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardDto>('/api/dashboard'), refetchInterval: 60_000 })
  const d = q.data
  const dateText = d
    ? new Date(d.today + 'T12:00:00').toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : ''

  return (
    <>
      <div className="page-head">
        <h1>Bugün</h1>
        <span className="mut">{dateText}</span>
        <div className="right">
          <Link to="/kayit" className="btn p">Çip okut / yeni kayıt</Link>
        </div>
      </div>
      {q.isError && <div className="alert">{(q.error as Error).message}</div>}

      {d && d.petvet.overdue > 0 && (
        <div className="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong className="s-red">{d.petvet.overdue} PETVET kaydının süresi doldu.</strong>
          <span>Gecikme, çipi uygulayan hekim hakkında işlem yapılmasına yol açabilir.</span>
          <Link to="/petvet?f=overdue" className="btn sm" style={{ marginLeft: 'auto' }}>Gecikenleri aç</Link>
        </div>
      )}

      <div className="row2">
        <div style={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TodayAppointmentsPanel />
        <section className="pnl">
          <div className="ph">
            <h2>Son kayıtlar</h2>
            <Link to="/hayvanlar" style={{ fontSize: 12 }}>Tüm hayvanlar</Link>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Hasta</th><th>Sahip</th><th>Çip</th><th>PETVET</th></tr>
              </thead>
              <tbody>
                {d?.recentAnimals.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/hayvanlar/${a.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><strong>{a.name}</strong></Link>
                      <div className="mut">{animalLine(a)}</div>
                    </td>
                    <td>{a.ownerName}</td>
                    <td><ChipNo value={a.chipNo} short /></td>
                    <td>{a.petvet ? <PetvetState {...a.petvet} /> : <span className="mut">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && d.recentAnimals.length === 0 && (
              <div className="empty">Henüz kayıt yok. Okuyucuyla bir çip okutun ya da <Link to="/kayit">yeni kayıt</Link> açın.</div>
            )}
          </div>
        </section>
        </div>

        <div style={{ flex: '2 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <section className="pnl">
          <div className="ph"><h2>Bekleyen PETVET işleri</h2><Link to="/petvet" style={{ fontSize: 12 }}>Tümü</Link></div>
          {d?.urgentTasks.length === 0 && <div className="empty">Bu hafta süresi dolan iş yok.</div>}
          {d?.urgentTasks.map((t) => (
            <Link key={t.id} to={`/petvet/${t.id}`} className="list-row">
              <span><strong>{t.animalName}</strong> - {kindLabel(t.kind).toLocaleLowerCase('tr-TR')} {t.status === 'missing_info' && <span className="s-amb">- eksik bilgi</span>}</span>
              <span className={`mono ${urgencyClass(t.urgency)}`}>{urgencyText(t.urgency, t.daysLeft)}</span>
            </Link>
          ))}
          {d && (
            <>
              <div className="gh">Bu ay</div>
              <div className="list-row" style={{ borderBottom: 0 }}>
                <span>{d.chipsThisMonth} çip uygulandı - {d.petvet.doneThisMonth} kayıt PETVET'e girildi</span>
                <span className="mono mut">{formatDateTr(d.today).slice(3)}</span>
              </div>
            </>
          )}
        </section>
        <TodayVaccinesPanel />
        </div>
      </div>
    </>
  )
}
