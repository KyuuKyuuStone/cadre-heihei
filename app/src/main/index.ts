/**
 * Electron 主进程入口（M4 §2 步骤 2-7 + §8 会话流）。
 *
 * 启动顺序：身份加载/台账校验 → SQLite 后端 → registry.start → ensure →
 * handlers 注入；身份失败只进 denied，不启动引擎。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { SqliteDispatchService } from '../collab/dispatch/index.ts'
import type { ProjectMembership } from '../collab/dispatch/store-port.ts'
import { SessionRuntimeRegistry } from '../runtime/session-runtime-registry.ts'
import type { IpcIdentity } from '../shared/ipc.ts'
import { runE2eProbe } from './e2e-probe.ts'
import { createWindowEventSink, registerElectronIpc } from './electron-ipc.ts'
import {
  DEV_SERVER_URL,
  buildContentSecurityPolicy,
  hasCspMeta,
  isAllowedNavigation,
  resolveAppMode,
} from './electron-policy.ts'
import { InMemoryIdentityBinding } from './identity.ts'
import { loadIdentity, validateIdentityAgainstMembers, type LoadedIdentity } from './identity-config.ts'
import { createIpcHandlers } from './ipc-handlers.ts'
import { FilePreferencesStore } from './preferences.ts'
import { countHarnessProcesses } from './residual.ts'
import { SessionEventPump } from './session-events.ts'
import { RegistrySessionPort } from './session-port.ts'

export const APP_NAME = 'cadre-heihei'

if (process.env.CADRE_USER_DATA !== undefined) app.setPath('userData', process.env.CADRE_USER_DATA)
const userData = app.getPath('userData')
const databasePath = join(userData, 'cadre.sqlite')
const identityPath = join(userData, 'identity.json')
const workingDirectory = process.env.CADRE_WORKDIR ?? join(userData, 'workspace')

const windows = new Map<number, BrowserWindow>()
const smoke = process.env.CADRE_SMOKE === '1'
const e2e = process.env.CADRE_E2E === '1'
const mode = resolveAppMode({ isPackaged: app.isPackaged, env: process.env })
const devServerUrl = process.env.CADRE_DEV_SERVER_URL ?? DEV_SERVER_URL
const rendererRoot = join(__dirname, '..', 'renderer')
const csp = buildContentSecurityPolicy(mode)

const binding = new InMemoryIdentityBinding()
const pump = new SessionEventPump({
  sink: createWindowEventSink((windowId) => windows.get(windowId)),
})

let backend: SqliteDispatchService | undefined
let registry: SessionRuntimeRegistry | undefined
let port: RegistrySessionPort | undefined
let identity: LoadedIdentity | undefined
let otherTaskId: string | undefined
let shuttingDown = false

function log(message: string): void {
  console.log(`[m4] ${message}`)
}

function resolveMcpServerPath(): string {
  // 打包态：MCP server 为 esbuild 单文件 CJS，随 extraResources 落真实磁盘；
  // 由 nodeCommand=process.execPath（electron.exe）+ ELECTRON_RUN_AS_NODE=1 拉起，
  // 不依赖终端用户安装系统 Node。asar 内路径子进程不可读。
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'app.mcp', 'server.cjs')
    if (existsSync(packaged)) return packaged
  }
  const candidates = [
    join(__dirname, '..', '..', 'src', 'mcp', 'server.ts'),
    join(app.getAppPath(), 'src', 'mcp', 'server.ts'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
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
  log(`csp mode=${mode} via=onHeadersReceived`)
}

function seedTestMembers(service: SqliteDispatchService): void {
  if (process.env.CADRE_TEST_SEED_MEMBERS !== '1') return
  const extra = process.env.CADRE_SEED_MEMBERS_JSON
  if (extra !== undefined) {
    try {
      const parsed = JSON.parse(extra) as ProjectMembership[]
      for (const member of parsed) service.addMember(member)
    } catch {
      log('seed-members: CADRE_SEED_MEMBERS_JSON 非法，已忽略')
    }
  }
  if (identity !== undefined) {
    service.addMember({
      projectId: identity.projectId as never,
      sessionId: identity.sessionId as never,
      role: identity.role,
      state: 'available',
      displayName: identity.sessionId,
    })
    log('seed-members: identity 以测试模式写入（非生产路径）')
  }
}

function seedIsolationTask(service: SqliteDispatchService): void {
  if (!e2e) return
  const projectId = process.env.CADRE_E2E_OTHER_PROJECT ?? 'e2e-other-project'
  const supervisor = 'e2e-other-supervisor'
  const worker = 'e2e-other-worker'
  service.addMember({
    projectId: projectId as never,
    sessionId: supervisor as never,
    role: 'supervisor',
    state: 'available',
    displayName: supervisor,
  })
  service.addMember({
    projectId: projectId as never,
    sessionId: worker as never,
    role: 'worker',
    state: 'available',
    displayName: worker,
  })
  const receipt = service.dispatch(
    { projectId: projectId as never, sessionId: supervisor as never },
    {
      projectId: projectId as never,
      toSessionId: worker as never,
      title: 'E2E 他项目任务',
      body: 'isolation',
      idempotencyKey: `e2e-other-${Date.now()}` as never,
    },
  )
  if (receipt.ok) {
    otherTaskId = receipt.taskId
    log(`e2e: other-project task=${otherTaskId} project=${projectId}`)
  }
}

async function bootstrap(): Promise<void> {
  installCsp()
  mkdirSync(workingDirectory, { recursive: true })

  backend = new SqliteDispatchService({
    databasePath,
    busyTimeoutMs: 10_000,
    serverVersion: app.getVersion(),
  })
  const integrity = backend.integrityCheck()
  const dbHealthy = integrity === 'ok'
  log(`db path=${databasePath} journal=${backend.journalMode()} integrity=${integrity}`)
  if (!dbHealthy) log('db integrity check failed（不启动引擎）')

  const loaded = loadIdentity(process.env, identityPath)
  if (loaded.ok) identity = loaded.identity
  seedTestMembers(backend)
  seedIsolationTask(backend)

  let identityReady = false
  if (!loaded.ok) {
    log(`identity denied reason=${loaded.reason} ${loaded.detail}（不启动引擎）`)
  } else if (!dbHealthy) {
    log('identity denied reason=db-integrity（不启动引擎）')
  } else {
    const members = backend.listMembers(loaded.identity.projectId as never)
    const validation = validateIdentityAgainstMembers(loaded.identity, members)
    if (validation.ok) {
      identityReady = true
      log(
        `identity project=${loaded.identity.projectId} session=${loaded.identity.sessionId} ` +
          `role=${loaded.identity.role} source=${loaded.identity.source}`,
      )
    } else {
      log(`identity denied reason=${validation.reason}（不启动引擎）`)
    }
  }

  if (identityReady && identity !== undefined) {
    registry = new SessionRuntimeRegistry({
      dshHomeBase: join(userData, 'runtimes'),
      patchDirBase: join(userData, 'patches'),
      databasePathFor: () => databasePath,
      mcpServerPath: resolveMcpServerPath(),
      // MCP 子进程不依赖系统 Node：electron.exe + ELECTRON_RUN_AS_NODE=1（patch env 注入）。
      nodeCommand: process.execPath,
      adapterOptions: {
        // harness SDK 用 process.execPath 拉起 dsh；Electron 下需以 Node 模式运行子进程。
        env: {
          ...process.env,
          ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
        },
        provider: process.env.CADRE_PROVIDER ?? 'deepseek-official',
        model: process.env.CADRE_MODEL ?? 'deepseek-flash',
        reasoningEffort: 'off',
        maxTokens: Number(process.env.CADRE_MAX_TOKENS ?? 64) || 64,
        initializeTimeoutMs: 60_000,
        requestTimeoutMs: 180_000,
      },
    })
    try {
      await registry.start()
      port = new RegistrySessionPort({ registry, workingDirectory, databasePath })
      await port.ensure(identity)
      log(`session ensured session=${identity.sessionId}`)
    } catch (error) {
      const code =
        (error as { code?: unknown; rawCode?: unknown }).rawCode ??
        (error as { code?: unknown }).code ??
        'UNKNOWN'
      log(`session ensure failed code=${String(code)}（不自动重建）`)
    }
  }

  const handlers = createIpcHandlers({
    binding,
    backend,
    preferences: new FilePreferencesStore(join(userData, 'preferences.json')),
    pump,
    ...(port === undefined ? {} : { sessions: port }),
    projectNameFor: (projectId) => process.env.CADRE_PROJECT_NAME ?? projectId,
  })
  registerElectronIpc({
    ipcMain,
    fromWebContents: (sender) => BrowserWindow.fromWebContents(sender as never) ?? undefined,
    handlers,
  })
  createWindow()
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (mode === 'dev') {
    await win.loadURL(devServerUrl)
    return
  }
  const indexPath = join(rendererRoot, 'index.html')
  const meta = hasCspMeta(readFileSync(indexPath, 'utf8')) ? 'present' : 'absent'
  log(`csp mode=prod meta=${meta} path=${indexPath}`)
  await win.loadFile(indexPath)
}

function bindIdentity(windowId: number): void {
  if (identity !== undefined) binding.bind(String(windowId), identity)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !smoke && !e2e,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
    },
  })

  windows.set(win.id, win)
  bindIdentity(win.id)

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, { mode, devServerUrl, rendererRoot })) {
      event.preventDefault()
      log(`navigation denied url=${url}`)
    }
  })
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log('webview attach denied')
  })
  win.on('closed', () => {
    windows.delete(win.id)
    pump.dropWindow(String(win.id))
    binding.unbind(String(win.id))
    if (!shuttingDown && identity !== undefined && port !== undefined) {
      void port.reclaim(identity.sessionId as never).catch((error: unknown) => {
        log(`reclaim failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })

  if (smoke) {
    win.webContents.once('did-finish-load', () => {
      log(`window-ready id=${win.id} mode=${mode} visible=false`)
      void win.webContents
        .executeJavaScript(
          `({ cadre: typeof window.cadre, require: typeof require, process: typeof process,
              methods: Object.keys(window.cadre ?? {}).sort() })`,
        )
        .then((info: unknown) => log(`smoke-probe ${JSON.stringify(info)}`))
        .catch((error: unknown) => log(`smoke-probe failed: ${String(error)}`))
        .finally(() => setTimeout(() => app.quit(), 100))
    })
  }

  if (e2e) {
    win.webContents.once('did-finish-load', () => {
      void runE2eProbe(win.webContents, {
        sessionId: identity?.sessionId ?? '',
        body: process.env.CADRE_E2E_PROMPT ?? 'Reply with exactly: pong',
        ...(otherTaskId === undefined ? {} : { otherTaskId }),
        timeoutMs: Number(process.env.CADRE_E2E_TIMEOUT_MS ?? 120_000),
      }).then((result) => {
        log(`e2e result=${JSON.stringify(result)}`)
        app.quit()
      })
    })
    setTimeout(() => {
      log('e2e hard timeout')
      app.exit(4)
    }, Number(process.env.CADRE_E2E_HARD_TIMEOUT_MS ?? 180_000)).unref()
  }

  void loadRenderer(win).catch((error: unknown) => {
    log(`load failed: ${error instanceof Error ? error.message : String(error)}`)
    if (smoke || e2e) app.exit(3)
  })
  return win
}

function focusMainWindow(): void {
  const [first] = [...windows.values()]
  if (first === undefined) return
  if (first.isMinimized()) first.restore()
  first.focus()
}

async function shutdown(): Promise<void> {
  try {
    await registry?.stop()
  } catch (error) {
    log(`registry stop failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const residual = await countHarnessProcesses()
  log(`residual-harness count=${residual}`)
  try {
    backend?.close()
  } catch (error) {
    log(`db close failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  app.exit(0)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    void shutdown()
  })
  void app.whenReady().then(bootstrap)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || smoke || e2e) app.quit()
  })
}

export type { IpcIdentity }
