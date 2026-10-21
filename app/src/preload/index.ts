/**
 * preload 入口（esbuild 打成 CJS；sandbox 下仅用 Electron 注入能力）。
 * 只暴露白名单桥；不暴露 ipcRenderer / process / require。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createCadreBridge, type BridgeTransport } from './bridge.ts'

const transport: BridgeTransport = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('cadre', createCadreBridge(transport))
