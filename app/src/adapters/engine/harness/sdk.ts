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

/** 从 src 或 dist bundle 出发向上找 `vendor/deepseek-harness`，避免依赖 import.meta。 */
function findRepoRoot(): string {
  const roots = [moduleDirectory(), process.cwd()]
  for (const start of roots) {
    let current = resolve(start)
    for (let depth = 0; depth < 6; depth += 1) {
      if (existsSync(join(current, 'vendor', 'deepseek-harness', 'packages', 'sdk'))) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return resolve(moduleDirectory(), '../../../../..')
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
