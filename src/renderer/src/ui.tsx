// Küçük ortak arayüz parçaları
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { formatChip } from '@shared/chip'
import { PETVET_KIND_LABEL, type PetvetStatus, type PetvetTaskKind, type Urgency } from '@shared/petvet'
import { SPECIES_LABEL, type AnimalListItem, type Species } from '@shared/api-types'

export const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V21H3z',
  cal: 'M3 5h18v16H3zM8 3v4M16 3v4M3 10h18',
  list: 'M4 6h16M4 12h16M4 18h10',
  paw: 'M7 17c0-3 2.2-5 5-5s5 2 5 5c0 2-2 2.5-5 1.6C9 19.5 7 19 7 17zM5 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0M10 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M15 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
  user: 'M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21c0-4 3.6-7 8-7s8 3 8 7',
  steth: 'M6 3v6a5 5 0 0 0 10 0V3M11 14v2a5 5 0 0 0 10 0v-2',
  syringe: 'm17 3 4 4M15 5l4 4M18 6l-10 10-4 1 1-4 10-10M3 21l3-3',
  bank: 'M3 21h18M5 21V10M19 21V10M9.5 21V10M14.5 21V10M2 10l10-6 10 6z',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  chart: 'M5 20V11M11 20V5M17 20v-6M3 20h18',
  gear: 'M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  search: 'M4 11a7 7 0 1 0 14 0 7 7 0 1 0-14 0M20 20l-4-4',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  check: 'M4 12l5 5L20 6',
  scan: 'M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 12h8',
} as const

export function Icon({ d, size = 16 }: { d: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d={ICONS[d]} />
    </svg>
  )
}

export function Logo({ size = 16, hole = '#e3e0d9' }: { size?: number; hole?: string }) {
  return (
    <svg width={size} height={(size * 18) / 16} viewBox="0 0 16 18" role="img" aria-label="PatiKünye">
      <path d="M3 1h10l2 3v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4z" fill="#A0661A" />
      <circle cx="8" cy="5" r="1.6" fill={hole} />
      <path d="M4.5 10h7M4.5 13h5" stroke={hole} strokeWidth="1.3" />
    </svg>
  )
}

export function urgencyText(u: Urgency, daysLeft: number) {
  if (u === 'overdue') return `${-daysLeft} gün gecikti`
  if (u === 'today') return 'bugün son'
  return `${daysLeft} gün`
}
export const urgencyClass = (u: Urgency) => (u === 'overdue' ? 's-red' : u === 'today' || u === 'soon' ? 's-amb' : 's-gry')

export function PetvetState({ status, urgency, daysLeft }: { status: PetvetStatus; urgency: Urgency; daysLeft: number }) {
  if (status === 'done') return <span className="st s-ok">Girildi</span>
  if (status === 'cancelled') return <span className="st s-gry">İptal</span>
  if (status === 'missing_info') return <span className="st s-amb">Eksik bilgi</span>
  if (urgency === 'overdue') return <span className="st s-red">Süresi doldu</span>
  if (urgency === 'today') return <span className="st s-amb">Bugün son</span>
  return <span className="st s-gry">Bekliyor</span>
}

export const kindLabel = (k: PetvetTaskKind) => PETVET_KIND_LABEL[k]
export const speciesLabel = (s: Species) => SPECIES_LABEL[s]

export function ChipNo({ value, short }: { value: string | null; short?: boolean }) {
  if (!value) return <span className="s-red">çipsiz</span>
  const v = short && /^\d{15}$/.test(value) ? `${value.slice(0, 3)}…${value.slice(9, 12)} ${value.slice(12)}` : formatChip(value)
  return <span className="mono">{v}</span>
}

/** Yaş: 1 y 7 a */
export function age(birthDate: string | null, today = new Date()): string {
  if (!birthDate) return ''
  const [y, m] = birthDate.split('-').map(Number)
  let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m)
  if (months < 0) months = 0
  const yy = Math.floor(months / 12)
  const mm = months % 12
  return yy ? `${yy} y${mm ? ` ${mm} a` : ''}` : `${mm} a`
}

export function animalLine(a: Pick<AnimalListItem, 'species' | 'breed' | 'birthDate'>) {
  return [SPECIES_LABEL[a.species], a.breed, age(a.birthDate)].filter(Boolean).join(' · ')
}

/* Bildirim (toast) */
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'err') => void>(() => undefined)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: 'ok' | 'err'; id: number } | null>(null)
  const show = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now()
    setT({ msg, kind, id })
    if (kind === 'ok') setTimeout(() => setT((x) => (x?.id === id ? null : x)), 3000)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className="toast" role="status" style={t.kind === 'err' ? { borderColor: 'var(--red)' } : undefined}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span className={`st ${t.kind === 'err' ? 's-red' : 's-ok'}`} style={{ marginTop: 4 }} />
            <span style={{ flex: 1 }}>{t.msg}</span>
            <button className="btn sm" onClick={() => setT(null)}>
              Kapat
            </button>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

export function Field({ label, error, children, htmlFor, style }: { label: string; error?: string; children: ReactNode; htmlFor?: string; style?: React.CSSProperties }) {
  return (
    <div className="f" style={style}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <span className="err">{error}</span>}
    </div>
  )
}
