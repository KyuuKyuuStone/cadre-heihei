import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createWindowCadreApi, unavailableCadreApi, type CadreApi } from './cadreApi.ts'

const CadreApiContext = createContext<CadreApi | null>(null)

export function CadreApiProvider({ api, children }: { api?: CadreApi; children: ReactNode }) {
  const value = useMemo(() => api ?? createWindowCadreApi(), [api])
  return <CadreApiContext.Provider value={value}>{children}</CadreApiContext.Provider>
}

/** 未包 Provider 时返回未连接实现（离线可渲染，写通道禁用）。 */
export function useCadreApi(): CadreApi {
  return useContext(CadreApiContext) ?? unavailableCadreApi
}
