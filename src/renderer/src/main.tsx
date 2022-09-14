import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { SessionProvider, useSession } from './session'
import { Layout, TitleBar } from './Layout'
import { ToastProvider } from './ui'
import { LoginPage } from './pages/Auth'
import { BootGate } from './pages/Setup'
import { TodayPage } from './pages/Today'
import { AnimalDetailPage, AnimalsPage } from './pages/Animals'
import { QuickRegisterPage } from './pages/QuickRegister'
import { PetvetListPage, PetvetTaskPage } from './pages/Petvet'
import { OwnerDetailPage, OwnersPage } from './pages/Owners'
import { VisitEditorPage, VisitsPage } from './pages/Visits'
import { VaccinatePage, VaccineCalendarPage } from './pages/Vaccines'
import { MessagesPage } from './pages/Messages'
import { AppointmentsPage, WaitingRoomPage } from './pages/Appointments'
import { SettingsPage } from './pages/Settings'
import { BackupPage } from './pages/Backup'
import { PrintPage, ReportsPage } from './pages/Reports'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

function Root() {
  const { user, ready } = useSession()
  if (!ready) return <div className="app"><TitleBar /></div>
  if (!user) return <LoginPage />

  return (
    <Routes>
      {/* Yazdırma önizlemesi: ayrı pencerede, menüsüz */}
      <Route path="yazdir/:kind/:id?" element={<PrintPage />} />
      <Route element={<Layout />}>
        <Route index element={<TodayPage />} />
        <Route path="hayvanlar" element={<AnimalsPage />} />
        <Route path="hayvanlar/:id" element={<AnimalDetailPage />} />
        <Route path="kayit" element={<QuickRegisterPage />} />
        <Route path="petvet" element={<PetvetListPage />} />
        <Route path="petvet/:id" element={<PetvetTaskPage />} />
        <Route path="sahipler" element={<OwnersPage />} />
        <Route path="sahipler/:id" element={<OwnerDetailPage />} />
        <Route path="muayeneler" element={<VisitsPage />} />
        <Route path="muayene/:id" element={<VisitEditorPage />} />
        <Route path="asilar" element={<VaccineCalendarPage />} />
        <Route path="asilar/uygula" element={<VaccinatePage />} />
        <Route path="mesajlar" element={<MessagesPage />} />
        <Route path="randevular" element={<AppointmentsPage />} />
        <Route path="bekleme" element={<WaitingRoomPage />} />
        <Route path="raporlar" element={<ReportsPage />} />
        <Route path="ayarlar/yedekleme" element={<BackupPage />} />
        <Route path="ayarlar/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BootGate>
          <SessionProvider>
            <HashRouter>
              <Root />
            </HashRouter>
          </SessionProvider>
        </BootGate>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
