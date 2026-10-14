// Ortak ek dosya paneli: listeleme, sürükle-bırak/seç ile yükleme, önizleme.
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, qs } from '../api'
import { useToast } from '../ui'

interface FileItem {
  id: string
  fileName: string
  mime: string
  size: number
  createdAt: string
}

export function Attachments({ ownerType, ownerId, title = 'Belgeler', canUpload = true }: { ownerType: string; ownerId: string; title?: string; canUpload?: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const key = ['files', ownerType, ownerId]
  const list = useQuery({ queryKey: key, queryFn: () => api.get<FileItem[]>('/api/files' + qs({ ownerType, ownerId })) })

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) await api.upload(f, ownerType, ownerId)
      qc.invalidateQueries({ queryKey: key })
      toast(`${files.length} dosya yüklendi.`)
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function open(f: FileItem) {
    try {
      const url = await api.blobUrl(`/api/files/${f.id}`)
      window.open(url, '_blank')
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  return (
    <section
      className="pnl"
      onDragOver={(e) => {
        if (!canUpload) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (canUpload) upload(e.dataTransfer.files)
      }}
      style={drag ? { outline: '2px dashed var(--accent)' } : undefined}
    >
      <div className="ph">
        <h2>{title}</h2>
        {canUpload && (
          <>
            <button className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Yükleniyor...' : 'Dosya ekle'}
            </button>
            <input ref={input} type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" onChange={(e) => upload(e.target.files)} />
          </>
        )}
      </div>
      {list.data?.length === 0 && <div className="empty">Belge yok.{canUpload && ' Dosyayı buraya sürükleyin.'}</div>}
      <table>
        <tbody>
          {list.data?.map((f) => (
            <tr key={f.id} className="click" onClick={() => open(f)}>
              <td>{f.fileName}</td>
              <td className="mut">{f.mime.replace('application/', '').replace('image/', '')}</td>
              <td className="mono mut">{(f.size / 1024).toFixed(0)} KB</td>
              <td className="mono mut">{new Date(f.createdAt).toLocaleDateString('tr-TR')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
