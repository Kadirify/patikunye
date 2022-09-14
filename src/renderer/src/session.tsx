import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, getToken, setToken, setUnauthorizedHandler } from './api'
import type { SessionDto, UserDto } from '@shared/api-types'
import { can, type Permission } from '@shared/permissions'

interface SessionState {
  user: UserDto | null
  clinicName: string
  ready: boolean
  signIn(s: SessionDto): void
  signOut(): Promise<void>
}

const Ctx = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [user, setUser] = useState<UserDto | null>(null)
  const [clinicName, setClinicName] = useState('')
  const [ready, setReady] = useState(false)

  const clear = useCallback(() => {
    setToken(null)
    setUser(null)
    qc.clear()
  }, [qc])

  useEffect(() => {
    setUnauthorizedHandler(clear)
    if (!getToken()) {
      setReady(true)
      return
    }
    api
      .get<{ user: UserDto; clinicName: string }>('/api/auth/me')
      .then((r) => {
        setUser(r.user)
        setClinicName(r.clinicName)
      })
      .catch(clear)
      .finally(() => setReady(true))
  }, [clear])

  const value: SessionState = {
    user,
    clinicName,
    ready,
    signIn(s) {
      setToken(s.token)
      setUser(s.user)
      setClinicName(s.clinicName)
    },
    async signOut() {
      await api.post('/api/auth/logout').catch(() => undefined)
      clear()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Arayüzde izin kontrolü: yetkisi olmayan düğmeler gizlenir */
export function useCan() {
  const { user } = useSession()
  return (p: Permission) => can(user?.role, p)
}

export function useSession() {
  const v = useContext(Ctx)
  if (!v) throw new Error('SessionProvider eksik')
  return v
}
