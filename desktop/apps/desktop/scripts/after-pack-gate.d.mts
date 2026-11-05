/** Environment surface the afterPack hook reads from one electron-builder context. */
export interface AfterPackContext {
  readonly appOutDir: string
  readonly packager: { readonly getResourcesDir: (appOutDir: string) => string }
}

/** Collaborators the config factory binds from its scope when building the gate. */
export interface AfterPackGateDeps {
  /** macOS-only updater-config writer; omitted on other platforms or without an update feed. */
  readonly writeMacOSAppUpdate?: ((resourcesDir: string, context: AfterPackContext) => Promise<void>) | undefined
  /** Packaged runtime tree verification; rejects on any inconsistency. */
  readonly verifyDesktopRuntime: (
    runtimeRoot: string,
    expectedRuntimeVersion: string,
    options: { readonly platform: string, readonly arch: string },
  ) => Promise<void>
  /** Unsigned-Windows asar-unpack verification; omitted elsewhere. */
  readonly verifyWindowsAsarUnpack?: ((runtimeRoot: string, resourcesDir: string, windowsCode: unknown) => Promise<void>) | undefined
  /** Prepared dsh tree root the runtime verification checks. */
  readonly runtimeRoot: string
  /** Version the packaged runtime must declare. */
  readonly expectedRuntimeVersion: string
  /** Resolved target platform. */
  readonly platform: string
  /** Resolved target architecture. */
  readonly arch: string
  /** Reads the asar-unpack evidence captured during beforePack at hook-call time. */
  readonly getWindowsCode?: (() => unknown) | undefined
  /** Output sink; defaults to the console adapters. */
  readonly log?: { readonly error: (...values: unknown[]) => void, readonly info: (...values: unknown[]) => void } | undefined
}

/**
 * Count the object-literal-level declarations of one key in a source text.
 * @param source - Full source text of the factory module.
 * @param key - Object key to count, for example `afterPack`.
 * @returns Declaration count at line-anchor level.
 */
export function countObjectKeyDeclarations(source: string, key: string): number

/**
 * Fail unless `key` is declared exactly once in the factory source.
 * @param source - Full source text of the factory module.
 * @param key - Object key that must be declared exactly once.
 * @param label - Module label named in the failure message.
 * @returns Nothing; throws when the declaration count differs from one.
 */
export function assertObjectKeyDeclaredOnce(source: string, key: string, label: string): void

/**
 * Build the single afterPack hook: secret-like content fails the run first,
 * the packaged runtime tree is verified only on a clean scan, and any failure
 * aborts packaging.
 * @param deps - Collaborators the config factory binds from its scope.
 * @returns The hook electron-builder awaits after packing.
 */
export function createAfterPackGate(deps: AfterPackGateDeps): (context: AfterPackContext) => Promise<void>
