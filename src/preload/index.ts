import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const version = process.argv.find((a) => a.startsWith('--pk-version='))?.slice('--pk-version='.length) ?? ''

contextBridge.exposeInMainWorld('patikunye', {
  platform: process.platform,
  version,
  getStatus: () => ipcRenderer.invoke('backend:status'),
  startBackend: () => ipcRenderer.invoke('backend:start'),
  onStatus: (cb: (s: unknown) => void) => {
    const h = (_e: IpcRendererEvent, s: unknown) => cb(s)
    ipcRenderer.on('backend:status', h)
    return () => ipcRenderer.removeListener('backend:status', h)
  },
  saveDiagnostics: () => ipcRenderer.invoke('sys:diagnostics'),
  chooseFolder: (title?: string) => ipcRenderer.invoke('sys:choose-folder', title),
  bitlockerStatus: () => ipcRenderer.invoke('sys:bitlocker'),
  showLog: () => ipcRenderer.send('sys:show-log'),
  updates: {
    status: () => ipcRenderer.invoke('upd:status'),
    check: () => ipcRenderer.invoke('upd:check'),
    install: () => ipcRenderer.invoke('upd:install'),
    onStatus: (cb: (s: unknown) => void) => {
      const h = (_e: IpcRendererEvent, s: unknown) => cb(s)
      ipcRenderer.on('upd:status', h)
      return () => ipcRenderer.removeListener('upd:status', h)
    },
  },
  net: {
    discover: () => ipcRenderer.invoke('net:discover'),
    hello: (address: string) => ipcRenderer.invoke('net:hello', address),
    pair: (input: unknown) => ipcRenderer.invoke('net:pair', input),
    forget: () => ipcRenderer.invoke('net:forget'),
  },
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
})
