import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionId } from '../../collab/protocol/ids.ts'
import { useCadreApi } from './CadreApiProvider.tsx'

export type Identity = {
  readonly sessionId: SessionId
  readonly role: 'supervisor' | 'worker'
  readonly projectName: string
}

type IdentityContextValue = {
  identity: Identity | null
  loading: boolean
}

const IdentityContext = createContext<IdentityContextValue>({ identity: null, loading: false })

/** 身份来自主进程 whoami（renderer 不可覆盖）；权限判断只依据 role 与 assignee。 */
export function IdentityProvider({ children }: { children: ReactNode }) {
  const api = useCadreApi()
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(api.available)

  useEffect(() => {
    if (!api.available) {
      setLoading(false)
      return
    }
    let alive = true
    void api.whoami()
      .then((res) => {
        if (!alive) return
        if (res.ok) {
          setIdentity({ sessionId: res.sessionId, role: res.role, projectName: res.projectName })
        }
        setLoading(false)
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api])

  const value = useMemo<IdentityContextValue>(() => ({ identity, loading }), [identity, loading])
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}

export function useIdentity(): IdentityContextValue {
  return useContext(IdentityContext)
}
