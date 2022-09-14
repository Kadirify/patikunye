// Açılış: S-01 Kurulum sihirbazı, başlatma ekranı ve S-02 sistem hatası ekranı.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, setApiBase, setToken } from '../api'
import { TitleBar } from '../Layout'
import { Field, Logo } from '../ui'
import { validateChip, formatChip } from '@shared/chip'
import type { SessionDto } from '@shared/api-types'
import type { BackendStatus, DiscoveredHost, HelloResult } from '../../../preload/api'

const bridge = window.patikunye

/* ───────────── Açılış kapısı ───────────── */

/**
 * Electron'da: veritabanı durumuna göre sihirbaz / başlatılıyor / hata / uygulama.
 * Tarayıcı geliştirme modunda: API sabit adreste; kurulum gerekiyorsa sihirbaz.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<BackendStatus | null>(null)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [wizardDone, setWizardDone] = useState(false)

  useEffect(() => {
    if (!bridge) {
      setSt({ state: 'ready', firstRun: false, steps: [], dataRoot: '', logFile: '', mode: 'host' })
      return
    }
    bridge.getStatus().then(setSt)
    return bridge.onStatus(setSt)
  }, [])

  useEffect(() => {
    if (st?.state !== 'ready') return
    if (st.apiBase) setApiBase(st.apiBase)
    api
      .get<{ needsSetup: boolean }>('/api/setup/status')
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => setNeedsSetup(null))
  }, [st?.state, st?.apiBase])

  if (!st) return <div className="app"><TitleBar /></div>
  // İlk açılış ya da kurulum yapılmamış veritabanı → sihirbaz (veritabanı adımını kendisi yürütür)
  if (!wizardDone && (st.firstRun || needsSetup)) return <SetupWizard status={st} onDone={() => setWizardDone(true)} />
  if (st.state === 'error') return <SystemError status={st} />
  if (st.state !== 'ready' || needsSetup === null) return <Starting status={st} />
  return <>{children}</>
}

function Starting({ status }: { status: BackendStatus }) {
  return (
    <div className="app">
      <TitleBar />
      <div className="center">
        <div className="pnl" style={{ padding: '24px 28px', width: 420, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Logo size={20} hole="#fff" />
            <strong>PatiKünye başlatılıyor…</strong>
          </div>
          <StepList status={status} compact />
        </div>
      </div>
    </div>
  )
}

/* S-02 Sistem hatası */
function SystemError({ status }: { status: BackendStatus }) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const portIssue = /port|bind|socket/i.test(status.error ?? '')
  const client = status.mode === 'client'
  return (
    <div className="app">
      <TitleBar />
      <div className="center">
        <div className="pnl" style={{ width: '100%', maxWidth: 640 }}>
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h1 style={{ fontSize: 18 }}>{client ? 'Ana bilgisayara bağlanılamadı' : 'Veritabanı başlatılamadı'}</h1>
            <p style={{ margin: 0 }}>
              {client
                ? `Bu bilgisayar ${status.client?.clinicName ?? ''} ana bilgisayarına (${status.client?.hostUrl ?? ''}) bağlı. Ana bilgisayar açık mı, PatiKünye çalışıyor mu ve aynı ağda mısınız?`
                : portIssue
                ? 'Windows veritabanının kullandığı ağ portunu açmaya izin vermedi. Genellikle tekrar denemek yeterlidir.'
                : 'Klinik verileri bu bilgisayardaki veritabanında duruyor ve veritabanı şu an çalışmıyor. Verileriniz silinmedi.'}
            </p>
            <StepList status={status} />
            <details>
              <summary className="mut" style={{ cursor: 'pointer' }}>Teknik ayrıntı</summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'var(--head)', border: '1px solid var(--line-2)', padding: 8 }}>{status.error}</pre>
              <div className="mut" style={{ fontSize: 12 }}>Kayıt dosyası: {status.logFile}</div>
            </details>
            {saved && <div className="alert ok">Tanı paketi kaydedildi: <span className="mono">{saved}</span></div>}
          </div>
          <div className="form-foot">
            <span className="mut" style={{ fontSize: 12 }}>Sorun sürerse tanı paketini destek ekibine gönderin. Kişisel veri içermez.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {client && (
                <button
                  className="btn"
                  onClick={() => {
                    if (confirm('Bu bilgisayarın ana bilgisayar bağlantısı silinecek ve kurulum baştan başlayacak. Devam edilsin mi?')) bridge?.net.forget()
                  }}
                >
                  Bağlantıyı unut
                </button>
              )}
              <button className="btn" onClick={() => bridge?.showLog()}>Kayıt dosyasını göster</button>
              <button className="btn" onClick={async () => setSaved(await bridge!.saveDiagnostics())}>Tanı paketini kaydet</button>
              <button
                className="btn p"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await bridge?.startBackend()
                  setBusy(false)
                }}
              >
                {busy ? 'Deneniyor…' : 'Tekrar dene'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StepList({ status, compact }: { status: BackendStatus; compact?: boolean }) {
  if (!status.steps.length) return <div className="mut">Hazırlanıyor…</div>
  return (
    <div>
      {status.steps.map((s) => (
        <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: compact ? '4px 0' : '7px 0', borderBottom: '1px solid var(--line-3)' }}>
          <span style={{ color: s.state === 'done' ? 'var(--ok)' : s.state === 'error' ? 'var(--red)' : 'var(--accent)' }} aria-hidden="true">
            {s.state === 'done' ? '✓' : s.state === 'error' ? '✗' : '…'}
          </span>
          <span>
            {s.state === 'start' ? <strong>{s.label}</strong> : s.label}
            {s.detail && s.state !== 'error' && <span className="mono mut" style={{ fontSize: 12 }}> · {s.detail}</span>}
            {s.state === 'error' && <div className="err">{s.detail}</div>}
          </span>
          <span className="mono mut" style={{ fontSize: 12 }}>{s.ms !== undefined && s.state === 'done' ? `${(s.ms / 1000).toFixed(1).replace('.', ',')} sn` : ''}</span>
        </div>
      ))}
    </div>
  )
}

