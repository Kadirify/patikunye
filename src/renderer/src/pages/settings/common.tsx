// Ayarlar sayfaları için ortak küçük parçalar (modül F)
import { useEffect, useRef, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError } from '../../api'
import { useToast } from '../../ui'
import type { ClinicSettings } from '@shared/settings'
import type { AdminSettingsExtra } from '@shared/admin'

export type FullSettings = ClinicSettings & { petvet: ClinicSettings['petvet'] & AdminSettingsExtra['petvet']; reader: ClinicSettings['reader'] & AdminSettingsExtra['reader'] }

export function useSettings() {
  return useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<FullSettings>('/api/admin/settings') })
}

/** Ayarların bir bölümünü kaydeder (PATCH /api/admin/settings) */
export function useSaveSettings(okMsg = 'Ayarlar kaydedildi.') {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (patch: Partial<FullSettings>) => api.patch<FullSettings>('/api/admin/settings', patch),
    onSuccess: () => {
      qc.invalidateQueries()
      toast(okMsg)
    },
  })
}

export function errText(e: unknown): string {
  return e instanceof HttpError || e instanceof Error ? e.message : 'Beklenmeyen hata.'
}

/** Alan bazlı hata (sunucu details[].path[0]) */
export function fieldErr(e: unknown, field: string): string | undefined {
  if (!(e instanceof HttpError) || !Array.isArray(e.details)) return undefined
  const d = (e.details as { path?: unknown[]; message?: string }[]).find((x) => x.path?.[0] === field)
  return d?.message
}

/** Ctrl+S ile kaydet */
export function useCtrlS(fn: () => void, enabled = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        ref.current()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [enabled])
}

/** Esc ile kapat */
export function useEsc(fn: () => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ref.current()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
}

export function NoAccess() {
  return (
    <>
      <div className="page-head"><h1>Yetki yok</h1></div>
      <div className="pnl empty">Bu sayfa için yetkiniz yok. Klinik yöneticisine başvurun.</div>
    </>
  )
}

/** Tasarımdaki etiket | değer satırı */
export function Row({ label, htmlFor, children, last }: { label: string; htmlFor?: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) minmax(0, 1fr)', gap: 12, alignItems: 'center', padding: '10px 12px', borderBottom: last ? 0 : '1px solid #ece9e3' }}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>{children}</div>
    </div>
  )
}

/** Basit modal (Esc kapatır) */
export function Modal({ title, onClose, children, width = 520 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEsc(onClose)
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, background: 'rgba(29,28,26,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pnl" style={{ width: '100%', maxWidth: width, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,.18)' }}>
        <div className="ph">
          <h2>{title}</h2>
          <button type="button" className="btn sm" aria-label="Kapat" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function downloadText(fileName: string, text: string, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
