// S-12 Çip okundu paneli
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api, qs } from './api'
import { ChipNo, PetvetState, age, urgencyText } from './ui'
import { formatTrPhone } from '@shared/identity'
import { formatDateTr } from '@shared/petvet'
import { SEX_LABEL, SPECIES_LABEL, type ChipLookupDto } from '@shared/api-types'

export function ChipPanel({ raw, onClose }: { raw: string; onClose(): void }) {
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ['chip-lookup', raw],
    queryFn: () => api.get<ChipLookupDto>('/api/chips/lookup' + qs({ no: raw })),
  })
  const at = new Date().toLocaleTimeString('tr-TR')
  const v = q.data?.validation
  const m = q.data?.match

  return (
    <aside className="dock" aria-label="Okunan çip">
      <div className="ph" style={{ height: 40 }}>
        <h2>
          Çip okundu <span className="mut" style={{ fontWeight: 400 }}>· {at}</span>
        </h2>
        <button className="btn sm" onClick={onClose} aria-label="Paneli kapat">
          Kapat <span className="mono mut" style={{ fontSize: 11 }}>Esc</span>
        </button>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {q.isLoading && <div className="mut">Sorgulanıyor…</div>}
        {q.isError && <div className="alert">{(q.error as Error).message}</div>}

        {v && !v.ok && (
          <div className="alert amb">
            <div className="st s-amb" style={{ fontWeight: 600 }}>Geçersiz numara</div>
            <div className="mono" style={{ margin: '6px 0' }}>{v.input}</div>
            <div>{v.error}</div>
          </div>
        )}

        {v?.ok && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '10px 12px', background: 'var(--head)' }}>
            <div className="mut" style={{ fontSize: 12 }}>
              Çip numarası · {v.format === 'iso' ? 'ISO FDX-B' : 'eski format'}
              {v.code !== undefined && ` · ${String(v.code).padStart(3, '0')} ${v.codeKind === 'country' ? (v.code === 792 ? 'Türkiye' : 'yurt dışı') : v.codeKind === 'manufacturer' ? 'üretici kodu' : 'test'}`}
            </div>
            <div className="mono" style={{ fontSize: 22, letterSpacing: '0.04em', marginTop: 2 }}>
              <ChipNo value={v.value} />
            </div>
            {v.warnings.map((w) => (
              <div key={w} className="st s-amb" style={{ marginTop: 6 }}>{w}</div>
            ))}
          </div>
        )}

        {v?.ok && m && (
          <>
            {m.animal.status === 'lost' && (
              <div className="alert"><strong className="s-red">KAYIP</strong> — bu hayvan kayıp olarak işaretli. Sahibini arayın.</div>
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="photo" style={{ width: 72, height: 72 }}>fotoğraf</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 20, fontWeight: 600 }}>{m.animal.name}</span>
                <span className="mut">
                  {[SPECIES_LABEL[m.animal.species], m.animal.breed, SEX_LABEL[m.animal.sex], age(m.animal.birthDate)].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
            <dl className="kv">
              <dt>Sahip</dt>
              <dd><strong>{m.animal.ownerName ?? '—'}</strong></dd>
              <dt>Telefon</dt>
              <dd className="mono">{formatTrPhone(m.animal.ownerPhone)}</dd>
              <dt>Çip uygulama</dt>
              <dd>{formatDateTr(m.chip.implantedAt)} · {m.chip.implantedByName ?? ''} · {m.chip.bodySite}</dd>
              <dt>PETVET</dt>
              <dd>
                {m.animal.petvet ? (
                  <span>
                    <PetvetState status={m.animal.petvet.status} urgency={m.animal.petvet.urgency} daysLeft={m.animal.petvet.daysLeft} />{' '}
                    <span className="mut">· {urgencyText(m.animal.petvet.urgency, m.animal.petvet.daysLeft)}</span>
                  </span>
                ) : (
                  <span className="st s-ok">Bekleyen iş yok</span>
                )}
              </dd>
            </dl>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <button
                className="btn p"
                style={{ gridColumn: 'span 2', height: 36 }}
                autoFocus
                onClick={() => {
                  onClose()
                  nav(`/hayvanlar/${m.animal.id}`)
                }}
              >
                Kaydı aç <span className="k">Enter</span>
              </button>
              <Link className="btn" to={`/muayene/yeni?animal=${m.animal.id}`} onClick={onClose}>Yeni muayene</Link>
              <Link className="btn" to={`/asilar/uygula?animal=${m.animal.id}`} onClick={onClose}>Aşı uygula</Link>
            </div>
          </>
        )}

        {v?.ok && q.data && !m && (
          <>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '10px 12px' }}>
              <div className="st s-gry" style={{ fontWeight: 600 }}>Kayıtlı değil</div>
              <div className="mut" style={{ marginTop: 4 }}>Bu çip klinikte kayıtlı değil. Başka klinikte kayıtlı olabilir; PETVET'ten sorgulanabilir.</div>
            </div>
            <Link
              to={`/kayit?chip=${v.value}`}
              className="btn p"
              style={{ height: 36 }}
              onClick={onClose}
            >
              Bu çiple yeni kayıt
            </Link>
          </>
        )}
      </div>
    </aside>
  )
}
