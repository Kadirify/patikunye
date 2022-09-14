// S-110 PETVET ayarları: görev süreleri, görev açan aşı türleri, uyarı günü, belge zorunluluğu, TARBİL adresi
import { useEffect, useState } from 'react'
import { useCan } from '../../session'
import { PETVET_KIND_LABEL, PETVET_TASK_KINDS } from '@shared/petvet'
import { DEFAULT_TARBIL_URL } from '@shared/admin'
import { NoAccess, Row, errText, useCtrlS, useSaveSettings, useSettings, type FullSettings } from './common'

type P = FullSettings['petvet']

export function PetvetSettingsPage() {
  const can = useCan()
  const s = useSettings()
  const save = useSaveSettings('PETVET ayarları kaydedildi.')
  const [p, setP] = useState<P | null>(null)
  const [kinds, setKinds] = useState('')
  useEffect(() => {
    if (s.data && !p) {
      setP({ ...s.data.petvet, tarbilUrl: s.data.petvet.tarbilUrl ?? DEFAULT_TARBIL_URL })
      setKinds(s.data.petvet.vaccineKinds.join(', '))
    }
  }, [s.data, p])
  const submit = () =>
    p &&
    save.mutate({
      petvet: {
        ...p,
        vaccineKinds: kinds
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      },
    })
  useCtrlS(submit, !!p)

  if (!can('settings.manage')) return <NoAccess />
  if (!p) return <div className="mut">Yükleniyor…</div>

  return (
    <>
      <div className="page-head"><h1>PETVET</h1><span className="mut">Bakanlık evcil hayvan kayıt sistemi görevleri</span></div>
      <form
        className="pnl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="ph"><h2>Görev süreleri (gün)</h2><span className="mut" style={{ fontSize: 12 }}>Yeni çip için 15 gün; diğerleri ⚠️ mevzuattan doğrulanmalı</span></div>
        {PETVET_TASK_KINDS.map((k) => (
          <Row key={k} label={PETVET_KIND_LABEL[k]} htmlFor={`pd-${k}`}>
            <input
              id={`pd-${k}`}
              type="number"
              min={1}
              max={365}
              className="inp mono"
              style={{ width: 80 }}
              value={p.days[k]}
              onChange={(e) => setP({ ...p, days: { ...p.days, [k]: Number(e.target.value) } })}
            />
            <span className="mut">gün</span>
          </Row>
        ))}
        <div className="ph" style={{ borderTop: '1px solid var(--line-2)' }}><h2>Kurallar</h2></div>
        <Row label="Görev açan aşı türleri" htmlFor="p-kinds">
          <input id="p-kinds" className="inp mono" style={{ maxWidth: 320 }} value={kinds} onChange={(e) => setKinds(e.target.value)} />
          <span className="mut" style={{ fontSize: 12 }}>Virgülle ayırın (ör. rabies)</span>
        </Row>
        <Row label="Uyarı" htmlFor="p-warn">
          <input id="p-warn" type="number" min={0} max={60} className="inp mono" style={{ width: 80 }} value={p.warnDaysBefore} onChange={(e) => setP({ ...p, warnDaysBefore: Number(e.target.value) })} />
          <span className="mut">gün kala uyar</span>
        </Row>
        <Row label="Belge">
          <label className="ck"><input type="checkbox" checked={p.requireEvidence} onChange={(e) => setP({ ...p, requireEvidence: e.target.checked })} />"Girildi" işaretlerken belge (ekran görüntüsü / çıktı) zorunlu</label>
        </Row>
        <Row label="TARBİL adresi" htmlFor="p-url" last>
          <input id="p-url" className="inp mono" style={{ maxWidth: 360 }} value={p.tarbilUrl ?? ''} onChange={(e) => setP({ ...p, tarbilUrl: e.target.value })} />
          <button type="button" className="btn sm" onClick={() => setP({ ...p, tarbilUrl: DEFAULT_TARBIL_URL })}>Varsayılan</button>
        </Row>
        <div className="form-foot">
          <span className="err">{save.isError ? errText(save.error) : ''}</span>
          <button className="btn p" disabled={save.isPending}>Kaydet <span className="k">Ctrl+S</span></button>
        </div>
      </form>
    </>
  )
}
