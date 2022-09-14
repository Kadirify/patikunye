// Yedekleme modülü (G): S-108 Yedekleme ve S-111 Veritabanı ayar sayfaları
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useToast } from '../ui'
import { useCan, useSession } from '../session'
import { SettingsLayout } from '../components/SettingsNav'
import {
  BACKUP_PASSWORD_MIN,
  BACKUP_REASON_LABEL,
  RESTORE_CONFIRM_TEXT,
  type BackupListItem,
  type BackupReason,
  type BackupResultDto,
  type BackupSettingsDto,
  type BackupStatusDto,
  type BackupTargetInfo,
  type DbStatusDto,
  type RestoreResultDto,
  type TargetTestDto,
  type VerifyResultDto,
} from '@shared/backup'

// ---------------------------------------------------------------- biçimlendirme

const TZ = 'Europe/Istanbul'
function fmtDateTime(iso: string | null, long = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: long ? 'numeric' : '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`
}
function fmtBytes(n: number | null): string {
  if (n === null || n === undefined) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString('tr-TR', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${u[i]}`
}
function relHours(h: number | null): string {
  if (h === null) return ''
  if (h < 1) return 'az önce'
  if (h < 48) return `${Math.floor(h)} saat önce`
  return `${Math.floor(h / 24)} gün önce`
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '180px minmax(0,1fr)',
  gap: 12,
  alignItems: 'center',
  padding: '10px 12px',
  borderBottom: '1px solid var(--line-2)',
}
const smBtn: CSSProperties = { height: 24, fontSize: 12 }

function Row({ label, htmlFor, children, last }: { label: string; htmlFor?: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={{ ...rowStyle, ...(last ? { borderBottom: 0 } : {}) }}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>{children}</div>
    </div>
  )
}

/** Kenar çubuğu / durum çubuğu da kullanabilir: son yedek durumu metni */
export function backupStatusText(s: BackupStatusDto | undefined): { cls: string; text: string } {
  if (!s) return { cls: 's-gry', text: 'Yedek durumu yükleniyor…' }
  if (s.running) return { cls: 's-blu', text: 'Yedek alınıyor…' }
  if (!s.passwordSet) return { cls: 's-red', text: 'Yedek parolası belirlenmemiş' }
  if (!s.lastSuccessAt) return { cls: 's-red', text: 'Henüz yedek alınmadı' }
  const cls = s.state === 'ok' ? 's-ok' : s.state === 'warn' ? 's-amb' : 's-red'
  return { cls, text: `Son yedek ${fmtDateTime(s.lastSuccessAt)} · ${relHours(s.hoursAgo)}${s.lastError ? ' · son deneme başarısız' : ''}` }
}

// ---------------------------------------------------------------- S-108

export function BackupPage() {
  const can = useCan()
  const toast = useToast()
  const qc = useQueryClient()
  const admin = can('settings.manage')
  const status = useQuery({ queryKey: ['backup-status'], queryFn: () => api.get<BackupStatusDto>('/api/backup/status'), refetchInterval: 30_000 })
  const list = useQuery({ queryKey: ['backup-list'], queryFn: () => api.get<BackupListItem[]>('/api/backup/list'), enabled: can('backup.run') })
  const [restoreFor, setRestoreFor] = useState<string | null | undefined>(undefined) // undefined = kapalı, null = seçimsiz

  const run = useMutation({
    mutationFn: () => api.post<BackupResultDto>('/api/backup/run'),
    onSuccess: (r) => {
      const failed = r.targets.filter((t) => !t.ok)
      toast(failed.length ? `Yedek alındı; ${failed.length} hedefe yazılamadı.` : `Yedek alındı: ${r.rowsTotal.toLocaleString('tr-TR')} satır, ${fmtBytes(r.size)}.`, failed.length ? 'err' : 'ok')
      qc.invalidateQueries()
    },
    onError: (e) => {
      toast(errMsg(e), 'err')
      qc.invalidateQueries()
    },
  })

  if (!can('backup.run'))
    return (
      <SettingsLayout>
        <div className="alert">Bu sayfa için yetkiniz yok.</div>
      </SettingsLayout>
    )

  const st = backupStatusText(status.data)
  return (
    <SettingsLayout>
      <div className="page-head">
        <h1>Yedekleme</h1>
        <span className={`st ${st.cls}`}>{st.text}</span>
        <div className="right">
          {can('backup.restore') && (
            <button type="button" className="btn" onClick={() => setRestoreFor(null)}>
              Geri yükle…
            </button>
          )}
          <button type="button" className="btn p" disabled={run.isPending || status.data?.running} onClick={() => run.mutate()}>
            {run.isPending ? 'Yedek alınıyor…' : 'Şimdi yedek al'}
          </button>
        </div>
      </div>
      {status.data?.lastError && (
        <div className="alert">
          Son yedekleme denemesi başarısız ({fmtDateTime(status.data.lastErrorAt)}): {status.data.lastError}
        </div>
      )}
      {status.data && !status.data.passwordSet && (
        <div className="alert amb">Yedek parolası belirlenmeden otomatik yedek alınamaz. Aşağıdan parola belirleyin (önerilen: kurtarma kodu).</div>
      )}

      {admin && <TargetsPanel />}
      {admin && <SchedulePanel />}
      <HistoryPanel items={list.data} loading={list.isLoading} error={list.error} onRestore={(id) => setRestoreFor(id)} canRestore={can('backup.restore')} />

      {restoreFor !== undefined && <RestoreDialog initialId={restoreFor} items={list.data ?? []} onClose={() => setRestoreFor(undefined)} />}
    </SettingsLayout>
  )
}

function TargetsPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['backup-targets'], queryFn: () => api.get<BackupTargetInfo[]>('/api/backup/targets') })
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [test, setTest] = useState<TargetTestDto | null>(null)
  const [err, setErr] = useState('')

  const doTest = useMutation({
    mutationFn: () => api.post<TargetTestDto>('/api/backup/targets/test', { path }),
    onSuccess: (r) => {
      setTest(r)
      setErr('')
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const add = useMutation({
    mutationFn: () => api.post<TargetTestDto>('/api/backup/targets', { path }),
    onSuccess: () => {
      toast('Hedef eklendi.')
      setAdding(false)
      setPath('')
      setTest(null)
      qc.invalidateQueries()
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const remove = useMutation({
    mutationFn: (p: string) => api.post('/api/backup/targets/remove', { path: p }),
    onSuccess: () => {
      toast('Hedef kaldırıldı.')
      qc.invalidateQueries()
    },
    onError: (e) => toast(errMsg(e), 'err'),
  })

  return (
    <section className="pnl">
      <div className="ph">
        <h2>Hedefler</h2>
        <button type="button" className="btn" style={smBtn} onClick={() => setAdding((x) => !x)}>
          + Hedef ekle
        </button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Konum</th>
              <th>Tür</th>
              <th>Boş alan</th>
              <th>Son yedek</th>
              <th>Durum</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((t) => (
              <tr key={t.path}>
                <td className="mono">{t.path}</td>
                <td>{t.kind}</td>
                <td className="mono">{fmtBytes(t.freeBytes)}</td>
                <td className="mono">{fmtDateTime(t.lastOkAt)}</td>
                <td>
                  {t.lastError && !t.lastOkAt ? (
                    <span className="st s-red">{t.lastError}</span>
                  ) : !t.exists && t.lastOkAt ? (
                    <span className="st s-red">Ulaşılamıyor (USB takılı mı?)</span>
                  ) : t.sameDisk ? (
                    <span className="st s-amb">Uyarı · sistem diskiyle aynı</span>
                  ) : t.lastOkAt ? (
                    <span className="st s-ok">Tamam</span>
                  ) : (
                    <span className="st s-gry">Henüz yedek yok</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {!t.isDefault && (
                    <button
                      type="button"
                      className="btn"
                      style={smBtn}
                      aria-label={`${t.path} hedefini kaldır`}
                      onClick={() => window.confirm(`${t.path} hedefi kaldırılsın mı? Klasördeki yedek dosyaları silinmez.`) && remove.mutate(t.path)}
                    >
                      Kaldır
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.isError && <div className="alert" style={{ margin: 12 }}>{errMsg(q.error)}</div>}
      </div>
      {q.data?.some((t) => t.isDefault) && (
        <div className="mut" style={{ padding: '8px 12px', fontSize: 12 }}>
          Hedef eklenmediği için yedekler veri klasörüne yazılıyor. Disk bozulursa yedek de gider — harici USB disk ya da ağ klasörü ekleyin.
        </div>
      )}
      {adding && (
        <form
          style={{ padding: 12, borderTop: '1px solid var(--line-2)', display: 'flex', flexDirection: 'column', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor="bk-target" style={{ fontSize: 12 }}>
              Klasör yolu
            </label>
            <input
              id="bk-target"
              className="inp mono"
              style={{ flex: '1 1 320px', width: 'auto' }}
              placeholder="E:\PatiKunye Yedek  ya da  \\NAS\klinik\patikunye"
              value={path}
              onChange={(e) => {
                setPath(e.target.value)
                setTest(null)
              }}
              onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
              autoFocus
            />
            <button type="button" className="btn" disabled={!path.trim() || doTest.isPending} onClick={() => doTest.mutate()}>
              Yazmayı dene
            </button>
            <button type="submit" className="btn p" disabled={!path.trim() || add.isPending}>
              Ekle
            </button>
          </div>
          {test && (
            <span className={`st ${!test.writable ? 's-red' : test.sameDisk ? 's-amb' : 's-ok'}`}>
              {!test.writable
                ? `Yazılamıyor: ${test.error}`
                : `Yazılabilir · ${test.kind} · boş ${fmtBytes(test.freeBytes)}${test.sameDisk ? ' · sistem diskiyle aynı (harici disk önerilir)' : ''}`}
            </span>
          )}
          {err && <span className="err">{err}</span>}
        </form>
      )}
    </section>
  )
}

function SchedulePanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const can = useCan()
  const q = useQuery({ queryKey: ['backup-settings'], queryFn: () => api.get<BackupSettingsDto>('/api/backup/settings') })
  const [f, setF] = useState<{ time: string; keepDaily: string; keepMonthly: string } | null>(null)
  const [err, setErr] = useState('')
  const [pwOpen, setPwOpen] = useState(false)

  useEffect(() => {
    if (q.data && !f) setF({ time: q.data.time, keepDaily: String(q.data.keepDaily), keepMonthly: String(q.data.keepMonthly) })
  }, [q.data, f])

  const save = useMutation({
    mutationFn: () => api.put('/api/backup/settings', { time: f!.time, keepDaily: Number(f!.keepDaily), keepMonthly: Number(f!.keepMonthly) }),
    onSuccess: () => {
      setErr('')
      toast('Yedek ayarları kaydedildi.')
      qc.invalidateQueries()
    },
    onError: (e) => setErr(errMsg(e)),
  })

  if (q.isError) return <div className="alert">{errMsg(q.error)}</div>
  if (!q.data || !f) return null
  const dirty = f.time !== q.data.time || f.keepDaily !== String(q.data.keepDaily) || f.keepMonthly !== String(q.data.keepMonthly)

  return (
    <section
      className="pnl"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (dirty) save.mutate()
        }
      }}
    >
      <div className="ph">
        <h2>Zamanlama ve saklama</h2>
        {dirty && (
          <button type="button" className="btn p" style={smBtn} disabled={save.isPending} onClick={() => save.mutate()}>
            Kaydet
          </button>
        )}
      </div>
      <Row label="Günlük yedek saati" htmlFor="bk-time">
        <input id="bk-time" className="inp mono" style={{ width: 80 }} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <span className="mut">Bilgisayar kapalıysa ilk açılışta alınır.</span>
      </Row>
      <Row label="Saklama" htmlFor="bk-daily">
        <input id="bk-daily" className="inp mono" style={{ width: 60 }} inputMode="numeric" value={f.keepDaily} onChange={(e) => setF({ ...f, keepDaily: e.target.value })} />
        <span>günlük</span>
        <input className="inp mono" style={{ width: 60 }} inputMode="numeric" aria-label="Aylık yedek sayısı" value={f.keepMonthly} onChange={(e) => setF({ ...f, keepMonthly: e.target.value })} />
        <span>aylık</span>
      </Row>
      {err && <div className="err" style={{ padding: '4px 12px' }}>{err}</div>}
      <Row label="Güncelleme öncesi">
        <span className="ck">
          <input type="checkbox" checked readOnly disabled aria-label="Güncelleme öncesi yedek" />
          Her güncellemeden ve veritabanı değişikliğinden önce yedek alınır
        </span>
      </Row>
      <Row label="Yedek şifresi">
        <span className="mono">{q.data.passwordSet ? '••••••••••••' : <span className="s-red">Belirlenmedi</span>}</span>
        {can('backup.restore') && (
          <button type="button" className="btn" style={{ height: 26, fontSize: 12 }} onClick={() => setPwOpen((x) => !x)}>
            {q.data.passwordSet ? 'Değiştir…' : 'Belirle…'}
          </button>
        )}
        <span className="mut" style={{ fontSize: 12 }}>
          Şifre olmadan yedek açılamaz. Kurtarma kodunu saklayın.
        </span>
      </Row>
      {pwOpen && <PasswordForm passwordSet={q.data.passwordSet} onDone={() => setPwOpen(false)} />}
      <Row label="Bulut yedek" last>
        <span className="mut">Sonraki sürümde (Türkiye'deki sunucuya şifreli).</span>
      </Row>
    </section>
  )
}

function PasswordForm({ passwordSet, onDone }: { passwordSet: boolean; onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const m = useMutation({
    mutationFn: () => api.post('/api/backup/password', { newPassword: pw, currentPassword: passwordSet ? cur : undefined }),
    onSuccess: () => {
      toast(passwordSet ? 'Yedek parolası değiştirildi. Eski yedekler eski parolayla açılır.' : 'Yedek parolası belirlendi.')
      qc.invalidateQueries()
      onDone()
    },
    onError: (e) => setErr(errMsg(e)),
  })
  return (
    <form
      style={{ ...rowStyle, alignItems: 'start' }}
      onSubmit={(e) => {
        e.preventDefault()
        if (pw.length < BACKUP_PASSWORD_MIN) return setErr(`En az ${BACKUP_PASSWORD_MIN} karakter olmalı.`)
        if (pw !== pw2) return setErr('Parolalar aynı değil.')
        setErr('')
        m.mutate()
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <span />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {passwordSet && (
          <div className="f" style={{ width: 200 }}>
            <label htmlFor="bk-pw-cur">Mevcut yedek parolası</label>
            <input id="bk-pw-cur" type="password" className="inp" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="off" />
          </div>
        )}
        <div className="f" style={{ width: 200 }}>
          <label htmlFor="bk-pw-new">Yeni parola</label>
          <input id="bk-pw-new" type="password" className="inp" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="f" style={{ width: 200 }}>
          <label htmlFor="bk-pw-new2">Yeni parola (tekrar)</label>
          <input id="bk-pw-new2" type="password" className="inp" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </div>
        <button type="submit" className="btn p" disabled={m.isPending}>
          Kaydet
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Vazgeç
        </button>
        {err && <span className="err" style={{ width: '100%' }}>{err}</span>}
      </div>
    </form>
  )
}

function targetSummary(t: BackupListItem['targets']): string {
  if (!t.length) return '—'
  return t.map((x) => (x.ok ? x.path : `${x.path} ✗`)).join(' + ')
}

function HistoryPanel({
  items,
  loading,
  error,
  onRestore,
  canRestore,
}: {
  items: BackupListItem[] | undefined
  loading: boolean
  error: unknown
  onRestore: (id: string) => void
  canRestore: boolean
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const verify = useMutation({
    mutationFn: (id: string) => api.post<VerifyResultDto>('/api/backup/verify', { backupId: id }),
    onSuccess: (r) => {
      toast(r.summary)
      qc.invalidateQueries({ queryKey: ['backup-list'] })
    },
    onError: (e) => {
      toast(errMsg(e), 'err')
      qc.invalidateQueries({ queryKey: ['backup-list'] })
    },
  })
  return (
    <section className="pnl">
      <div className="ph">
        <h2>Son yedekler</h2>
        <span className="mut" style={{ fontSize: 12 }}>
          PostgreSQL · uygulama yedeği (.pkb) · AES-256 şifreli
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Neden</th>
              <th>Boyut</th>
              <th>Hedef</th>
              <th>Doğrulama</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items?.map((b) => {
              const failedSome = b.targets.some((t) => !t.ok)
              return (
                <tr key={b.id}>
                  <td className="mono">{fmtDateTime(b.startedAt)}</td>
                  <td>{BACKUP_REASON_LABEL[b.reason as BackupReason] ?? b.reason}</td>
                  <td className="mono">{fmtBytes(b.size)}</td>
                  <td className="mono" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.targets.map((t) => `${t.path}: ${t.ok ? 'tamam' : t.error}`).join('\n')}>
                    {targetSummary(b.targets)}
                  </td>
                  <td>
                    {b.error ? (
                      <span className="st s-red" title={b.error}>
                        Başarısız: {b.error.length > 60 ? b.error.slice(0, 60) + '…' : b.error}
                      </span>
                    ) : !b.finishedAt ? (
                      <span className="st s-blu">Sürüyor…</span>
                    ) : b.verifyOk === true ? (
                      <span className="st s-ok" title={fmtDateTime(b.verifiedAt, true)}>
                        {b.verifyResult ?? 'Doğrulandı'}
                      </span>
                    ) : b.verifyOk === false ? (
                      <span className="st s-red">{b.verifyResult ?? 'Doğrulanamadı'}</span>
                    ) : (
                      <span className="st s-gry">Doğrulanmadı</span>
                    )}
                    {failedSome && !b.error && <span className="st s-amb" style={{ marginLeft: 8 }}>Bazı hedeflere yazılamadı</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!b.error && b.finishedAt && (
                      <>
                        <button type="button" className="btn" style={smBtn} disabled={verify.isPending} onClick={() => verify.mutate(b.id)}>
                          {verify.isPending && verify.variables === b.id ? 'Doğrulanıyor…' : 'Doğrula'}
                        </button>{' '}
                        {canRestore && (
                          <button type="button" className="btn" style={smBtn} onClick={() => onRestore(b.id)}>
                            Geri yükle…
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {loading && <div className="empty">Yükleniyor…</div>}
        {items?.length === 0 && <div className="empty">Henüz yedek alınmadı. "Şimdi yedek al" ile ilk yedeği alın.</div>}
        {!!error && <div className="alert" style={{ margin: 12 }}>{errMsg(error)}</div>}
      </div>
    </section>
  )
}

function RestoreDialog({ initialId, items, onClose }: { initialId: string | null; items: BackupListItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const toast = useToast()
  const { signOut } = useSession()
  const usable = items.filter((b) => !b.error && b.finishedAt)
  const [source, setSource] = useState<'list' | 'path'>(usable.length ? 'list' : 'path')
  const [backupId, setBackupId] = useState(initialId ?? usable[0]?.id ?? '')
  const [path, setPath] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [err, setErr] = useState('')
  const [checked, setChecked] = useState<VerifyResultDto | null>(null)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

  const body = () => (source === 'list' ? { backupId } : { path: path.trim() })
  const check = useMutation({
    mutationFn: () => api.post<VerifyResultDto>('/api/backup/verify', { ...body(), password }),
    onSuccess: (r) => {
      setChecked(r)
      setErr('')
    },
    onError: (e) => {
      setChecked(null)
      setErr(errMsg(e))
    },
  })
  const restore = useMutation({
    mutationFn: () => api.post<RestoreResultDto>('/api/backup/restore', { ...body(), password, confirm, adminPassword }),
    onSuccess: async (r) => {
      toast(`Geri yükleme tamamlandı: ${r.rowsTotal.toLocaleString('tr-TR')} satır, ${r.files} dosya. Lütfen yeniden giriş yapın.`)
      onClose()
      // Kullanıcılar da geri yüklendiği için oturum yenilenmeli
      await signOut()
    },
    onError: (e) => setErr(errMsg(e)),
  })

  const ready = (source === 'list' ? !!backupId : !!path.trim()) && !!password && confirm.trim() === RESTORE_CONFIRM_TEXT && !!adminPassword

  return (
    <dialog
      ref={ref}
      aria-labelledby="restore-title"
      onClose={onClose}
      onCancel={(e) => {
        if (restore.isPending) e.preventDefault()
      }}
      style={{ border: '1px solid var(--line)', borderRadius: 3, padding: 0, width: 'min(640px, 94vw)', background: 'var(--panel)', color: 'var(--ink)' }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) restore.mutate()
        }}
      >
        <div className="ph">
          <h2 id="restore-title">Yedekten geri yükle</h2>
          <button type="button" className="btn" style={smBtn} aria-label="Kapat" disabled={restore.isPending} onClick={onClose}>
            Kapat
          </button>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="alert amb">
            Mevcut <strong>tüm veriler</strong> seçilen yedekteki hâliyle değiştirilecek. İşlemden önce mevcut verinin otomatik yedeği alınır. Geri yükleme
            sırasında diğer bilgisayarlarda kayıt yapılmamalı.
          </div>
          <div className="rad" role="radiogroup" aria-label="Yedek kaynağı">
            <label>
              <input type="radio" name="src" checked={source === 'list'} disabled={!usable.length} onChange={() => setSource('list')} /> Yedek listesinden
            </label>
            <label>
              <input type="radio" name="src" checked={source === 'path'} onChange={() => setSource('path')} /> Dosya yolu gir
            </label>
          </div>
          {source === 'list' ? (
            <div className="f">
              <label htmlFor="rs-id">Yedek</label>
              <select
                id="rs-id"
                className="inp"
                value={backupId}
                onChange={(e) => {
                  setBackupId(e.target.value)
                  setChecked(null)
                }}
              >
                {usable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {fmtDateTime(b.startedAt, true)} · {BACKUP_REASON_LABEL[b.reason as BackupReason] ?? b.reason} · {fmtBytes(b.size)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="f">
              <label htmlFor="rs-path">Yedek dosyası (.pkb)</label>
              <input
                id="rs-path"
                className="inp mono"
                placeholder="E:\PatiKunye Yedek\patikunye-20261027-030000-daily-ab12.pkb"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value)
                  setChecked(null)
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="f" style={{ flex: '1 1 240px' }}>
              <label htmlFor="rs-pw">Yedek parolası *</label>
              <input id="rs-pw" type="password" className="inp" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button type="button" className="btn" disabled={!password || check.isPending || (source === 'list' ? !backupId : !path.trim())} onClick={() => check.mutate()}>
              {check.isPending ? 'Denetleniyor…' : 'Önce doğrula'}
            </button>
          </div>
          {checked && (
            <span className="st s-ok">
              {fmtDateTime(checked.createdAt, true)} tarihli yedek (sürüm {checked.appVersion}) · {checked.summary}
            </span>
          )}
          <div className="f">
            <label htmlFor="rs-confirm">
              Onaylamak için <strong className="mono">{RESTORE_CONFIRM_TEXT}</strong> yazın *
            </label>
            <input id="rs-confirm" className="inp mono" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <div className="f">
            <label htmlFor="rs-admin">Yönetici parolanız *</label>
            <input id="rs-admin" type="password" className="inp" autoComplete="current-password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </div>
          {err && <div className="err">{err}</div>}
        </div>
        <div className="form-foot">
          <span className="mut" style={{ fontSize: 12 }}>
            İşlem bitince yeniden giriş yapmanız gerekir.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" disabled={restore.isPending} onClick={onClose}>
              Vazgeç
            </button>
            <button type="submit" className="btn p" disabled={!ready || restore.isPending} style={ready ? { background: 'var(--red)', borderColor: 'var(--red)' } : undefined}>
              {restore.isPending ? 'Geri yükleniyor…' : 'Geri yükle'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}

// ---------------------------------------------------------------- S-111

export function DatabaseSettingsPage() {
  const can = useCan()
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['db-status'], queryFn: () => api.get<DbStatusDto>('/api/db/status'), enabled: can('settings.manage') })
  const maint = useMutation({
    mutationFn: () => api.post<{ ms: number }>('/api/db/maintenance'),
    onSuccess: (r) => {
      toast(`Bakım tamamlandı (${(r.ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn).`)
      qc.invalidateQueries({ queryKey: ['db-status'] })
    },
    onError: (e) => toast(errMsg(e), 'err'),
  })
  const diag = useMutation({
    mutationFn: async () => {
      const url = await api.blobUrl('/api/db/diagnostics')
      const a = document.createElement('a')
      a.href = url
      a.download = `patikunye-tani-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    },
    onSuccess: () => toast('Tanı paketi indirildi (kişisel veri içermez).'),
    onError: (e) => toast(errMsg(e), 'err'),
  })

  if (!can('settings.manage'))
    return (
      <SettingsLayout>
        <div className="alert">Bu sayfa için yetkiniz yok.</div>
      </SettingsLayout>
    )
  const d = q.data
  return (
    <SettingsLayout>
      <div className="page-head">
        <h1>Veritabanı</h1>
        {d && <span className="st s-ok">Çalışıyor</span>}
        {q.isError && <span className="st s-red">Ulaşılamıyor</span>}
        <div className="right">
          <button type="button" className="btn" disabled={diag.isPending} onClick={() => diag.mutate()}>
            Tanı paketi
          </button>
          <button type="button" className="btn p" disabled={maint.isPending} onClick={() => maint.mutate()}>
            {maint.isPending ? 'Bakım sürüyor…' : 'Bakım çalıştır'}
          </button>
        </div>
      </div>
      {q.isError && <div className="alert">{errMsg(q.error)}</div>}
      {q.isLoading && <div className="mut">Yükleniyor…</div>}
      {d && (
        <>
          <section className="pnl">
            <div className="ph">
              <h2>Durum</h2>
            </div>
            <Row label="Sürüm">
              <span className="mono">PostgreSQL {d.version}</span>
            </Row>
            <Row label="Port">
              <span className="mono">{d.port ?? '—'}</span>
              <span className="mut">yalnızca bu bilgisayardan (127.0.0.1)</span>
            </Row>
            <Row label="Veri klasörü">
              <span className="mono">{d.dataDir}</span>
            </Row>
            <Row label="Boyut">
              <span className="mono">{fmtBytes(d.sizeBytes)}</span>
            </Row>
            <Row label="Son vakum / analiz" last>
              <span className="mono">{fmtDateTime(d.lastMaintenanceAt, true)}</span>
              <span className="mut">Bakım (VACUUM ANALYZE) birkaç saniye sürebilir; bu sırada çalışmaya devam edebilirsiniz.</span>
            </Row>
          </section>

          <section className="pnl">
            <div className="ph">
              <h2>Tablolar</h2>
              <span className="mut" style={{ fontSize: 12 }}>
                {d.tables.length} tablo
              </span>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tablo</th>
                    <th style={{ textAlign: 'right' }}>Satır</th>
                    <th style={{ textAlign: 'right' }}>Boyut</th>
                    <th>Son vakum</th>
                    <th>Son analiz</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tables.map((t) => (
                    <tr key={t.name}>
                      <td className="mono">{t.name}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {t.rows.toLocaleString('tr-TR')}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {fmtBytes(t.totalBytes)}
                      </td>
                      <td className="mono">{fmtDateTime(t.lastVacuum)}</td>
                      <td className="mono">{fmtDateTime(t.lastAnalyze)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="pnl">
            <div className="ph">
              <h2>Migration geçmişi</h2>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ad</th>
                    <th>Tür</th>
                    <th>Uygulandı</th>
                  </tr>
                </thead>
                <tbody>
                  {d.migrations.map((m) => (
                    <tr key={m.kind + m.name}>
                      <td className="mono">{m.name}</td>
                      <td>{m.kind === 'drizzle' ? 'Temel şema' : 'Modül'}</td>
                      <td className="mono">{fmtDateTime(m.appliedAt, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.migrations.length && <div className="empty">Migration kaydı yok.</div>}
            </div>
          </section>
        </>
      )}
    </SettingsLayout>
  )
}
