/**
 * Encrypted per-project mailbox authorization codes. Electron safeStorage
 * (DPAPI on Windows) is the only encryption provider; plaintext is never
 * written or returned.
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Minimal safeStorage surface; tests inject this. */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Stable failure for missing/non-encrypting platforms. */
export class SecretStoreUnavailableError extends Error {
  readonly code = 'SECRET_STORE_UNAVAILABLE'
  constructor(message = 'Electron safeStorage 不可用，无法安全保存邮件授权码') {
    super(message)
    this.name = 'SecretStoreUnavailableError'
  }
}

/** Default Windows path; other platforms use the user config root. */
export function defaultSecretDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA?.trim()
  return appData === undefined || appData === ''
    ? join(homedir(), '.config', 'Cadre', 'secrets', 'email')
    : join(appData, 'Cadre', 'secrets', 'email')
}

/** Resolve Electron safeStorage lazily so Node-only tests never import it. */
async function loadSafeStorage(): Promise<SafeStoragePort> {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { safeStorage?: SafeStoragePort }
    const safeStorage = electron.safeStorage
    if (safeStorage === undefined || !safeStorage.isEncryptionAvailable()) {
      throw new SecretStoreUnavailableError()
    }
    return safeStorage
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error
    throw new SecretStoreUnavailableError()
  }
}

/** Per-project encrypted auth-code store. */
export class EmailSecretStore {
  readonly #dir: string
  readonly #load: () => Promise<SafeStoragePort>

  constructor(options: {
    readonly dir?: string
    readonly safeStorage?: SafeStoragePort
  } = {}) {
    this.#dir = options.dir ?? defaultSecretDir()
    this.#load = options.safeStorage === undefined
      ? loadSafeStorage
      : async () => {
        if (!options.safeStorage!.isEncryptionAvailable()) throw new SecretStoreUnavailableError()
        return options.safeStorage!
      }
  }

  /** Reference persisted in project config; never the secret. */
  ref(projectId: string): string {
    return `smtp:${projectId}`
  }

  /** Whether an encrypted auth code exists for this project. */
  has(projectId: string): boolean {
    return existsSync(this.#file(projectId))
  }

  /** Write/replace one encrypted authorization code. */
  async set(projectId: string, authCode: string): Promise<void> {
    if (authCode.trim() === '') throw new Error('EMAIL_SECRET_EMPTY: auth code is empty')
    const storage = await this.#load()
    let encrypted: Buffer
    try {
      encrypted = storage.encryptString(authCode)
    } catch {
      throw new SecretStoreUnavailableError('邮件授权码加密失败')
    }
    mkdirSync(this.#dir, { recursive: true })
    const target = this.#file(projectId)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, encrypted)
    renameSync(temporary, target)
  }

  /** Remove one stored auth code; absent is a no-op. */
  clear(projectId: string): void {
    rmSync(this.#file(projectId), { force: true })
  }

  /** Decrypt the stored auth code; throws when the store is unavailable. */
  async read(projectId: string): Promise<string | undefined> {
    const file = this.#file(projectId)
    if (!existsSync(file)) return undefined
    const storage = await this.#load()
    try {
      return storage.decryptString(readFileSync(file))
    } catch {
      throw new SecretStoreUnavailableError('邮件授权码无法解密；请重新保存')
    }
  }

  #file(projectId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(projectId) || projectId === '.' || projectId === '..') {
      throw new Error('EMAIL_SECRET_INVALID: project id is not a safe file name')
    }
    return join(this.#dir, `${projectId}.bin`)
  }
}