/* ───────────── Kurulum sihirbazı (S-01) ───────────── */

const STEPS = [
  'Hoş geldiniz',
  'Kurulum türü',
  'Veritabanı',
  'Klinik bilgileri',
  'Yönetici hekim',
  'Yedekleme',
  'Disk şifreleme',
  'Çip okuyucu testi',
  'Mesajlaşma',
  'Hazır',
] as const

// Kurtarma kodu için Türkçe kelime listesi (256 kelime → 12 kelime ≈ 96 bit)
const WORDS = (
  'ada akşam alan anahtar arı armut aslan ayva badem bahar balık bulut çamur çay çiçek deniz dere dut elma erik fener fidan fil fındık ' +
  'gemi gece göl güneş güz hamak hasır havuz hurma ırmak ışık incir inci kalem kale kapı kar kartal kavak kayık kedi kekik kestane kiraz ' +
  'kum kuzu lale leylek limon mandal martı masa mavi mercan mısır nane nar nehir orman ova ördek papatya pamuk pınar portakal rüzgar saat ' +
  'sabah salkım sarı serçe sincap soğan su sümbül şeker şelale tahta taş tavşan tepe toprak tuz turna uçurtma umut üzüm vadi yağmur yaprak ' +
  'yaz yel yıldız yol yonca zeytin ağaç ateş bahçe balkon bardak bayrak beyaz bisiklet buğday cam ceviz defne demir dolap duman ekmek ' +
  'eldiven fasulye fırın gelincik gölge gümüş halı harman hediye heykel ılgın ipek kabak kaktüs kamış kanat kanyon karınca kaya kervan ' +
  'kese kibrit kilim kireç köprü kovan kule kumru lamba lavanta liman maden mantar marul mendil mermer mum nilüfer oduncu oya pancar pazar ' +
  'perde pırasa pide reçel sandal sepet sırt sofra sokak süt şemsiye şimşek tarla tencere testi tohum tokat turp tünel ufuk vapur yayla ' +
  'yelken yengeç yorgan yumurta zambak zil ardıç bakır boncuk çakıl çınar dalga dağ eğir fesleğen fincan gergef hanım ıhlamur iplik ' +
  'kadeh kanarya karanfil kasnak keklik kiler kozalak kumsal kurt lezzet lokum maydanoz menekşe misket nevruz olta otlak para papağan ' +
  'pelin pervane rakam ressam saray sedef sumak şahin tavuk tepsi tilki tırnak uskumru ülke yamaç yasemin yaşam yeşil yosun zümrüt'
)
  .split(/\s+/)
  .filter(Boolean)

function newRecoveryCode(): string {
  const r = new Uint32Array(12)
  crypto.getRandomValues(r)
  return Array.from(r, (x) => WORDS[x % WORDS.length]).join(' ')
}

