// Ekran görüntüsü için masaüstü köprüsünün taklidi (web arayüzü gerçek uygulama gibi görünsün)
const noop = () => () => {}
window.patikunye = {
  platform: 'win32',
  version: '0.1.0',
  getStatus: async () => ({ state: 'ready', firstRun: false, steps: [], dataRoot: 'C:\Users\Klinik\AppData\Roaming\PatiKünye\data', logFile: '', mode: 'host', apiBase: 'http://127.0.0.1:47800' }),
  startBackend: async () => {},
  onStatus: noop,
  saveDiagnostics: async () => null,
  chooseFolder: async () => null,
  bitlockerStatus: async () => ({ state: 'on' }),
  showLog: () => {},
  updates: { status: async () => ({ state: 'idle', current: '0.1.0' }), check: async () => ({}), install: async () => {}, onStatus: noop },
  net: { discover: async () => [], hello: async () => null, pair: async () => null, forget: async () => {} },
  window: { minimize() {}, toggleMaximize() {}, close() {} },
}
