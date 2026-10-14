// Ayarlar alt menüsü. Ayarlar modülü ve Yedekleme modülü birlikte kullanır.
import { NavLink } from 'react-router-dom'

export const SETTINGS_LINKS: { to: string; label: string }[] = [
  { to: '/ayarlar/klinik', label: 'Klinik' },
  { to: '/ayarlar/kullanicilar', label: 'Kullanıcılar' },
  { to: '/ayarlar/roller', label: 'Roller ve izinler' },
  { to: '/ayarlar/asilar', label: 'Aşılar ve ürünler' },
  { to: '/ayarlar/sozlukler', label: 'Sözlükler' },
  { to: '/ayarlar/randevu', label: 'Randevu türleri ve tatiller' },
  { to: '/ayarlar/mesajlasma', label: 'Mesajlaşma' },
  { to: '/ayarlar/sablonlar', label: 'Mesaj şablonları' },
  { to: '/ayarlar/okuyucu', label: 'Çip okuyucu' },
  { to: '/ayarlar/yedekleme', label: 'Yedekleme' },
  { to: '/ayarlar/ag', label: 'Ağ ve cihazlar' },
  { to: '/ayarlar/petvet', label: 'PETVET' },
  { to: '/ayarlar/veritabani', label: 'Veritabanı' },
  { to: '/ayarlar/guncellemeler', label: 'Güncellemeler' },
  { to: '/ayarlar/kvkk', label: 'KVKK' },
  { to: '/ayarlar/denetim', label: 'Denetim kaydı' },
  { to: '/ayarlar/profil', label: 'Profilim' },
]

export function SettingsNav() {
  return (
    <nav aria-label="Ayarlar" style={{ flex: '0 1 190px', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="grp" style={{ padding: '4px 10px 6px' }}>Ayarlar</span>
      {SETTINGS_LINKS.map((l) => (
        <NavLink key={l.to} to={l.to} className={({ isActive }) => `nav${isActive ? ' active' : ''}`} style={{ height: 30 }}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Ayarlar sayfaları için iki sütunlu düzen */
export function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <SettingsNav />
      <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  )
}
