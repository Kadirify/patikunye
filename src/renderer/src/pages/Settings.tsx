// Ayarlar modülü: /ayarlar/* iç yönlendirmesi. F'nin sayfaları SettingsLayout ile sarılır;
// diğer modüllerin yerleştirilen sayfaları kendi düzenleriyle olduğu gibi gösterilir.
import { Navigate, Route, Routes } from 'react-router-dom'
import { SettingsLayout } from '../components/SettingsNav'
import { VaccineSettingsPage } from './Vaccines'
import { MessagingSettingsPage, TemplatesSettingsPage } from './Messages'
import { DatabaseSettingsPage } from './Backup'
import { NetworkSettingsPage, UpdatesSettingsPage } from './SystemSettings'
import { ClinicSettingsPage } from './settings/Clinic'
import { UsersSettingsPage } from './settings/Users'
import { RolesSettingsPage } from './settings/Roles'
import { DictionariesSettingsPage } from './settings/Dictionaries'
import { ReaderSettingsPage } from './settings/Reader'
import { PetvetSettingsPage } from './settings/PetvetSettings'
import { KvkkPage } from './settings/Kvkk'
import { AuditPage } from './settings/Audit'
import { ProfilePage } from './settings/Profile'
import { AppointmentSettingsPage } from './settings/AppointmentSettings'

const own = (el: React.ReactNode) => <SettingsLayout>{el}</SettingsLayout>

export function SettingsPage() {
  return (
    <Routes>
      <Route index element={<Navigate to="/ayarlar/klinik" replace />} />
      <Route path="klinik" element={own(<ClinicSettingsPage />)} />
      <Route path="kullanicilar" element={own(<UsersSettingsPage />)} />
      <Route path="roller" element={own(<RolesSettingsPage />)} />
      <Route path="sozlukler" element={own(<DictionariesSettingsPage />)} />
      <Route path="okuyucu" element={own(<ReaderSettingsPage />)} />
      <Route path="petvet" element={own(<PetvetSettingsPage />)} />
      <Route path="randevu" element={own(<AppointmentSettingsPage />)} />
      <Route path="kvkk/*" element={own(<KvkkPage />)} />
      <Route path="denetim" element={own(<AuditPage />)} />
      <Route path="profil" element={own(<ProfilePage />)} />
      {/* Diğer modüllerin sayfaları (kendi düzenleri) */}
      <Route path="asilar" element={<VaccineSettingsPage />} />
      <Route path="mesajlasma" element={<MessagingSettingsPage />} />
      <Route path="sablonlar" element={<TemplatesSettingsPage />} />
      <Route path="veritabani" element={<DatabaseSettingsPage />} />
      <Route path="ag" element={<NetworkSettingsPage />} />
      <Route path="guncellemeler" element={<UpdatesSettingsPage />} />
      <Route path="*" element={<Navigate to="/ayarlar/klinik" replace />} />
    </Routes>
  )
}
