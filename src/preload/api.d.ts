// Preload'ın arayüze açtığı köprü (window.patikunye). Tarayıcı geliştirme modunda tanımsızdır.
export interface SetupStep {
  key: string
  label: string
  state: 'pending' | 'start' | 'done' | 'error'
  detail?: string
  ms?: number
}

export interface BackendStatus {
  state: 'idle' | 'starting' | 'ready' | 'error'
  /** Veritabanı kümesi henüz oluşturulmamış (ilk açılış) */
  firstRun: boolean
  apiBase?: string
  error?: string
  steps: SetupStep[]
  dataRoot: string
  logFile: string
  /** host: veritabanı bu bilgisayarda; client: yerel ağdaki ana bilgisayara bağlı */
  mode: 'host' | 'client'
  client?: { hostUrl: string; clinicName: string; deviceName: string }
}

export interface UpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  error?: string
  percent?: number
}

export interface DiscoveredHost {
  name: string
  url: string
  clinic: string
}

export interface HelloResult {
  url: string
  clinicName: string
  version: string
  fingerprint: string
}

export interface PatikunyeBridge {
  platform: string
  version: string
  /** İlk yüklemedeki durum (eşzamanlı) */
  getStatus(): Promise<BackendStatus>
  /** Veritabanı + API'yi başlatır (zaten başladıysa bekler) */
  startBackend(): Promise<BackendStatus>
  /** Kurulum adımlarındaki değişiklikleri dinler; aboneliği bırakan fonksiyon döner */
  onStatus(cb: (s: BackendStatus) => void): () => void
  /** Kişisel veri içermeyen tanı paketini kaydeder; dosya yolunu döner */
  saveDiagnostics(): Promise<string | null>
  /** Klasör seçme penceresi */
  chooseFolder(title?: string): Promise<string | null>
  /** Sistem diski BitLocker durumu */
  bitlockerStatus(): Promise<'on' | 'off' | 'unknown'>
  /** Kayıt dosyasını Gezgin'de gösterir */
  showLog(): void
  /** Otomatik güncelleme (yalnızca ana bilgisayar, güncelleme adresi tanımlıysa) */
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    install(): Promise<{ ok: boolean; error?: string }>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /** Yerel ağ (istemci): ana bilgisayar arama, tanışma, eşleştirme, bağlantıyı unutma */
  net: {
    discover(): Promise<DiscoveredHost[]>
    hello(address: string): Promise<HelloResult>
    pair(input: { url: string; code: string; deviceName: string; fingerprint: string }): Promise<BackendStatus>
    forget(): Promise<void>
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
  }
}

declare global {
  interface Window {
    patikunye?: PatikunyeBridge
  }
}
