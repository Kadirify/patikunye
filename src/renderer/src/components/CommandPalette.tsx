// S-11 Global arama / komut paleti (Ctrl+K)
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, qs } from '../api'
import { animalLine } from '../ui'
import { formatTrPhone } from '@shared/identity'
import { useCan } from '../session'
import type { AnimalListItem, OwnerListItem } from '@shared/api-types'
import type { Permission } from '@shared/permissions'

interface Item {
  key: string
  group: 'Hayvanlar' | 'Sahipler' | 'Komutlar' | 'Son açılanlar'
  title: string
  sub?: string
  go: string
  alt?: string // Ctrl+Enter hedefi
}

const COMMANDS: { title: string; go: string; perm?: Permission; words: string }[] = [
  { title: 'Yeni kayıt (çip okut)', go: '/kayit', perm: 'animals.write', words: 'yeni kayıt çip hızlı' },
  { title: 'Yeni randevu', go: '/randevular?yeni=1', perm: 'appointments.write', words: 'randevu yeni' },
  { title: 'Bekleme salonu', go: '/bekleme', words: 'bekleme salon akış' },
  { title: 'PETVET işleri', go: '/petvet', perm: 'petvet.read', words: 'petvet bakanlık tarbil' },
  { title: 'Geciken PETVET işleri', go: '/petvet?f=overdue', perm: 'petvet.read', words: 'petvet gecikmiş süresi doldu' },
  { title: 'Aşı takvimi', go: '/asilar', words: 'aşı takvim geciken' },
  { title: 'Muayeneler', go: '/muayeneler', perm: 'visits.read', words: 'muayene liste' },
  { title: 'Mesajlar', go: '/mesajlar', perm: 'messages.send', words: 'mesaj sms hatırlatma' },
  { title: 'Raporlar', go: '/raporlar', perm: 'reports.view', words: 'rapor istatistik' },
  { title: 'Yedek al / yedekleme', go: '/ayarlar/yedekleme', perm: 'backup.run', words: 'yedek yedekleme geri yükle' },
  { title: 'Kullanıcılar', go: '/ayarlar/kullanicilar', perm: 'users.manage', words: 'kullanıcı personel hekim' },
  { title: 'Ayarlar', go: '/ayarlar', words: 'ayar' },
]

const norm = (s: string) => s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')

function recent(): Item[] {
  try {
    return JSON.parse(localStorage.getItem('pk.recent') ?? '[]') as Item[]
  } catch {
    return []
  }
}
export function rememberRecent(it: Omit<Item, 'group' | 'key'>) {
  try {
    const list = recent().filter((x) => x.go !== it.go)
    list.unshift({ ...it, key: 'r' + it.go, group: 'Son açılanlar' })
    localStorage.setItem('pk.recent', JSON.stringify(list.slice(0, 10)))
  } catch {
    /* depolama yok */
  }
}

export function CommandPalette({ onClose }: { onClose(): void }) {
  const nav = useNavigate()
  const can = useCan()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const term = q.trim()
  const enabled = term.length >= 2

  const animals = useQuery({
    queryKey: ['pal-animals', term],
    queryFn: () => api.get<AnimalListItem[]>('/api/animals' + qs({ q: term, status: 'all' })),
    enabled: enabled && can('animals.read'),
  })
  const owners = useQuery({
    queryKey: ['pal-owners', term],
    queryFn: () => api.get<OwnerListItem[]>('/api/owners' + qs({ q: term })),
    enabled: enabled && can('owners.read') && !/^\d{6,}$/.test(term.replace(/\s/g, '')),
  })

  const items = useMemo<Item[]>(() => {
    if (!term) return recent()
    const n = norm(term)
    const cmds = COMMANDS.filter((c) => (!c.perm || can(c.perm)) && (norm(c.title).includes(n) || norm(c.words).includes(n))).map(
      (c): Item => ({ key: 'c' + c.go, group: 'Komutlar', title: c.title, go: c.go }),
    )
    const an = (animals.data ?? []).slice(0, 8).map(
      (a): Item => ({
        key: 'a' + a.id,
        group: 'Hayvanlar',
        title: a.name,
        sub: [animalLine(a), a.ownerName].filter(Boolean).join(' · '),
        go: `/hayvanlar/${a.id}`,
        alt: `/muayene/yeni?animal=${a.id}`,
      }),
    )
    const ow = (owners.data ?? []).slice(0, 6).map(
      (o): Item => ({ key: 'o' + o.id, group: 'Sahipler', title: o.fullName, sub: `${formatTrPhone(o.phone)} · ${o.animalCount} hayvan`, go: `/sahipler/${o.id}` }),
    )
    return [...an, ...ow, ...cmds]
  }, [term, animals.data, owners.data, can])

  useEffect(() => setSel(0), [term])
  useEffect(() => input.current?.focus(), [])

  function open(it: Item, alt = false) {
    if (it.group === 'Hayvanlar' || it.group === 'Sahipler') rememberRecent({ title: it.title, sub: it.sub, go: it.go, alt: it.alt })
    onClose()
    nav(alt && it.alt ? it.alt : it.go)
  }

  let lastGroup = ''
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ara"
      style={{ position: 'fixed', inset: 0, background: 'rgba(29,28,26,.25)', zIndex: 60, display: 'flex', justifyContent: 'center', paddingTop: 90 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="pnl" style={{ width: 640, maxWidth: 'calc(100% - 32px)', alignSelf: 'flex-start', boxShadow: '0 12px 40px rgba(29,28,26,.25)' }}>
        <input
          ref={input}
          className="inp"
          style={{ height: 44, fontSize: 15, border: 0, borderBottom: '1px solid var(--line)', borderRadius: 0, outline: 'none' }}
          placeholder="Hayvan, sahip, telefon, çip no ya da komut…"
          aria-label="Ara"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(items.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter' && items[sel]) {
              e.preventDefault()
              open(items[sel], e.ctrlKey)
            }
          }}
        />
        <div style={{ maxHeight: 420, overflowY: 'auto' }} role="listbox">
          {items.map((it, i) => {
            const head = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.key}>
                {head && <div className="gh">{it.group}</div>}
                <button
                  role="option"
                  aria-selected={i === sel}
                  className="list-row"
                  style={{ width: '100%', border: 0, textAlign: 'left', cursor: 'pointer', background: i === sel ? 'var(--sel)' : '#fff' }}
                  onMouseEnter={() => setSel(i)}
                  onClick={(e) => open(it, e.ctrlKey)}
                >
                  <span>
                    <strong>{it.title}</strong>
                    {it.sub && <span className="mut"> · {it.sub}</span>}
                  </span>
                  <span className="mono mut" style={{ fontSize: 11 }}>{i === sel ? (it.alt ? 'Enter · Ctrl+Enter muayene' : 'Enter') : ''}</span>
                </button>
              </div>
            )
          })}
          {enabled && items.length === 0 && !animals.isLoading && <div className="empty">Sonuç yok.</div>}
          {!term && items.length === 0 && <div className="empty">Aramaya başlayın. Son açılan kayıtlar burada görünür.</div>}
        </div>
      </div>
    </div>
  )
}
