// S-104 Sözlükler: ırklar (tür bazında), renkler, sahip etiketleri, iptal nedenleri; CSV içe/dışa aktarma
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../../api'
import { useCan } from '../../session'
import { useToast } from '../../ui'
import { DICT_KINDS, DICT_KIND_LABEL, type DictItem, type DictKind } from '@shared/admin'
import { SPECIES_LABEL, type Species } from '@shared/api-types'
import { NoAccess, errText } from './common'

const SPECIES = Object.keys(SPECIES_LABEL) as Species[]

export function DictionariesSettingsPage() {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [kind, setKind] = useState<DictKind>('breed')
  const [species, setSpecies] = useState<Species>('cat')
  const [value, setValue] = useState('')
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const sp = kind === 'breed' ? species : undefined
  const list = useQuery({
    queryKey: ['dict-admin', kind, sp],
    queryFn: () => api.get<DictItem[]>(`/api/dictionaries/${kind}` + qs({ species: sp, all: 1 })),
    enabled: can('settings.manage'),
  })
  const items = (list.data ?? []).filter((d) => kind !== 'breed' || d.species === species)

  const done = (msg: string) => {
    setErr('')
    qc.invalidateQueries()
    toast(msg)
  }
  const add = useMutation({
    mutationFn: () => api.post<DictItem>(`/api/dictionaries/${kind}`, { value, species: sp }),
    onSuccess: () => {
      setValue('')
      done('Eklendi.')
    },
    onError: (e) => setErr(errText(e)),
  })
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; value?: string; sort?: number; active?: boolean }) => api.patch(`/api/dictionaries/item/${id}`, body),
    onSuccess: () => done('Kaydedildi.'),
    onError: (e) => setErr(errText(e)),
  })
  const imp = useMutation({
    mutationFn: async (file: File) => api.post<{ added: number; updated: number }>(`/api/dictionaries/${kind}/import`, { csv: await file.text() }),
    onSuccess: (r) => done(`İçe aktarıldı: ${r.added} yeni, ${r.updated} güncellendi.`),
    onError: (e) => setErr(errText(e)),
  })

  async function exportCsv() {
    try {
      const url = await api.blobUrl(`/api/dictionaries/${kind}/csv`)
      const a = document.createElement('a')
      a.href = url
      a.download = `sozluk-${kind}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setErr(errText(e))
    }
  }

  if (!can('settings.manage')) return <NoAccess />

  return (
    <>
      <div className="page-head">
        <h1>Sözlükler</h1>
        <div className="right">
          <button className="btn" onClick={exportCsv}>CSV dışa aktar</button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={imp.isPending}>CSV içe aktar…</button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) imp.mutate(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>
      <nav className="pnl fstrip" aria-label="Sözlük türü">
        {DICT_KINDS.map((k) => (
          <button key={k} className={`fl${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
            <span className="kx" style={{ fontSize: 13 }}>{DICT_KIND_LABEL[k]}</span>
          </button>
        ))}
      </nav>
      {err && <div className="alert" role="alert">{err}</div>}
      <section className="pnl">
        <form
          className="ph"
          style={{ height: 'auto', padding: 8, flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) add.mutate()
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {kind === 'breed' && (
              <select className="inp" style={{ width: 140 }} value={species} onChange={(e) => setSpecies(e.target.value as Species)} aria-label="Tür">
                {SPECIES.map((s) => <option key={s} value={s}>{SPECIES_LABEL[s]}</option>)}
              </select>
            )}
            <input className="inp" style={{ width: 240 }} placeholder="Yeni değer" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Yeni değer" />
            <button className="btn sm p" disabled={!value.trim() || add.isPending}>Ekle</button>
          </div>
          <span className="mut" style={{ fontSize: 12 }}>CSV sütunları: tur, deger, sira, aktif (1/0)</span>
        </form>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th style={{ width: 90 }}>Sıra</th><th>Değer</th><th>Durum</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <DictRow key={d.id + d.value + d.sort + d.active} d={d} onSave={(p) => patch.mutate({ id: d.id, ...p })} />
              ))}
            </tbody>
          </table>
          {list.data && items.length === 0 && <div className="empty">Bu listede değer yok.</div>}
        </div>
      </section>
    </>
  )
}

function DictRow({ d, onSave }: { d: DictItem; onSave: (p: { value?: string; sort?: number; active?: boolean }) => void }) {
  const [v, setV] = useState(d.value)
  const [s, setS] = useState(String(d.sort))
  const dirty = v.trim() !== d.value || Number(s) !== d.sort
  return (
    <tr style={d.active ? undefined : { opacity: 0.6 }}>
      <td><input className="inp mono" style={{ width: 70 }} value={s} onChange={(e) => setS(e.target.value.replace(/\D/g, ''))} aria-label="Sıra" /></td>
      <td><input className="inp" value={v} onChange={(e) => setV(e.target.value)} aria-label="Değer" /></td>
      <td>{d.active ? <span className="st s-ok">Etkin</span> : <span className="st s-gry">Pasif</span>}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {dirty && <button className="btn sm p" onClick={() => onSave({ value: v.trim(), sort: Number(s) || 0 })}>Kaydet</button>}{' '}
        <button className="btn sm" onClick={() => onSave({ active: !d.active })}>{d.active ? 'Pasifleştir' : 'Etkinleştir'}</button>
      </td>
    </tr>
  )
}