interface WizardData {
  accepted: boolean
  mode: 'new' | 'join' | 'restore'
  clinic: { clinicName: string; city: string; district: string; phone: string; address: string }
  admin: { fullName: string; chamberRegNo: string; diplomaNo: string; username: string; password: string; password2: string; phone: string }
  recovery: string
  recoveryConfirmed: boolean
  session: SessionDto | null
  backupFolder: string
  backupTime: string
  bitlocker: 'on' | 'off' | 'unknown' | null
  readerGapMs: number | null
}

export function SetupWizard({ status, onDone }: { status: BackendStatus; onDone(): void }) {
  const [step, setStep] = useState(0)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [d, setD] = useState<WizardData>(() => ({
    accepted: false,
    mode: 'new',
    clinic: { clinicName: '', city: '', district: '', phone: '', address: '' },
    admin: { fullName: '', chamberRegNo: '', diplomaNo: '', username: '', password: '', password2: '', phone: '' },
    recovery: newRecoveryCode(),
    recoveryConfirmed: false,
    session: null,
    backupFolder: '',
    backupTime: '03:00',
    bitlocker: null,
    readerGapMs: null,
  }))
  const up = <K extends keyof WizardData>(k: K, v: WizardData[K]) => setD((x) => ({ ...x, [k]: v }))

  const dbReady = status.state === 'ready'
  const dbBusy = status.state === 'starting'

  // Veritabanı adımına gelince başlat (istemci kurulumunda veritabanı kurulmaz)
  useEffect(() => {
    if (step === 2 && d.mode === 'new' && bridge && status.state === 'idle') bridge.startBackend()
    if (dbReady && status.apiBase) setApiBase(status.apiBase)
  }, [step, status.state, status.apiBase, dbReady])

  useEffect(() => {
    if (step === 6 && d.bitlocker === null) {
      if (bridge) bridge.bitlockerStatus().then((b) => up('bitlocker', b))
      else up('bitlocker', 'unknown')
    }
  }, [step, d.bitlocker])

  function canNext(): string | null {
    switch (step) {
      case 0:
        return d.accepted ? null : 'Devam etmek için koşulları kabul edin.'
      case 1:
        return d.mode === 'restore' ? 'Bu seçenek kurulumdan sonra Ayarlar > Yedekleme\'den yapılır.' : null
      case 2:
        return dbReady ? null : 'Veritabanı hazırlanıyor.'
      case 3: {
        const c = d.clinic
        return c.clinicName.trim().length >= 2 && c.city.trim() && c.district.trim() ? null : 'Klinik adı, il ve ilçe gerekli.'
      }
      case 4:
        if (!d.session) return 'Yönetici hekim bilgilerini kaydedin.'
        return d.recoveryConfirmed ? null : 'Kurtarma kodunu bir yere yazdığınızı onaylayın.'
      default:
        return null
    }
  }

  async function createAdmin() {
    setErr('')
    const a = d.admin
    if (a.password !== a.password2) return setErr('Parolalar aynı değil.')
    setBusy(true)
    try {
      const s = await api.post<SessionDto>('/api/setup', {
        clinicName: d.clinic.clinicName,
        city: d.clinic.city,
        district: d.clinic.district,
        phone: d.clinic.phone,
        admin: { fullName: a.fullName, username: a.username, password: a.password, chamberRegNo: a.chamberRegNo },
      })
      setToken(s.token) // sonraki adımlar için oturum; arayüze geçiş "Başla" ile
      up('session', s)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function finish() {
    setErr('')
    setBusy(true)
    try {
      const res = await api.post<{ ok: boolean; firstBackup: { ok: boolean; error?: string } }>('/api/system/setup-complete', {
        recoveryCode: d.recovery,
        backup: { folder: d.backupFolder || null, time: d.backupTime },
        readerMaxGapMs: d.readerGapMs,
        address: d.clinic.address || null,
        diplomaNo: d.admin.diplomaNo || null,
      })
      if (!res.firstBackup.ok) {
        alert(`Kurulum tamamlandı, ancak ilk yedek alınamadı:\n${res.firstBackup.error ?? ''}\n\nAyarlar > Yedekleme'den yedek klasörünü kontrol edin.`)
      }
      // Oturum anahtarı zaten ayarlı; oturum bileşeni açılınca kullanıcıyı yükler
      setToken(d.session!.token)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const blocker = canNext()
  const isLast = step === STEPS.length - 1

  return (
    <div className="app">
      <TitleBar subtitle="Kurulum" />
      <div className="center">
        <div className="pnl" style={{ width: '100%', maxWidth: 920, minHeight: 560, display: 'flex', flexWrap: 'wrap' }}>
          <aside style={{ flex: '0 1 230px', background: '#f2f0eb', borderRight: '1px solid var(--line-2)', padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}>
              <Logo size={18} hole="#f2f0eb" />
              <strong>Kurulum</strong>
            </div>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  aria-current={i === step ? 'step' : undefined}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px minmax(0,1fr)',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 2,
                    border: i === step ? '1px solid var(--line)' : '1px solid transparent',
                    background: i === step ? '#fff' : undefined,
                    fontWeight: i === step ? 600 : 400,
                    color: i < step ? 'var(--muted)' : undefined,
                  }}
                >
                  <span className="mono mut" style={{ fontSize: 12 }}>{i < step ? '✓' : i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </aside>

          <section style={{ flex: '999 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
              {step === 0 && <Welcome d={d} up={up} />}
              {step === 1 && <InstallType d={d} up={up} />}
              {step === 2 && d.mode === 'join' && <JoinStep />}
              {step === 2 && d.mode === 'new' && <DatabaseStep status={status} />}
              {step === 3 && <ClinicStep d={d} up={up} />}
              {step === 4 && <AdminStep d={d} up={up} onCreate={createAdmin} busy={busy} />}
              {step === 5 && <BackupStep d={d} up={up} />}
              {step === 6 && <BitlockerStep state={d.bitlocker} />}
              {step === 7 && <ReaderStep onMeasured={(ms) => up('readerGapMs', ms)} />}
              {step === 8 && <MessagingStep />}
              {step === 9 && <DoneStep d={d} />}
            </div>
            <div className="form-foot" style={{ padding: '12px 28px' }}>
              <span className="err" role="alert">{err}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {bridge && <button className="btn" onClick={() => bridge.saveDiagnostics()}>Tanı bilgisini kaydet</button>}
                <button
                  className="btn"
                  // Yönetici oluşturulduktan sonra klinik bilgilerine dönülmez (Ayarlar > Klinik'ten düzenlenir)
                  disabled={step === 0 || dbBusy || (!!d.session && step <= 4)}
                  onClick={() => {
                    setErr('')
                    setStep((s) => s - 1)
                  }}
                >
                  Geri
                </button>
                {isLast ? (
                  <button className="btn p" disabled={busy} onClick={finish}>{busy ? 'Kaydediliyor…' : 'Başla'}</button>
                ) : (
                  <button
                    className="btn p"
                    disabled={!!blocker}
                    title={blocker ?? undefined}
                    onClick={() => {
                      setErr('')
                      setStep((s) => s + 1)
                    }}
                  >
                    {step === 7 || step === 8 ? 'Atla / İleri' : 'İleri'}
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

type StepProps = { d: WizardData; up: <K extends keyof WizardData>(k: K, v: WizardData[K]) => void }

function H({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 18 }}>{title}</h1>
      {sub && <p className="mut" style={{ margin: '4px 0 0' }}>{sub}</p>}
    </div>
  )
}

function Welcome({ d, up }: StepProps) {
  return (
    <>
      <H title="PatiKünye'ye hoş geldiniz" sub="Veteriner klinikleri için mikroçip, hayvan ve PETVET takibi." />
      <p style={{ margin: 0 }}>
        Klinik verileriniz bu bilgisayarda, uygulamayla birlikte kurulan bir veritabanında saklanır; buluta gönderilmez. Kurulum birkaç dakika sürer.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>Veritabanı bu bilgisayarda hazırlanacak.</li>
        <li>Klinik ve yönetici hekim bilgileri girilecek.</li>
        <li>Verilerin kaybolmaması için yedekleme klasörü seçilecek.</li>
      </ul>
      <div className="alert amb">
        Kayıtlarda T.C. kimlik numarası gibi kişisel veriler işlenir. Klinik, KVKK kapsamında veri sorumlusudur; hayvan sahiplerine aydınlatma metni verilmelidir.
      </div>
      <label className="ck">
        <input type="checkbox" checked={d.accepted} onChange={(e) => up('accepted', e.target.checked)} />
        Kullanım koşullarını ve KVKK bilgilendirmesini okudum, kabul ediyorum.
      </label>
    </>
  )
}

function InstallType({ d, up }: StepProps) {
  const opt = (v: WizardData['mode'], title: string, desc: string, disabled?: string) => (
    <label className={`u${d.mode === v ? ' on' : ''}`} style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="mode" checked={d.mode === v} disabled={!!disabled} onChange={() => up('mode', v)} style={{ accentColor: 'var(--accent)' }} />
        <strong>{title}</strong>
      </span>
      <span />
      <span className="mut" style={{ fontSize: 12, gridColumn: 'span 2' }}>{desc}{disabled && ` · ${disabled}`}</span>
    </label>
  )
  return (
    <>
      <H title="Kurulum türü" />
      <div role="radiogroup" aria-label="Kurulum türü" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {opt('new', 'Bu bilgisayar ana bilgisayar olsun', 'Yeni klinik. Veritabanı bu bilgisayarda tutulur; diğer bilgisayarlar buna bağlanır.')}
        {opt('join', 'Bu bilgisayarı mevcut kliniğe bağla', 'Yerel ağdaki ana bilgisayara bağlanır; veritabanı kurulmaz.', bridge ? undefined : 'yalnızca masaüstü uygulamasında')}
        {opt('restore', 'Yedekten geri yükle', 'Başka bilgisayardan taşıma. Kurulumdan sonra Ayarlar > Yedekleme > Geri yükle ile de yapılabilir.', 'kurulumdan sonra Ayarlar > Yedekleme')}
      </div>
    </>
  )
}

/* S-03 Bu bilgisayarı mevcut kliniğe bağla */
function JoinStep() {
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null)
  const [address, setAddress] = useState('')
  const [hi, setHi] = useState<HelloResult | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('Muayene Odası 1')
  const [fpOk, setFpOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const scan = () => {
    setHosts(null)
    bridge?.net.discover().then(setHosts)
  }
  useEffect(scan, [])

  async function connect(addr: string) {
    setErr('')
    setBusy(true)
    try {
      setHi(await bridge!.net.hello(addr))
      setFpOk(false)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function doPair() {
    setErr('')
    setBusy(true)
    try {
      const st = await bridge!.net.pair({ url: hi!.url, code, deviceName: name, fingerprint: hi!.fingerprint })
      if (st.state === 'error') setErr(st.error ?? 'Bağlanılamadı.')
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  if (!hi) {
    return (
      <>
        <H title="Ana bilgisayara bağlan" sub="Ana bilgisayarda Ayarlar > Ağ ve cihazlar'da yerel ağın açık olması gerekir." />
        <section className="pnl">
          <div className="ph">
            <h2>Yerel ağda bulunanlar</h2>
            <button className="btn sm" onClick={scan}>Yeniden ara</button>
          </div>
          {hosts === null && <div className="empty">Aranıyor…</div>}
          {hosts?.length === 0 && <div className="empty">Bulunamadı. Windows güvenlik duvarı mDNS'i engelliyor olabilir; adresi elle girin.</div>}
          {hosts?.map((h) => (
            <button key={h.url} className="list-row" style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line-3)', background: '#fff', textAlign: 'left', cursor: 'pointer' }} onClick={() => connect(h.url)} disabled={busy}>
              <span><strong>{h.clinic || h.name}</strong> <span className="mut">· {h.name}</span></span>
              <span className="mono mut">{h.url.replace('https://', '')}</span>
            </button>
          ))}
        </section>
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault()
            connect(address)
          }}
        >
          <Field label="ya da adres (IP:port)" htmlFor="ha" style={{ flex: 1 }}>
            <input id="ha" className="inp mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:47900" />
          </Field>
          <button className="btn" disabled={busy || !address.trim()}>{busy ? 'Bağlanılıyor…' : 'Bağlan'}</button>
        </form>
        {err && <div className="alert">{err}</div>}
      </>
    )
  }

  return (
    <>
      <H title={`${hi.clinicName} — eşleştirme`} sub={`Ana bilgisayar: ${hi.url.replace('https://', '')} · sürüm ${hi.version}`} />
      <div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 4 }}>Sertifika parmak izi</div>
        <div className="mono" style={{ padding: 10, border: '1px solid var(--line)', background: 'var(--head)', fontSize: 12, wordBreak: 'break-all' }}>{hi.fingerprint}</div>
      </div>
      <label className="ck">
        <input type="checkbox" checked={fpOk} onChange={(e) => setFpOk(e.target.checked)} />
        Ana bilgisayardaki "Yeni cihaz ekle" ekranında gösterilen parmak iziyle aynı.
      </label>
      <div className="g4" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <Field label="Eşleştirme kodu (6 hane)" htmlFor="pc">
          <input id="pc" className="inp mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 18, letterSpacing: '0.3em' }} />
        </Field>
        <Field label="Bu bilgisayarın adı" htmlFor="dn">
          <input id="dn" className="inp" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      {err && <div className="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => setHi(null)}>Başka ana bilgisayar</button>
        <button className="btn p" disabled={busy || !fpOk || code.length !== 6 || !name.trim()} onClick={doPair}>
          {busy ? 'Eşleştiriliyor…' : 'Eşleştir ve bağlan'}
        </button>
      </div>
    </>
  )
}

function DatabaseStep({ status }: { status: BackendStatus }) {
  const done = status.steps.filter((s) => s.state === 'done').length
  const pct = status.state === 'ready' ? 100 : Math.min(95, Math.round((done / 6) * 100))
  return (
    <>
      <H title={status.state === 'ready' ? 'Veritabanı hazır' : status.state === 'error' ? 'Veritabanı kurulamadı' : 'Veritabanı kuruluyor'} sub="Klinik verileri bu bilgisayarda, PostgreSQL'de tutulacak. Ayrı bir program kurmanız gerekmez." />
      {!bridge && <div className="alert amb">Tarayıcı geliştirme modu: veritabanı geliştirme sunucusunda zaten çalışıyor.</div>}
      {bridge && <StepList status={status} />}
      <div role="progressbar" aria-label="Kurulum ilerlemesi" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, background: '#ece9e3', border: '1px solid var(--line)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: status.state === 'error' ? 'var(--red)' : 'var(--accent)' }} />
      </div>
      {status.state === 'error' && (
        <div className="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{status.error}</span>
          <button className="btn" onClick={() => bridge?.startBackend()}>Tekrar dene</button>
        </div>
      )}
      {bridge && <div className="mut" style={{ fontSize: 12 }}>Veri klasörü: <span className="mono">{status.dataRoot}</span></div>}
    </>
  )
}

function ClinicStep({ d, up }: StepProps) {
  const c = d.clinic
  const set = (k: keyof WizardData['clinic']) => (e: React.ChangeEvent<HTMLInputElement>) => up('clinic', { ...c, [k]: e.target.value })
  return (
    <>
      <H title="Klinik bilgileri" sub="Yazdırılan belgelerde ve mesajlarda kullanılır. Sonradan Ayarlar > Klinik'ten değiştirilebilir." />
      <div className="g4" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <Field label="Klinik adı *" htmlFor="cn" style={{ gridColumn: 'span 2' }}><input id="cn" className="inp" value={c.clinicName} onChange={set('clinicName')} autoFocus /></Field>
        <Field label="İl *" htmlFor="ci"><input id="ci" className="inp" value={c.city} onChange={set('city')} /></Field>
        <Field label="İlçe *" htmlFor="di"><input id="di" className="inp" value={c.district} onChange={set('district')} /></Field>
        <Field label="Telefon" htmlFor="ph"><input id="ph" className="inp" value={c.phone} onChange={set('phone')} /></Field>
        <Field label="Adres" htmlFor="ad"><input id="ad" className="inp" value={c.address} onChange={set('address')} /></Field>
      </div>
    </>
  )
}

function AdminStep({ d, up, onCreate, busy }: StepProps & { onCreate(): void; busy: boolean }) {
  const a = d.admin
  const set = (k: keyof WizardData['admin']) => (e: React.ChangeEvent<HTMLInputElement>) => up('admin', { ...a, [k]: e.target.value })
  const strength = useMemo(() => {
    const p = a.password
    let s = 0
    if (p.length >= 10) s++
    if (p.length >= 14) s++
    if (/[A-ZÇĞİÖŞÜ]/.test(p) && /[a-zçğıöşü]/.test(p)) s++
    if (/\d/.test(p)) s++
    if (/[^A-Za-z0-9çğıöşüÇĞİÖŞÜ]/.test(p)) s++
    return s
  }, [a.password])

  if (d.session) {
    return (
      <>
        <H title="Kurtarma kodu" sub="Bu 12 kelime, yedekleri açmak ve yönetici parolası unutulduğunda erişimi geri almak için gerekir." />
        <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 6, padding: 12, border: '1px solid var(--line)', background: 'var(--head)' }}>
          {d.recovery.split(' ').map((w, i) => (
            <span key={i}><span className="mut">{i + 1}.</span> {w}</span>
          ))}
        </div>
        <div className="alert amb">Kodu kâğıda yazın ve bilgisayardan ayrı, güvenli bir yerde saklayın. PatiKünye bu kodu bir daha göstermez.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => window.print()}>Yazdır</button>
        </div>
        <label className="ck">
          <input type="checkbox" checked={d.recoveryConfirmed} onChange={(e) => up('recoveryConfirmed', e.target.checked)} />
          Kurtarma kodunu yazdım / yazdırdım.
        </label>
      </>
    )
  }
  return (
    <form
      style={{ display: 'contents' }}
      onSubmit={(e) => {
        e.preventDefault()
        onCreate()
      }}
    >
      <H title="Yönetici hekim" sub="Bu kullanıcı klinik yöneticisi olur; diğer kullanıcıları ekleyebilir." />
      <div className="g4" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <Field label="Ad soyad *" htmlFor="fn"><input id="fn" className="inp" value={a.fullName} onChange={set('fullName')} required autoFocus /></Field>
        <Field label="Oda sicil no *" htmlFor="rn"><input id="rn" className="inp" value={a.chamberRegNo} onChange={set('chamberRegNo')} required /></Field>
        <Field label="Diploma no" htmlFor="dn"><input id="dn" className="inp" value={a.diplomaNo} onChange={set('diplomaNo')} /></Field>
        <Field label="Kullanıcı adı *" htmlFor="un"><input id="un" className="inp" value={a.username} onChange={set('username')} autoComplete="username" required /></Field>
        <Field label="Parola * (en az 10 karakter)" htmlFor="pw">
          <input id="pw" type="password" className="inp" value={a.password} onChange={set('password')} autoComplete="new-password" required />
          <div style={{ display: 'flex', gap: 3, marginTop: 2 }} aria-label={`Parola gücü ${strength}/5`}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ flex: 1, height: 4, background: i < strength ? (strength <= 2 ? 'var(--red)' : strength <= 3 ? 'var(--amb)' : 'var(--ok)') : 'var(--line-3)' }} />
            ))}
          </div>
        </Field>
        <Field label="Parola tekrar *" htmlFor="pw2" error={a.password2 && a.password !== a.password2 ? 'Parolalar aynı değil' : undefined}>
          <input id="pw2" type="password" className="inp" value={a.password2} onChange={set('password2')} autoComplete="new-password" required />
        </Field>
      </div>
      <div>
        <button className="btn p" disabled={busy || a.password.length < 10 || a.password !== a.password2}>{busy ? 'Kaydediliyor…' : 'Yöneticiyi oluştur'}</button>
      </div>
    </form>
  )
}

function BackupStep({ d, up }: StepProps) {
  const sameAsSystem = /^c:/i.test(d.backupFolder)
  return (
    <>
      <H title="Yedekleme" sub="Veriler bu bilgisayarda durduğu için disk arızasında her şey kaybolabilir. Yedekler her gün otomatik alınır." />
      <Field label="Yedek klasörü" htmlFor="bf">
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="bf" className="inp mono" value={d.backupFolder} onChange={(e) => up('backupFolder', e.target.value)} placeholder="ör. E:\PatiKunye Yedek" />
          {bridge && (
            <button
              className="btn"
              type="button"
              onClick={async () => {
                const f = await bridge.chooseFolder('Yedek klasörünü seçin')
                if (f) up('backupFolder', f)
              }}
            >
              Seç…
            </button>
          )}
        </div>
      </Field>
      {!d.backupFolder && <div className="mut">Boş bırakılırsa yedekler uygulama klasörüne alınır. Harici disk ya da ağ klasörü önerilir.</div>}
      {sameAsSystem && <div className="alert amb">Seçilen klasör sistem diskinde (C:). Disk arızasında yedek de kaybolur; harici disk ya da ağ klasörü seçin.</div>}
      <Field label="Günlük yedek saati" htmlFor="bt" style={{ width: 160 }}>
        <input id="bt" type="time" className="inp" value={d.backupTime} onChange={(e) => up('backupTime', e.target.value)} />
      </Field>
      <div className="mut" style={{ fontSize: 12 }}>Bilgisayar o saatte kapalıysa yedek ilk açılışta alınır. Yedekler kurtarma kodunuzla şifrelenir.</div>
    </>
  )
}

function BitlockerStep({ state }: { state: WizardData['bitlocker'] }) {
  return (
    <>
      <H title="Disk şifreleme" sub="Bilgisayar çalınırsa verilerin okunamaması için Windows BitLocker önerilir." />
      {state === null && <div className="mut">Denetleniyor…</div>}
      {state === 'on' && <div className="alert ok">BitLocker açık. Sistem diski şifreli.</div>}
      {state === 'off' && (
        <div className="alert amb">
          BitLocker kapalı. Hassas alanlar (T.C. kimlik no) uygulama tarafından şifreleniyor, ama tüm diskin şifrelenmesi önerilir: Denetim Masası &gt; BitLocker Sürücü Şifrelemesi &gt; BitLocker'ı aç.
        </div>
      )}
      {state === 'unknown' && <div className="alert amb">BitLocker durumu okunamadı (Windows sürümü desteklemiyor olabilir). Disk şifrelemesini BT sorumlunuzla kontrol edin.</div>}
      <div className="mut" style={{ fontSize: 12 }}>Bu adım engelleyici değildir.</div>
    </>
  )
}

function ReaderStep({ onMeasured }: { onMeasured(ms: number): void }) {
  const [val, setVal] = useState('')
  const times = useRef<number[]>([])
  const [result, setResult] = useState<{ raw: string; gap: number } | null>(null)
  const v = result ? validateChip(result.raw) : null
  return (
    <>
      <H title="Çip okuyucu testi" sub="USB okuyucuyu takın, aşağıdaki alana tıklayın ve okuyucuyu bir çipe tutun." />
      <Field label="Okunan değer" htmlFor="rt">
        <input
          id="rt"
          data-chip-input
          className="inp mono"
          style={{ height: 40, fontSize: 18 }}
          value={val}
          placeholder="Okuyucuyu çipe tutun"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const t = times.current
              const gaps = t.slice(1).map((x, i) => x - t[i])
              const maxGap = gaps.length ? Math.max(...gaps) : 0
              setResult({ raw: val, gap: Math.round(maxGap) })
              if (gaps.length >= 8) onMeasured(Math.max(35, Math.ceil(maxGap * 1.5)))
              times.current = []
              setVal('')
              return
            }
            if (val === '') times.current = []
            times.current.push(performance.now())
          }}
        />
      </Field>
      {result && v && (
        <dl className="kv">
          <dt>Ham değer</dt>
          <dd className="mono">{result.raw}</dd>
          <dt>Sonuç</dt>
          <dd>{v.ok ? <span className="st s-ok">Geçerli · <span className="mono">{formatChip(v.value)}</span></span> : <span className="st s-red">{v.error}</span>}</dd>
          <dt>Tuş arası</dt>
          <dd className="mono">{result.gap} ms {result.gap > 60 ? <span className="s-amb">· elle yazılmış gibi</span> : <span className="s-ok">· okuyucu hızı</span>}</dd>
        </dl>
      )}
      <div className="mut" style={{ fontSize: 12 }}>Okuyucunuz yoksa bu adımı atlayabilirsiniz; ayar sonradan Ayarlar &gt; Çip okuyucu'dan yapılır.</div>
    </>
  )
}

