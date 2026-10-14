// API istemcisi: oturum anahtarını ekler, hataları Türkçe mesajla fırlatır.
import type { ApiError } from '@shared/api-types'

// Electron'da API adresi veritabanı hazır olunca köprüden gelir (setApiBase); tarayıcı modunda sabit.
let base = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:47800'
export function setApiBase(b: string) {
  base = b
}

let token: string | null = sessionStorage.getItem('pk.token')
let onUnauthorized: (() => void) | null = null

export function setToken(t: string | null) {
  token = t
  if (t) sessionStorage.setItem('pk.token', t)
  else sessionStorage.removeItem('pk.token')
}
export const getToken = () => token
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new HttpError(0, 'Sunucuya bağlanılamadı. Uygulama veritabanı çalışıyor mu?')
  }
  const data = (await res.json().catch(() => ({}))) as T & ApiError
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.()
    throw new HttpError(res.status, data.error ?? `Hata (${res.status})`, data.code, data.details)
  }
  return data
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Oturum anahtarıyla dosya indirir (img/iframe doğrudan başlık gönderemediği için) -> object URL */
  async blobUrl(path: string): Promise<string> {
    const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) throw new HttpError(res.status, 'Dosya alınamadı.')
    return URL.createObjectURL(await res.blob())
  },
  /** Dosyayı base64 olarak /api/files'a yükler */
  async upload(file: File, ownerType: string, ownerId: string, note?: string) {
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return request<{ id: string; fileName: string }>('POST', '/api/files', {
      ownerType,
      ownerId,
      fileName: file.name,
      mime: file.type || 'application/octet-stream',
      dataBase64: btoa(bin),
      note,
    })
  },
  get base() {
    return base
  },
}

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? '?' + str : ''
}
