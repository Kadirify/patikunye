// S-102 Roller ve izinler: sabit roller, salt okunur izin matrisi
import { useCan } from '../../session'
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@shared/permissions'
import { ROLE_LABEL, type Role } from '@shared/api-types'
import { NoAccess } from './common'

const ROLES: Role[] = ['admin', 'vet', 'tech', 'secretary']

const PERM_LABEL: Record<Permission, string> = {
  'owners.read': 'Sahipleri görme',
  'owners.write': 'Sahip ekleme / düzenleme',
  'owners.tckn.view': 'Tam TCKN görme',
  'owners.export': 'Sahip verisi dışa aktarma',
  'owners.merge': 'Sahip birleştirme / silme',
  'animals.read': 'Hayvanları görme',
  'animals.write': 'Hayvan ekleme / düzenleme',
  'animals.status': 'Durum değişikliği (kayıp, devir)',
  'animals.death': 'Ölüm kaydı',
  'chips.implant': 'Çip uygulama',
  'chips.correct': 'Çip düzeltme',
  'visits.read': 'Muayene içeriğini görme',
  'visits.write': 'Muayene yazma',
  'visits.sign': 'Muayene imzalama',
  'vaccinations.write': 'Aşı uygulama',
  'petvet.read': 'PETVET işlerini görme',
  'petvet.manage': 'PETVET "girildi" işaretleme',
  'petvet.audit_pack': 'Denetim paketi',
  'appointments.read': 'Randevuları görme',
  'appointments.write': 'Randevu verme',
  'messages.send': 'Mesaj gönderme',
  'reports.view': 'Raporlar',
  'reports.export': 'Rapor dışa aktarma',
  'kvkk.requests': 'KVKK talepleri',
  'audit.view': 'Denetim kaydı',
  'settings.manage': 'Ayarlar',
  'users.manage': 'Kullanıcı yönetimi',
  'backup.run': 'Yedek alma',
  'backup.restore': 'Yedekten geri yükleme',
}

export function RolesSettingsPage() {
  const can = useCan()
  if (!can('settings.manage')) return <NoAccess />
  return (
    <>
      <div className="page-head">
        <h1>Roller ve izinler</h1>
        <span className="mut">Hazır roller · özel roller sonraki sürümde</span>
      </div>
      <section className="pnl">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>İzin</th>
                {ROLES.map((r) => <th key={r} style={{ textAlign: 'center' }}>{ROLE_LABEL[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p}>
                  <td>{PERM_LABEL[p]} <span className="mono mut" style={{ fontSize: 11 }}>{p}</span></td>
                  {ROLES.map((r) => (
                    <td key={r} style={{ textAlign: 'center' }}>
                      {ROLE_PERMISSIONS[r].has(p) ? <span className="s-ok" aria-label="var">✓</span> : <span className="mut" aria-label="yok">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tfoot mut">Klinik Yöneticisi rolü tüm izinlere sahiptir ve değiştirilemez. Rolleri kopyalayıp özel rol oluşturma sonraki sürümde gelecek.</div>
      </section>
    </>
  )
}
