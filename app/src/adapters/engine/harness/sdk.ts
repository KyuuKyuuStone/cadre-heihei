/**
 * Harness SDK 加载器（仅本目录允许触碰 harness，R1）。
 *
 * 使用 W1-02 pin 的 submodule 构建产物；不 copy、不改 vendor。
 * 动态 import 避免把 harness 类型泄露到端口/业务层。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { moduleDirectory } from '../../../runtime/module-dir.ts'
import { HarnessEngineError } from './mapping.ts'

/**
 * 从多个起点向上找带 `vendor/deepseek-harness/packages/sdk` 的根。
 * 纯函数便于单测；官方 dsh 包树本身没有 packages/，因此不能以它作根。
 */
export function findRepoRootFrom(
  starts: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const start of starts) {
    if (start.trim() === '') continue
    let current = resolve(start)
    for (let depth = 0; depth < 8; depth += 1) {
      if (exists(join(current, 'vendor', 'deepseek-harness', 'packages', 'sdk'))) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

/** 优先 bundle/源码位置，其次安装态 resources、可执行文件目录与 cwd。 */
function findRepoRoot(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const starts = [
    moduleDirectory(),
    resourcesPath ?? '',
    dirname(process.execPath),
    process.cwd(),
  ]
  return findRepoRootFrom(starts, existsSync) ?? resolve(moduleDirectory(), '../../../../..')
}

export function resolveHarnessRepoRoot(): string {
  return findRepoRoot()
}

const DEFAULT_SDK_ENTRY = join(
  findRepoRoot(),
  'vendor',
  'deepseek-harness',
  'packages',
  'sdk',
  'client',
  'lib',
  'index.js',
)

export function harnessSdkEntryPath(): string {
  return DEFAULT_SDK_ENTRY
}

export interface HarnessLaunchOptions {
  cwd?: string
  dshHome?: string
  env?: NodeJS.ProcessEnv
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
  initializeTimeoutMs?: number
  requestTimeoutMs?: number
  /**
   * 显式 dsh CLI 入口。SDK 在 resolveDshLaunch 中按 callerCwd 解析并作为
   * node 的第一个参数（vendor/.../sdk/client/lib/index.js:163-164）；
   * 未提供时 SDK 回退 installedDshNodeLaunch。此处只透传，不做二次解析。
   */
  dshBin?: string
  profile?: string
  patches?: string[]
  processCwd?: string
}

export interface HarnessRunResultLike {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: unknown[]
}

export interface HarnessSessionLike {
  readonly id: string
  run(input: string, options?: { onNotification?: (notification: unknown) => void }): Promise<HarnessRunResultLike>
  getWorkingDirectory(): Promise<string>
  setWorkingDirectory(path: string): Promise<string>
}

export interface HarnessRuntimeLike {
  start(): Promise<void>
  close(): Promise<void>
  session(id?: string): HarnessSessionLike
  resumeSession(id: string): Promise<HarnessSessionLike>
}

export interface HarnessSdkModule {
  DeepSeekHarness: new (options?: HarnessLaunchOptions) => HarnessRuntimeLike
}

export interface LoadSdkOptions {
  /** 测试/诊断用；默认 W1-02 submodule 的构建产物。 */
  sdkEntry?: string
}

/** 加载 pin 的 SDK；缺构建产物时给出结构化错误，不静默降级。 */
export async function loadHarnessSdk(options: LoadSdkOptions = {}): Promise<HarnessSdkModule> {
  const entry = options.sdkEntry ?? DEFAULT_SDK_ENTRY
  if (!existsSync(entry)) {
    throw new HarnessEngineError(
      'ENGINE_UNAVAILABLE',
      `harness SDK build missing at ${entry}; run the W1-02 build for the pinned submodule`,
      false,
      'HARNESS_SDK_MISSING',
    )
  }
  try {
    const mod = await import(pathToFileURL(entry).href) as Partial<HarnessSdkModule>
    if (typeof mod.DeepSeekHarness !== 'function') {
      throw new Error('module has no DeepSeekHarness export')
    }
    return mod as HarnessSdkModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HarnessEngineError(
      'ENGINE_UNAVAILABLE',
      `failed to load harness SDK: ${message}`,
      false,
      'HARNESS_SDK_LOAD_FAILED',
    )
  }
}
