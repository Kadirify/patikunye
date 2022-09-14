// Sistem ayarları: S-109 Ağ ve cihazlar, S-113 Güncellemeler
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { SettingsLayout } from '../components/SettingsNav'
import { useToast } from '../ui'
import type { UpdateStatus } from '../../../preload/api'

const bridge = window.patikunye

interface NetStatus {
  host: boolean
  enabled?: boolean
  running?: boolean
  port?: number
  addresses?: string[]
  fingerprint?: string | null
  error?: string
}
interface Device {
  id: string
  name: string
  pairedAt: string
  lastSeenAt: string | null
  lastIp: string | null
  appVersion: string | null
  revokedAt: string | null
}

export function NetworkSettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [code, setCode] = useState<{ code: string; expiresAt: string; fingerprint: string } | null>(null)
  const [left, setLeft] = useState(0)
  const [st, setSt] = useState<Awaited<ReturnType<NonNullable<typeof bridge>['getStatus']>> | null>(null)
  useEffect(() => {
    bridge?.getStatus().then(setSt)
  }, [])

  const status = useQuery({ queryKey: ['net-status'], queryFn: () => api.get<NetStatus>('/api/network/status'), enabled: st?.mode !== 'client' })
  const devices = useQuery({ queryKey: ['net-devices'], queryFn: () => api.get<Device[]>('/api/network/devices'), enabled: !!status.data?.host, refetchInterval: 15_000 })

  useEffect(() => {
    if (!code) return
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(code.expiresAt) - Date.now()) / 1000))
      setLeft(s)
      if (s === 0) setCode(null)
    }, 1000)
    return () => clearInterval(t)
  }, [code])

  const enable = useMutation({
    mutationFn: (enabled: boolean) => api.post<NetStatus>('/api/network/enable', { enabled }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['net-status'] })
      if (s.error) toast(`Yerel ağ açılamadı: ${s.error}`, 'err')
      else toast(s.enabled ? 'Yerel ağ açıldı.' : 'Yerel ağ kapatıldı.')
    },
    onError: (e) => toast((e as Error).message, 'err'),
  })

  // İstemci bilgisayar: yalnızca bağlantı bilgisi
  if (st?.mode === 'client') {
    return (
      <SettingsLayout>
        <div className="page-head"><h1>Ağ ve cihazlar</h1></div>
        <section className="pnl" style={{ padding: 14 }}>
          <dl className="kv">
            <dt>Bu bilgisayar</dt>
            <dd>{st.client?.deviceName} · istemci</dd>
            <dt>Ana bilgisayar</dt>
            <dd>{st.client?.clinicName} · <span className="mono">{st.client?.hostUrl}</span></dd>
          </dl>
          <div style={{ marginTop: 12 }}>
            <button
              className="btn"
              onClick={() => {
                if (confirm('Bu bilgisayarın ana bilgisayar bağlantısı silinecek ve uygulama yeniden başlayacak. Devam edilsin mi?')) bridge?.net.forget()
              }}
            >
              Bağlantıyı unut
            </button>
          </div>
        </section>
      </SettingsLayout>
    )
  }

  const s = status.data
  return (
    <SettingsLayout>
      <div className="page-head">
        <h1>Ağ ve cihazlar</h1>
        <span className="mut">Muayene odası ve resepsiyon bilgisayarları bu bilgisayara yerel ağdan bağlanır.</span>
      </div>
      {s && !s.host && <div className="alert amb">Tarayıcı geliştirme modunda yerel ağ yönetilemez.</div>}
      {s?.host && (
        <section className="pnl">
          <div className="ph">
            <h2>Bu bilgisayar: ana bilgisayar</h2>
            <span className={`st ${s.running ? 's-ok' : 's-gry'}`}>{s.running ? 'Yerel ağ açık' : 'Yerel ağ kapalı'}</span>
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <dl className="kv">
              <dt>Adresler</dt>
              <dd className="mono">{s.addresses?.length ? s.addresses.map((a) => `${a}:${s.port}`).join(', ') : 'ağ bağlantısı yok'}</dd>
              <dt>Sertifika</dt>
              <dd className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{s.fingerprint ?? 'ilk açılışta üretilecek'}</dd>
            </dl>
            {s.error && <div className="alert">{s.error}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className={`btn${s.enabled ? '' : ' p'}`} disabled={enable.isPending} onClick={() => enable.mutate(!s.enabled)}>
                {s.enabled ? 'Yerel ağı kapat' : 'Yerel ağı aç'}
              </button>
              {s.running && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      setCode(await api.post('/api/network/pairing-code'))
                    } catch (e) {
                      toast((e as Error).message, 'err')
                    }
                  }}
                >
                  Yeni cihaz ekle
                </button>
              )}
            </div>
            <div className="mut" style={{ fontSize: 12 }}>
              İlk açılışta Windows güvenlik duvarı izin isteyebilir; "Özel ağlar" için izin verin. Veritabanı ağa açılmaz, yalnızca uygulama sunucusu açılır.
            </div>
          </div>
        </section>
      )}

      {code && (
        <section className="pnl" style={{ borderColor: 'var(--accent)' }}>
          <div className="ph"><h2>Yeni cihaz eşleştirme</h2><span className="mono mut">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span></div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>Diğer bilgisayarda PatiKünye kurulumunda "Bu bilgisayarı mevcut kliniğe bağla"yı seçin ve bu kodu girin:</div>
            <div className="mono" style={{ fontSize: 36, letterSpacing: '0.3em' }}>{code.code}</div>
            <div className="mut" style={{ fontSize: 12 }}>Diğer bilgisayarda gösterilen parmak izi bununla aynı olmalı:</div>
            <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', padding: 8, border: '1px solid var(--line)', background: 'var(--head)' }}>{code.fingerprint}</div>
          </div>
        </section>
      )}

      {s?.host && (
        <section className="pnl">
          <div className="ph"><h2>Bağlı cihazlar</h2></div>
          <table>
            <thead><tr><th>Ad</th><th>Son görülme</th><th>IP</th><th>Eşleşme</th><th></th></tr></thead>
            <tbody>
              {devices.data?.map((d) => (
                <tr key={d.id} style={d.revokedAt ? { opacity: 0.55 } : undefined}>
                  <td><strong>{d.name}</strong>{d.revokedAt && <span className="mut"> · bağlantı kesildi</span>}</td>
                  <td className="mono">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('tr-TR') : '—'}</td>
                  <td className="mono">{d.lastIp ?? ''}</td>
                  <td className="mono">{new Date(d.pairedAt).toLocaleDateString('tr-TR')}</td>
                  <td>
                    {!d.revokedAt && (
                      <button
                        className="btn sm"
                        onClick={async () => {
                          if (!confirm(`${d.name} bağlantısı kesilsin mi? Tekrar bağlanmak için yeniden eşleştirme gerekir.`)) return
                          await api.post(`/api/network/devices/${d.id}/revoke`)
                          qc.invalidateQueries({ queryKey: ['net-devices'] })
                        }}
                      >
                        Bağlantıyı kes
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices.data?.length === 0 && <div className="empty">Henüz bağlı cihaz yok.</div>}
        </section>
      )}
    </SettingsLayout>
  )
}

const UPD_TEXT: Record<UpdateStatus['state'], string> = {
  disabled: 'Güncelleme sunucusu tanımlı değil (geliştirme sürümü ya da istemci bilgisayar).',
  idle: 'Bekliyor',
  checking: 'Denetleniyor…',
  available: 'Yeni sürüm var',
  downloading: 'İndiriliyor',
  ready: 'Kurulmaya hazır',
  none: 'Uygulama güncel',
  error: 'Denetlenemedi',
}

export function UpdatesSettingsPage() {
  const toast = useToast()
  const [u, setU] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!bridge) return
    bridge.updates.status().then(setU)
    return bridge.updates.onStatus(setU)
  }, [])
  return (
    <SettingsLayout>
      <div className="page-head"><h1>Güncellemeler</h1></div>
      <section className="pnl" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <dl className="kv">
          <dt>Mevcut sürüm</dt>
          <dd className="mono">{bridge?.version || 'geliştirme'}</dd>
          <dt>Durum</dt>
          <dd>
            {u ? UPD_TEXT[u.state] : 'Bilinmiyor'}
            {u?.version && <span className="mono"> · v{u.version}</span>}
            {u?.state === 'downloading' && u.percent !== undefined && <span className="mono"> · %{u.percent}</span>}
            {u?.error && <div className="err">{u.error}</div>}
          </dd>
        </dl>
        {u && u.state !== 'disabled' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={u.state === 'checking' || u.state === 'downloading'} onClick={async () => setU(await bridge!.updates.check())}>
              Güncellemeleri denetle
            </button>
            {u.state === 'ready' && (
              <button
                className="btn p"
                disabled={busy}
                onClick={async () => {
                  if (!confirm('Önce yedek alınacak, ardından uygulama kapanıp güncellenecek. Diğer bilgisayarlardaki kullanıcıların işini kaydetmesini bekleyin. Devam edilsin mi?')) return
                  setBusy(true)
                  const r = await bridge!.updates.install()
                  setBusy(false)
                  if (!r.ok) toast(r.error ?? 'Güncelleme yapılamadı.', 'err')
                }}
              >
                {busy ? 'Yedek alınıyor…' : 'Yedek al ve güncelle'}
              </button>
            )}
          </div>
        )}
        <div className="mut">
          Güncellemeler otomatik denetlenir ve indirilir; kurulum uygulama kapatılırken yapılır. Kurulumdan önce otomatik yedek alınır. Yerel ağdaki istemci
          bilgisayarlar ana bilgisayarla aynı sürüme güncellenmelidir.
        </div>
      </section>
    </SettingsLayout>
  )
}