function MessagingStep() {
  return (
    <>
      <H title="Mesajlaşma" sub="Aşı ve randevu hatırlatmaları SMS ya da e-postayla gönderilir." />
      <p style={{ margin: 0 }}>SMS sağlayıcısı (Netgsm, İletimerkezi…) ve e-posta ayarları kurulumdan sonra Ayarlar &gt; Mesajlaşma'dan yapılabilir. Ayar yapılana kadar hatırlatmalar listede görünür ama gönderilmez.</p>
    </>
  )
}

function DoneStep({ d }: { d: WizardData }) {
  return (
    <>
      <H title="Kurulum tamamlandı" />
      <dl className="kv">
        <dt>Klinik</dt>
        <dd>{d.clinic.clinicName} · {d.clinic.city} / {d.clinic.district}</dd>
        <dt>Yönetici</dt>
        <dd>{d.session?.user.fullName} ({d.session?.user.username})</dd>
        <dt>Yedek</dt>
        <dd>{d.backupFolder || 'uygulama klasörü'} · her gün {d.backupTime}</dd>
        <dt>Disk şifreleme</dt>
        <dd>{d.bitlocker === 'on' ? 'açık' : d.bitlocker === 'off' ? 'kapalı (önerilir)' : 'bilinmiyor'}</dd>
        <dt>Çip okuyucu</dt>
        <dd>{d.readerGapMs ? `test edildi · eşik ${d.readerGapMs} ms` : 'test edilmedi'}</dd>
      </dl>
      <p style={{ margin: 0 }}>"Başla" ile uygulamaya geçin. İlk iş olarak Ayarlar &gt; Kullanıcılar'dan diğer hekim ve personeli ekleyebilirsiniz.</p>
    </>
  )
}
