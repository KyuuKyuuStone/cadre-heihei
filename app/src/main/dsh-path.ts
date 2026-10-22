/**
 * dsh CLI 入口解析（M4 打包路径）。
 *
 * harness SDK 的 `dshBin` 语义：相对 callerCwd 解析后作为 node CLI 入口
 * （vendor/.../sdk/client/lib/index.js:163-164），不传则用 SDK 自带的 installed dsh。
 */
import { join } from 'node:path'

export const DSH_ENTRY_SUFFIX = join(
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)

export interface DshBinInputs {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly repoRoot: string
  readonly exists: (path: string) => boolean
}

/** 优先 env 覆盖 → 打包 resources/dsh → dev 官方构建树；缺失返回 undefined（SDK 默认）。 */
export function resolveDshBin(inputs: DshBinInputs): string | undefined {
  const override = inputs.env.CADRE_DSH_BIN?.trim()
  if (override !== undefined && override !== '') return override

  const candidate = inputs.isPackaged
    ? join(inputs.resourcesPath, 'dsh', DSH_ENTRY_SUFFIX)
    : join(
        inputs.repoRoot,
        'vendor',
        'deepseek-harness',
        'apps',
        'desktop',
        '.desktop-build',
        'targets',
        'win-x64',
        'dsh',
        DSH_ENTRY_SUFFIX,
      )
  return inputs.exists(candidate) ? candidate : undefined
}

export const SDK_ENTRY_SUFFIX = join(
  'node_modules',
  '@deepseek-ai',
  'dsh-sdk-client',
  'lib',
  'index.js',
)

export type SdkEntryInputs = DshBinInputs

/**
 * SDK 客户端入口（供 HarnessAdapter.loadHarnessSdk）。
 * 打包态官方 dsh 树不带 SDK client，需由构建复制到 resources/dsh/node_modules
 * 下的 `@deepseek-ai/dsh-sdk-client`；dev 用 repo 的 packages/sdk/client。
 */
export function resolveSdkEntry(inputs: SdkEntryInputs): string | undefined {
  const override = inputs.env.CADRE_SDK_ENTRY?.trim()
  if (override !== undefined && override !== '') return override

  const candidate = inputs.isPackaged
    ? join(inputs.resourcesPath, 'dsh', SDK_ENTRY_SUFFIX)
    : join(
        inputs.repoRoot,
        'vendor',
        'deepseek-harness',
        'packages',
        'sdk',
        'client',
        'lib',
        'index.js',
      )
  return inputs.exists(candidate) ? candidate : undefined
}
