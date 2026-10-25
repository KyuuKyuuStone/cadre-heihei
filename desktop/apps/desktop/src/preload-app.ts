/** Origin-scoped boot, native directory selection, host paths of picked files, and update presentation with native confirmation actions. */

import type { DesktopShortcutInput, ShortcutConfigSnapshot, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC, SCHEME, type DshDesktopProductApi, type DesktopUpdatePresentation } from './ipc.ts'
import { PLATFORM_IPC } from './platform-ipc.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { installMandatoryUpdateOverlay } from './preload-mandatory-overlay.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'

function createProductApi(): DshDesktopProductApi {
  return {
    protocolVersion: 1,
    browser: createDesktopBrowserBridge(),
    deviceInfo: () => ipcRenderer.invoke(DESKTOP_IPC.deviceInfo) as Promise<string>,
    keyboard: {
      closeWindow: revision => ipcRenderer.invoke(DESKTOP_IPC.shortcutsCloseWindow, revision) as Promise<void>,
      subscribe: (listener) => {
        const handle = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput): void => {
          if (input.kind === 'iframe') {
            const element = document.activeElement
            if (!(element instanceof HTMLIFrameElement) || !element.isConnected
              || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
            if (input.frameName === '' || element.name !== input.frameName) return
          }
          if (input.kind === 'webview') {
            const element = document.activeElement
            if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected
              || input.frameName === '' || element.getAttribute('name') !== input.frameName) return
          }
          listener(input)
        }
        ipcRenderer.on(DESKTOP_IPC.shortcutsInput, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsInput, handle) }
      },
    },
    shortcuts: {
      get: definitions => ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions) as Promise<ShortcutConfigSnapshot>,
      edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision) as Promise<ShortcutSaveResult>,
      recording: active => ipcRenderer.invoke(DESKTOP_IPC.shortcutsRecording, active) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, snapshot: ShortcutConfigSnapshot): void => { listener(snapshot) }
        ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsChanged, handle) }
      },
    },
    updates: {
      status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
      open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
        ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
      },
    },
  }
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshOnboarding', {
    hasApiKey: () => ipcRenderer.invoke(DESKTOP_IPC.onboardingApiKey) as Promise<boolean>,
    setActive: (active: boolean) => { ipcRenderer.send(DESKTOP_IPC.onboardingActive, active) },
  })
  ipcRenderer.on(DESKTOP_IPC.enterWorkspace, () => {
    const body = document.body
    const previous = body.getAttribute('tabindex')
    body.tabIndex = -1
    body.focus({ preventScroll: true })
    if (previous === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', previous)
  })
  syncWindowsAppearance()
  if (process.platform === 'win32') installMandatoryUpdateOverlay()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  // The composer cites dropped, picked, and pasted files and folders that
  // have a real path as `@path` references instead of uploading them; a
  // File without one (pasted bytes) answers '' and uploads as before.
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => webUtils.getPathForFile(file),
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
  // Milestone B②: minimal read-only ledger bridge. Only this call crosses the
  // context bridge; ipcRenderer and require stay private to the preload.
  contextBridge.exposeInMainWorld('cadre', {
    listTasks: (options?: { projectId?: string }) => ipcRenderer.invoke(DESKTOP_IPC.cadreListTasks, options) as Promise<unknown>,
    listRoster: (options?: { projectId?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreListRoster, options) as Promise<unknown>,
    dispatchTask: (options: {
      projectId?: string
      /** Calling Session; required by the host, never defaulted. */
      sessionId: string
      to?: string
      assigneeSessionId?: string
      title: string
      body: string
      idempotencyKey?: string
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreDispatchTask, options) as Promise<unknown>,
    transitionTask: (options: {
      projectId?: string
      /** Calling Session; required by the host, never defaulted. */
      sessionId: string
      taskId: string
      from?: string
      to?: string
      status?: string
      reason?: string
      idempotencyKey?: string
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreTransitionTask, options) as Promise<unknown>,
    listProviders: () => ipcRenderer.invoke(DESKTOP_IPC.cadreListProviders) as Promise<unknown>,
    saveProvider: (options: {
      providerId: string
      name: string
      kind: string
      baseUrl?: string
      apiKey?: string
      defaultModel: string
      models: readonly { id: string; contextWindow?: number; maxTokens?: number }[]
      enabled?: boolean
      isDefault?: boolean
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreSaveProvider, options) as Promise<unknown>,
    deleteProvider: (options: { providerId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreDeleteProvider, options) as Promise<unknown>,
    testProvider: (options: { providerId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreTestProvider, options) as Promise<unknown>,
    bindSession: (options: {
      sessionId: string
      providerId: string
      model?: string
      reasoningEffort?: string
    }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreBindSession, options) as Promise<unknown>,
    reportIn: (options: {
      sessionId: string
      projectId: string
      role: 'supervisor' | 'worker'
      displayName: string
      duty?: string
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreReportIn, options) as Promise<unknown>,
    getEmployee: (options: { sessionId: string; projectId?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreGetEmployee, options) as Promise<unknown>,
    upsertEmployee: (options: {
      sessionId: string
      projectId?: string
      displayName?: string | null
      templateId?: string | null
      personaNote?: string | null
      preferredProviderId?: string | null
      preferredModel?: string | null
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreUpsertEmployee, options) as Promise<unknown>,
    deleteEmployee: (options: { sessionId: string; projectId?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreDeleteEmployee, options) as Promise<unknown>,
    listEmployees: (options?: { projectId?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreListEmployees, options) as Promise<unknown>,
    saveMember: (options: {
      sessionId: string
      projectId?: string
      role: 'worker' | 'supervisor'
      displayName?: string
      description?: string
    }) => ipcRenderer.invoke(DESKTOP_IPC.cadreSaveMember, options) as Promise<unknown>,
    retireMember: (options: { sessionId: string; projectId?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC.cadreRetireMember, options) as Promise<unknown>,
  })
  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: 'usage' | 'top-up', bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds),
    close: () => ipcRenderer.invoke(PLATFORM_IPC.close),
  })
}

markDocumentPlatform()
syncWindowFullscreen()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' && process.isMainFrame ? createProductApi() : { protocolVersion: 1 })

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap),
    onChange: (locale: string) => { ipcRenderer.send(DESKTOP_IPC.localeChanged, locale) },
  })
}
