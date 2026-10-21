/**
 * Electron 主进程入口（M4 步骤 2-7；不打包）。
 *
 * - 单实例锁 + 1280×800 BrowserWindow（contextIsolation/nodeIntegration/sandbox）；
 * - 导航/新窗口/webview 策略；
 * - ipcMain 注册：windowId 取自 fromWebContents、入口二次校验（electron-ipc.ts）；
 * - CSP：onHeadersReceived 生效；生产 dist/index.html 由构建脚本注入 meta 双保险；
 * - dev loadURL(1420) / prod loadFile(dist/renderer/index.html)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { InMemoryDispatchService } from '../collab/dispatch/index.ts'
import type { IpcIdentity } from '../shared/ipc.ts'
import { createWindowEventSink, registerElectronIpc } from './electron-ipc.ts'
import {
  DEV_SERVER_URL,
  buildContentSecurityPolicy,
  hasCspMeta,
  isAllowedNavigation,
  resolveAppMode,
} from './electron-policy.ts'
import { InMemoryIdentityBinding } from './identity.ts'
import { createIpcHandlers } from './ipc-handlers.ts'
import { FilePreferencesStore } from './preferences.ts'
import { SessionEventPump } from './session-events.ts'

export const APP_NAME = 'cadre-heihei'

const windows = new Map<number, BrowserWindow>()
const smoke = process.env.CADRE_SMOKE === '1'
const mode = resolveAppMode({ isPackaged: app.isPackaged, env: process.env })
const devServerUrl = process.env.CADRE_DEV_SERVER_URL ?? DEV_SERVER_URL
// asar 安全：dist/main/index.cjs → dist/renderer；不依赖 app.getAppPath()
// （未打包直接跑 dist/main/index.cjs 时 appPath 会指向 dist/main）。
const rendererRoot = join(__dirname, '..', 'renderer')
const csp = buildContentSecurityPolicy(mode)

const identity: IpcIdentity = {
  projectId: (process.env.CADRE_PROJECT_ID ?? 'local-project') as never,
  sessionId: (process.env.CADRE_SESSION_ID ?? 'local-session') as never,
  role: process.env.CADRE_ROLE === 'worker' ? 'worker' : 'supervisor',
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
  console.log(`[m4] csp mode=${mode} via=onHeadersReceived`)
}

function startRuntime() {
  const backend = new InMemoryDispatchService({
    serverVersion: app.getVersion(),
    members: [
      {
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        role: identity.role,
        state: 'available',
        displayName: identity.sessionId,
      },
    ],
  })
  const binding = new InMemoryIdentityBinding()
  const preferences = new FilePreferencesStore(
    join(app.getPath('userData'), 'preferences.json'),
  )
  const pump = new SessionEventPump({
    sink: createWindowEventSink((windowId) => windows.get(windowId)),
  })
  const handlers = createIpcHandlers({
    binding,
    backend,
    preferences,
    pump,
    projectNameFor: (projectId) => process.env.CADRE_PROJECT_NAME ?? projectId,
  })
  registerElectronIpc({
    ipcMain,
    fromWebContents: (sender) => BrowserWindow.fromWebContents(sender as never) ?? undefined,
    handlers,
  })
  return { pump, binding }
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (mode === 'dev') {
    await win.loadURL(devServerUrl)
    return
  }
  const indexPath = join(rendererRoot, 'index.html')
  const meta = hasCspMeta(readFileSync(indexPath, 'utf8')) ? 'present' : 'absent'
  console.log(`[m4] csp mode=prod meta=${meta} path=${indexPath}`)
  await win.loadFile(indexPath)
}

function createWindow(runtime: {
  pump: SessionEventPump
  binding: InMemoryIdentityBinding
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !smoke,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
    },
  })

  windows.set(win.id, win)
  runtime.binding.bind(String(win.id), identity)

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, { mode, devServerUrl, rendererRoot })) {
      event.preventDefault()
      console.log(`[m4] navigation denied url=${url}`)
    }
  })
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    console.log('[m4] webview attach denied')
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[m4] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.on('closed', () => {
    windows.delete(win.id)
    runtime.pump.dropWindow(String(win.id))
    runtime.binding.unbind(String(win.id))
  })

  if (smoke) {
    win.webContents.once('did-finish-load', () => {
      console.log(`[m4] window-ready id=${win.id} mode=${mode} visible=false`)
      void win.webContents
        .executeJavaScript(
          `({ cadre: typeof window.cadre, require: typeof require, process: typeof process,
              methods: Object.keys(window.cadre ?? {}).sort() })`,
        )
        .then((info: unknown) => console.log(`[m4] smoke-probe ${JSON.stringify(info)}`))
        .catch((error: unknown) =>
          console.log(`[m4] smoke-probe failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        .finally(() => {
          setTimeout(() => {
            win.destroy()
            app.quit()
          }, 100)
        })
    })
    setTimeout(() => {
      console.log('[m4] smoke timeout')
      app.exit(2)
    }, 15_000).unref()
  }

  void loadRenderer(win).catch((error: unknown) => {
    console.log(`[m4] load failed: ${error instanceof Error ? error.message : String(error)}`)
    if (smoke) app.exit(3)
  })
  return win
}

function focusMainWindow(): void {
  const [first] = [...windows.values()]
  if (first === undefined) return
  if (first.isMinimized()) first.restore()
  first.focus()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())

  void app.whenReady().then(() => {
    installCsp()
    const runtime = startRuntime()
    createWindow(runtime)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || smoke) app.quit()
  })
}
