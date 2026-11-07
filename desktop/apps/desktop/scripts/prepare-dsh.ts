/**
 * 材料化桌面安装包随附的完整生产 `@deepseek-ai/dsh` 运行时，由 `package-target.ts`
 * 在 package set 就绪后调用。输出树位于 `BUILD_PATHS.dsh`，包含解析完成的
 * `node_modules`、运行时 `package.json`、运行时描述符与安装包所需的清单。
 * 每个阶段都经由 `packagingStep` 执行，其耗时与结果会记入打包运行证据目录
 * （`DSH_DESKTOP_PACKAGING_RUN_DIR`）；任一阶段失败都会在删除半成品输出树后
 * 以非零退出码终止整轮打包。
 */

import { createDesktopRuntimeBuildRoot } from './desktop-runtime-build-root.mjs'
import { resolveMacOSSignatureCacheDirectory } from './macos-signature-cache-directory.mjs'
import { packagingStep } from './packaging-step.mjs'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, relative, resolve } from 'node:path'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { prepareRuntimeManifests } from './prepare-runtime-manifests.ts'
import { prepareRuntimePatches, verifyRuntimePatches } from './prepare-runtime-patches.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
  resolveNpmRegistry,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
// 每轮构建专用的 scratch 根目录，pnpm 工作区在此解析运行时依赖图。目录固定在
// 仓库与系统临时目录之外的账户级位置（`desktopRuntimeBuildRoot`，可被
// `DSH_DESKTOP_RUNTIME_BUILD_ROOT` 覆盖），mkdtemp 的随机目录名隔离并发构建，
// `main` 的 finally 块保证脚本结束时删除它。注意：这棵 scratch 树正是本机企业
// 端点安全软件拦截 pnpm store 写入的观测点——此处被拒会让整轮打包以非零退出
// 码失败。
const BUILD_ROOT = createDesktopRuntimeBuildRoot(process.env)
// 支撑 `BUILD_ROOT` 的 pnpm 内容寻址 store。它放在每轮 scratch 根内（而非用户级
// store），使 lockfile-only 与 frozen install 不读也不写本轮之外的任何缓存。
const STORE_ROOT = join(BUILD_PATHS.dshPnpm, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const PNPM = join(RUNTIME_ROOT, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')

/** 读取包清单中的 `version`，缺失或非字符串即抛错。 */
function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

/**
 * 解析绑定进运行时描述符的发布身份。
 *
 * 桌面应用与 `@deepseek-ai/dsh` 根清单必须携带同一版本号：打包的 Electron
 * 二进制只内嵌一个 dsh 发布版本，版本不一致会让运行时与应用对宿主协议和包
 * 集合的认知相矛盾。Node/pnpm 版本取自已就绪的 runtime payload
 * （`versions.json`），使描述符与实际解压内容一致。
 * @returns 供 `writeDesktopRuntime` 与验证步骤使用的发布描述符。
 * @throws 两份清单的 `version` 不一致，或任一清单缺少版本时抛出。
 */
function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

/**
 * 在以 `BUILD_ROOT` 为根的运行时工作区上执行一条 pnpm 命令。
 *
 * pnpm 运行在打包的 Electron 二进制（`NODE`）而非系统 Node 之下，使依赖图的
 * 解析引擎与安装包内实际搭载的引擎一致；`--expose-internals` 是必需的，因为
 * pnpm CLI 依赖 Electron 默认隐藏的 Node 内部模块。store 被固定到
 * `STORE_ROOT` 并禁用全局 virtual store，因此本轮 scratch 树之外的任何内容
 * 都不会被读写。`userconfig` 指向一个新建的空文件：pnpm 要求该选项指向已存
 * 在的文件，而空文件保证宿主机的 `.npmrc`（registry 镜像、token、代理）不会
 * 泄漏进运行时解析。env 是重建而非整体继承：`NODE_OPTIONS`/`NODE_PATH` 可能
 * 劫持加载器，`DSH_DESKTOP_*` 是外层打包进程的配置、不得再进入运行时构建，
 * `npm_*`/`pnpm_*`/`corepack_*`（含 `npm_config_*` 形态）会覆盖下面的显式
 * config 旗标。`NPM_CONFIG_*` 把已解析的 registry/store/userconfig 重新声明
 * 给 pnpm 的 npm 兼容层，`desktopNodeEnvironment` 把引擎路径固定到本运行时，
 * `PATH` 优先 runtime 的 `bin` 目录，`XDG_*` 把 pnpm 的 cache/config/state
 * 重定向进 `PNPM_BUILD_STATE`，避免落入用户 profile。
 * @param args pnpm 子命令及其参数，例如 `['install', '--lockfile-only']`。
 * @returns pnpm 以退出码 0 结束时兑现。
 * @throws 进程无法启动，或以非零码/被信号终止时拒绝；消息携带退出码或信号。
 */
function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const registry = resolveNpmRegistry(process.env)
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      '--expose-internals',
      PNPM,
      `--config.registry=${registry}`,
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        ...desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), {}),
        PATH: `${join(RUNTIME_ROOT, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * 逐阶段构建生产运行时树。每个 `packagingStep` 把耗时与结果写入打包运行证据
 * 目录，首个失败阶段会在 `rmSync` 删除 `DSH_OUTPUT_ROOT` 后令整个脚本失败，
 * 因此失败的运行不会给安装阶段留下半成品运行时树。阶段顺序：重置 scratch
 * 状态，暂存 package set 与 runtime patches，解析 lockfile，对照核心包集合
 * 校验，frozen 安装生产依赖，把按平台过滤后的 `node_modules`（含 LibreOffice
 * 引擎的平台选择）材料化到 `DSH_OUTPUT_ROOT`，写入运行时清单与描述符，并在
 * 端到端 runtime smoke 之前与之后各做一次验证（传入 `--defer-runtime-smoke`
 * 可跳过 smoke）。仅在未显式 unsigned 的 macOS 运行中，材料化与 manifests 之
 * 间插入代码签名阶段。`finally` 块无论成败都会删除 `BUILD_ROOT` 与
 * `PNPM_BUILD_STATE`，scratch 树与 pnpm 状态不会活过本脚本。
 */
async function main(): Promise<void> {
  try {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:reset', async () => {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
      rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
      mkdirSync(STORE_ROOT, { recursive: true })
    })
    const release = desktopRelease()
    const patches = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:stage-packages', async () => {
      copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
      cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
      createRuntimeProjectMetadata(BUILD_ROOT, release)
      return prepareRuntimePatches(BUILD_ROOT, resolve(APP_ROOT, '..', '..'))
    })
    // 仅解析并锁定依赖图（lockfile-only），不安装：lockfile 随后要经过核心包
    // 集合校验，校验通过才允许 frozen 安装。
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:lockfile', () => runPnpm(['install', '--lockfile-only']))
    verifyRuntimePatches(BUILD_ROOT, patches)
    // lockfile 是运行时供应链的契约：逐项对照 package set 的名称与版本，防止
    // vendor tarball 与解析结果漂移；不一致即中止，绝不停用校验继续安装。
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    // 依赖图既已锁定且校验通过，frozen 安装必须逐字节复现 lockfile。
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:install', () => runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile']))
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: desktopTargetPlatform(targetName).arch }
    const modules = join(BUILD_ROOT, 'node_modules')
    // LibreOffice 引擎按目标平台从 kit 清单中选定，材料化时只保留该引擎的文件。
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    // 复制整棵解析完成的 node_modules；desktopRuntimeFileExclusion 对每个文件
    // 做平台/引擎裁剪（返回 undefined 表示保留），符号链接就地解引用。
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:materialize-modules', async () => {
      cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
        recursive: true, dereference: true,
        filter: source => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
      })
    })
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    // 私有 Host 运行时文件与选定的 LibreOffice 引擎是安装包的硬性成分：缺失
    // 说明材料化或版本绑定出了错，宁可失败也不能发出残缺运行时。
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    // 代码签名仅适用于 macOS 分发（darwin 且未显式 unsigned）；Windows 与
    // unsigned 运行天然跳过，无对应签名阶段。
    if (process.platform === 'darwin' && process.env.DSH_DESKTOP_UNSIGNED !== '1') {
      const cacheDirectory = resolveMacOSSignatureCacheDirectory(process.env, BUILD_PATHS.root)
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:dsh-native', () => signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:primary-native', () => signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory, 'primary'))
    }
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:primary-smoke', async () => smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime')))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:write-descriptor', async () => writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target))
    // verify-before-smoke 静态校验输出树内容与描述符一致；runtime:smoke 随后
    // 用打包内引擎真实启动该树并跑端到端冒烟，二者分别守护"写对了"与"能跑"。
    // 传 --defer-runtime-smoke 的调用方（如安装后首启验证）自行承担 smoke 责任。
    const descriptor = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-before-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    if (!process.argv.includes('--defer-runtime-smoke')) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:smoke', () => smokePreparedRuntime(DSH_OUTPUT_ROOT, NODE, RUNTIME_ROOT, descriptor))
      // smoke 会改动运行时树内的状态，跑完必须再验一次内容完整性。
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-after-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    }
  } catch (error) {
    // 失败的运行不能给安装阶段留下半成品运行时树；scratch 根由 finally 处理。
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    // scratch 根与 pnpm 状态都是每轮专用的：即使某阶段失败或清理本身被中途
    // 打断也要删除（`cleaned` 守卫避免 step 与兜底逻辑重复执行）。
    let cleaned = false
    const cleanup = (): void => {
      try { rmSync(BUILD_ROOT, { recursive: true, force: true }) }
      finally { rmSync(PNPM_BUILD_STATE, { recursive: true, force: true }) }
      cleaned = true
    }
    try { await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:cleanup', async () => cleanup()) }
    finally { if (!cleaned) cleanup() }
  }
}

await main()
