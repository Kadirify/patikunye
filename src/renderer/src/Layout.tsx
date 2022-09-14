import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { useCan, useSession } from './session'
import { useChipCapture } from './chipCapture'
import { ChipPanel } from './ChipPanel'
import { CommandPalette } from './components/CommandPalette'
import { NotificationBell } from './components/Notifications'
import { LockScreen, useIdleLock } from './components/LockScreen'
import { Icon, Logo, type ICONS } from './ui'
import type { BackupStatusDto } from '@shared/backup'
import { ROLE_LABEL, type PetvetSummary } from '@shared/api-types'

export function TitleBar({ subtitle }: { subtitle?: string }) {
  const w = window.patikunye?.window
  return (
    <div className="titlebar">
      <div className="t">
        <Logo />
        <strong>PatiKünye</strong>
        {subtitle && <span className="mut" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>— {subtitle}</span>}
      </div>
      {w && (
        <>
          <button className="wc" aria-label="Simge durumuna küçült" onClick={() => w.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" /></svg>
          </button>
          <button className="wc" aria-label="Ekranı kapla" onClick={() => w.toggleMaximize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
          </button>
          <button className="wc close" aria-label="Tepsiye gizle" onClick={() => w.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0 0 10" stroke="currentColor" /></svg>
          </button>
        </>
      )}
    </div>
  )
}

function NavItem({ to, icon, label, count, countHot }: { to: string; icon: keyof typeof ICONS; label: string; count?: string; countHot?: boolean }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}>
      <Icon d={icon} />
      {label}
      {count && (
        <span className="n" style={countHot ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
          {count}
        </span>
      )}
    </NavLink>
  )
}

/** Kenar çubuğu altı: bağlantı türü, son yedek, sürüm */
function SideFooter() {
  const can = useCan()
  const [mode, setMode] = useState<{ mode: string; host?: string } | null>(null)
  useEffect(() => {
    window.patikunye?.getStatus().then((s) => setMode({ mode: s.mode, host: s.client?.clinicName }))
  }, [])
  const bk = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => api.get<BackupStatusDto>('/api/backup/status'),
    refetchInterval: 300_000,
    enabled: can('backup.run'),
    retry: false,
  })
  const b = bk.data
  const bkText = !b
    ? null
    : !b.passwordSet
      ? 'Yedek parolası yok'
      : b.lastSuccessAt
        ? `Son yedek: ${new Date(b.lastSuccessAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
        : 'Henüz yedek yok'
  return (
    <div className="side-foot">
      <span>{!window.patikunye ? 'Tarayıcı geliştirme modu' : mode?.mode === 'client' ? `İstemci · ${mode.host ?? ''}` : 'Ana bilgisayar'}</span>
      {bkText && (
        <Link to="/ayarlar/yedekleme" style={{ color: b?.state === 'err' ? 'var(--red)' : b?.state === 'warn' ? 'var(--amb)' : 'inherit', textDecoration: 'none' }}>
          {bkText}
        </Link>
      )}
      <span>PostgreSQL 18 · {window.patikunye?.version ? `v${window.patikunye.version}` : 'geliştirme'}</span>
    </div>
  )
}

/** Okuma onay sesi (kısa bip) */
function beep() {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 1320
    g.gain.value = 0.06
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.08)
    o.onended = () => ctx.close()
  } catch {
    /* ses yok */
  }
}

export function Layout() {
  const { user, clinicName, signOut } = useSession()
  const nav = useNavigate()
  const [chip, setChip] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [palette, setPalette] = useState(false)
  const [locked, setLocked] = useState(false)

  const sys = useQuery({
    queryKey: ['system-info'],
    queryFn: () => api.get<{ shell: { lockMinutes: number; readerMaxGapMs: number; readerSound: boolean } }>('/api/system/info'),
    staleTime: 5 * 60_000,
  })
  const shell = sys.data?.shell
  useChipCapture({
    maxGapMs: shell?.readerMaxGapMs ?? 35,
    onChip: (raw) => {
      if (locked) return
      if (shell?.readerSound !== false) beep()
      setChip(raw)
    },
  })
  useIdleLock(shell?.lockMinutes ?? 10, () => setLocked(true))

  const summary = useQuery({
    queryKey: ['petvet-summary'],
    queryFn: () => api.get<PetvetSummary>('/api/petvet/summary'),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    // Klavye kısayolları (SAYFALAR.md §18)
    const NAV = ['/', '/randevular', '/bekleme', '/hayvanlar', '/sahipler', '/muayeneler', '/asilar', '/petvet', '/mesajlar']
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && !e.shiftKey && k === 'k') {
        e.preventDefault()
        setPalette(true)
      } else if (e.ctrlKey && !e.shiftKey && k === 'n') {
        e.preventDefault()
        nav('/kayit')
      } else if (e.ctrlKey && e.shiftKey && k === 'r') {
        e.preventDefault()
        nav('/randevular?yeni=1')
      } else if (e.ctrlKey && !e.shiftKey && k === 'l') {
        e.preventDefault()
        setLocked(true)
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        nav(NAV[Number(e.key) - 1])
      } else if (e.key === 'Escape') setChip(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav])

  const s = summary.data
  return (
    <div className="app">
      <TitleBar subtitle={clinicName} />
      <div className="toolbar">
        <button
          type="button"
          aria-label="Ara (Ctrl+K)"
          onClick={() => setPalette(true)}
          style={{ flex: '0 1 440px', display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 8px', border: '1px solid #bdb7ac', borderRadius: 3, background: '#fff', color: 'var(--muted)', cursor: 'text', textAlign: 'left' }}
        >
          <Icon d="search" size={14} />
          <span style={{ flex: 1 }}>Hayvan, sahip, telefon, çip no</span>
          <span className="mono" style={{ fontSize: 11 }}>Ctrl+K</span>
        </button>
        <Link to="/kayit" className="tb">
          Yeni kayıt <span className="mono mut" style={{ fontSize: 11 }}>Ctrl+N</span>
        </Link>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
          <span className="st s-ok" style={{ fontSize: 12, padding: '0 10px' }}>Okuyucu: klavye modu</span>
          <NotificationBell />
          <button className="tb" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            {user?.fullName}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {menu && (
            <div className="pnl" style={{ position: 'absolute', right: 0, top: 36, minWidth: 200, zIndex: 20, padding: 4 }}>
              <div className="mut" style={{ padding: '6px 8px', fontSize: 12 }}>{user && ROLE_LABEL[user.role]}</div>
              <button className="tb" style={{ width: '100%' }} onClick={() => { setMenu(false); setLocked(true) }}>
                Ekranı kilitle <span className="mono mut" style={{ fontSize: 11, marginLeft: 'auto' }}>Ctrl+L</span>
              </button>
              <Link className="tb" style={{ width: '100%' }} to="/ayarlar/profil" onClick={() => setMenu(false)}>
                Profilim
              </Link>
              <button className="tb" style={{ width: '100%' }} onClick={() => signOut()}>
                Çıkış yap
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="body">
        <nav className="side" aria-label="Ana menü">
          <div className="grp" style={{ paddingTop: 4 }}>Klinik</div>
          <NavItem to="/" icon="home" label="Bugün" />
          <NavItem to="/randevular" icon="cal" label="Randevular" />
          <NavItem to="/bekleme" icon="list" label="Bekleme salonu" />
          <div className="grp">Kayıtlar</div>
          <NavItem to="/hayvanlar" icon="paw" label="Hayvanlar" />
          <NavItem to="/sahipler" icon="user" label="Sahipler" />
          <NavItem to="/muayeneler" icon="steth" label="Muayeneler" />
          <NavItem to="/asilar" icon="syringe" label="Aşı takvimi" />
          <NavItem
            to="/petvet"
            icon="bank"
            label="PETVET işleri"
            count={s ? (s.overdue ? `${s.overdue} / ${s.open}` : String(s.open)) : undefined}
            countHot={!!s?.overdue}
          />
          <div className="grp">Diğer</div>
          <NavItem to="/mesajlar" icon="mail" label="Mesajlar" />
          <NavItem to="/raporlar" icon="chart" label="Raporlar" />
          <NavItem to="/ayarlar" icon="gear" label="Ayarlar" />
          <SideFooter />
        </nav>
        <main className="main">
          <Outlet />
        </main>
        {chip && <ChipPanel raw={chip} onClose={() => setChip(null)} />}
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {locked && <LockScreen onUnlock={() => setLocked(false)} />}
    </div>
  )
}
