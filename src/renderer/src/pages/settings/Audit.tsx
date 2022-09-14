// S-96 Denetim kaydı: filtreli liste, ayrıntı (maskeli fark), hash zinciri doğrulama
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, qs } from '../../api'
import { useCan } from '../../session'
import { AUDIT_ACTION_LABEL, type AuditDetailDto, type AuditListDto, type AuditVerifyDto } from '@shared/admin'
import { Modal, NoAccess, errText, fmtDateTime } from './common'

interface Filters {
  userId: string
  from: string
  to: string
  action: string
  entity: string
}

export function AuditPage() {
  const can = useCan()
  const [f, setF] = useState<Filters>({ userId: '', from: '', to: '', action: '', entity: '' })
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<number | null>(null)
  const enabled = can('audit.view')
  const meta = useQuery({
    queryKey: ['audit-meta'],
    queryFn: () => api.get<{ entities: string[]; actions: string[]; users: { id: string; fullName: string }[] }>('/api/audit/meta'),
    enabled,
  })
  const list = useQuery({ queryKey: ['audit', f, page], queryFn: () => api.get<AuditListDto>('/api/audit' + qs({ ...f, page })), enabled })
  const verify = useMutation({ mutationFn: () => api.post<AuditVerifyDto>('/api/audit/verify') })

  if (!enabled) return <NoAccess />
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setPage(1)
    setF({ ...f, [k]: e.target.value })
  }
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <div className="page-head">
        <h1>Denetim kaydı</h1>
        <span className="mut">Değiştirilemez kayıt · her satır öncekinin özetini içerir</span>
        <div className="right"><button className="btn" onClick={() => verify.mutate()} disabled={verify.isPending}>{verify.isPending ? 'Doğrulanıyor…' : 'Zinciri doğrula'}</button></div>
      </div>
      {verify.data &&
        (verify.data.ok ? (
          <div className="alert ok" role="status">Zincir sağlam: {verify.data.checked} satır kontrol edildi.</div>
        ) : (
          <div className="alert" role="alert">
            <strong>Zincir bozuk: {verify.data.broken.length} sorunlu satır</strong> ({verify.data.checked} satır kontrol edildi)
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {verify.data.broken.slice(0, 20).map((b) => (
                <li key={`${b.id}-${b.reason}`}>
                  <button className="btn sm" onClick={() => setDetail(b.id)}>#{b.id}</button> {b.reason}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {verify.isError && <div className="alert">{errText(verify.error)}</div>}

      <section className="pnl">
        <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, borderBottom: '1px solid var(--line-2)' }}>
          <select className="inp" value={f.userId} onChange={set('userId')} aria-label="Kullanıcı">
            <option value="">Tüm kullanıcılar</option>
            {meta.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </select>
          <input type="date" className="inp mono" value={f.from} onChange={set('from')} aria-label="Başlangıç tarihi" />
          <input type="date" className="inp mono" value={f.to} onChange={set('to')} aria-label="Bitiş tarihi" />
          <select className="inp" value={f.action} onChange={set('action')} aria-label="İşlem">
            <option value="">Tüm işlemler</option>
            {meta.data?.actions.map((a) => <option key={a} value={a}>{AUDIT_ACTION_LABEL[a] ?? a}</option>)}
          </select>
          <select className="inp" value={f.entity} onChange={set('entity')} aria-label="Kayıt türü">
            <option value="">Tüm kayıt türleri</option>
            {meta.data?.entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Zaman</th><th>Kullanıcı</th><th>İşlem</th><th>Kayıt</th><th>Özet</th></tr>
            </thead>
            <tbody>
              {list.data?.rows.map((r) => (
                <tr key={r.id} className={`click${r.action === 'login_failed' ? ' hot' : ''}`} onClick={() => setDetail(r.id)}>
                  <td className="mono mut">{r.id}</td>
                  <td className="mono">{fmtDateTime(r.at)}</td>
                  <td>{r.userName ?? <span className="mut">—</span>}</td>
                  <td>{AUDIT_ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.entity}{r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}</td>
                  <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.rows.length === 0 && <div className="empty">Bu filtrede kayıt yok.</div>}
          {list.isError && <div className="alert" style={{ margin: 12 }}>{errText(list.error)}</div>}
        </div>
        <div className="tfoot" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mut">{list.data ? `${list.data.total} kayıt` : ''}</span>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Önceki</button>
          <span className="mono">{page} / {pages}</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Sonraki ›</button>
        </div>
      </section>
      {detail !== null && <AuditDetail id={detail} onClose={() => setDetail(null)} />}
    </>
  )
}

function AuditDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['audit-row', id], queryFn: () => api.get<AuditDetailDto>(`/api/audit/${id}`) })
  const d = q.data
  return (
    <Modal title={`Denetim kaydı #${id}`} onClose={onClose} width={680}>
      {!d ? (
        <div className="empty">{q.isError ? errText(q.error) : 'Yükleniyor…'}</div>
      ) : (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Zaman</dt><dd className="mono">{fmtDateTime(d.at)}</dd>
            <dt>Kullanıcı</dt><dd>{d.userName ?? '—'}</dd>
            <dt>İşlem</dt><dd>{AUDIT_ACTION_LABEL[d.action] ?? d.action}</dd>
            <dt>Kayıt</dt><dd className="mono">{d.entity}{d.entityId ? ` · ${d.entityId}` : ''}</dd>
            <dt>Özet</dt><dd>{d.summary ?? '—'}</dd>
          </dl>
          {d.diff !== null && d.diff !== undefined && <DiffView diff={d.diff} />}
          <div className="mono mut" style={{ fontSize: 11, wordBreak: 'break-all' }}>
            önceki özet: {d.prevHash ?? '—'}<br />özet: {d.hash}
          </div>
          <div className="mut" style={{ fontSize: 12 }}>Hassas alanlar (TCKN, telefon, e-posta, parola) maskeli gösterilir.</div>
        </div>
      )}
    </Modal>
  )
}

/** { alan: { from, to } } biçimindeki farkları tablo, diğerlerini JSON olarak gösterir */
function DiffView({ diff }: { diff: unknown }) {
  const entries = diff && typeof diff === 'object' && !Array.isArray(diff) ? Object.entries(diff as Record<string, unknown>) : []
  const isFromTo = entries.length > 0 && entries.every(([, v]) => v && typeof v === 'object' && ('from' in (v as object) || 'to' in (v as object)))
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? <span className="mut">—</span> : typeof v === 'object' ? <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(v, null, 1)}</pre> : String(v))
  if (!isFromTo) return <pre className="mono" style={{ margin: 0, padding: 8, background: 'var(--head)', border: '1px solid var(--line-2)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(diff, null, 2)}</pre>
  return (
    <table>
      <thead><tr><th>Alan</th><th>Eski</th><th>Yeni</th></tr></thead>
      <tbody>
        {entries.map(([k, v]) => {
          const x = v as { from?: unknown; to?: unknown }
          return <tr key={k}><td className="mono">{k}</td><td>{show(x.from)}</td><td>{show(x.to)}</td></tr>
        })}
      </tbody>
    </table>
  )
}
