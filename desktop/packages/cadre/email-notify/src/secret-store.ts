/**
 * Encrypted per-project mailbox authorization codes. Providers are tried in
 * order: Electron safeStorage, then Windows DPAPI through PowerShell. The file
 * is the raw provider ciphertext, so existing safeStorage files keep working.
 * Plaintext is never written or returned.
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PowerShellDpapi } from './dpapi.ts'
import type { DpapiPort } from './dpapi.ts'
import { redactSecret } from './sendgrid.ts'

/** Minimal safeStorage surface; tests inject this. */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Stable failure for missing/non-encrypting platforms. */
export class SecretStoreUnavailableError extends Error {
  readonly code = 'SECRET_STORE_UNAVAILABLE'
  constructor(message = 'safeStorage 与 Windows DPAPI 均不可用，无法安全保存邮件授权码') {
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
    if (safeStorage === undefined) throw new SecretStoreUnavailableError('Electron safeStorage 不存在')
    if (!safeStorage.isEncryptionAvailable()) throw new SecretStoreUnavailableError('safeStorage 加密不可用')
    return safeStorage
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new SecretStoreUnavailableError(`Electron safeStorage 加载失败: ${redactSecret(reason, '')}`)
  }
}

interface Cipher {
  readonly name: 'safeStorage' | 'dpapi'
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

function safeCipher(storage: SafeStoragePort): Cipher {
  return {
    name: 'safeStorage',
    async encrypt(value) {
      if (!storage.isEncryptionAvailable()) throw new Error('safeStorage 加密不可用')
      return storage.encryptString(value)
    },
    async decrypt(value) {
      return storage.decryptString(value)
    },
  }
}

function dpapiCipher(port: DpapiPort): Cipher {
  return { name: 'dpapi', encrypt: value => port.encrypt(value), decrypt: value => port.decrypt(value) }
}

type Log = (line: string) => void

/** Per-project encrypted auth-code store with provider fallback. */
export class EmailSecretStore {
  readonly #dir: string
  readonly #safeStorage: SafeStoragePort | undefined
  readonly #dpapi: DpapiPort | undefined
  readonly #platform: NodeJS.Platform
  readonly #log: Log

  constructor(options: {
    readonly dir?: string
    readonly safeStorage?: SafeStoragePort
    readonly dpapi?: DpapiPort
    readonly platform?: NodeJS.Platform
    readonly log?: Log
  } = {}) {
    this.#dir = options.dir ?? defaultSecretDir()
    this.#safeStorage = options.safeStorage
    this.#dpapi = options.dpapi
    this.#platform = options.platform ?? process.platform
    this.#log = options.log ?? (line => { console.info(line) })
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
    const encrypted = await this.#encrypt(authCode)
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

  /** Decrypt the stored auth code; tries every available provider. */
  async read(projectId: string): Promise<string | undefined> {
    const file = this.#file(projectId)
    if (!existsSync(file)) return undefined
    const encrypted = readFileSync(file)
    const reasons: string[] = []
    for (const cipher of await this.#candidates(reasons)) {
      try {
        const value = await cipher.decrypt(encrypted)
        this.#log(`[email-secret] provider=${cipher.name}`)
        return value
      } catch (error) {
        reasons.push(`${cipher.name}: ${this.#reason(error, '')}`)
      }
    }
    this.#log(`[email-secret] decrypt failed: ${reasons.join('; ')}`)
    throw new SecretStoreUnavailableError(`邮件授权码无法解密（${reasons.join('; ')}）；请重新保存`)
  }

  async #encrypt(value: string): Promise<Buffer> {
    const reasons: string[] = []
    for (const cipher of await this.#candidates(reasons)) {
      try {
        const encrypted = await cipher.encrypt(value)
        this.#log(`[email-secret] provider=${cipher.name}`)
        return encrypted
      } catch (error) {
        reasons.push(`${cipher.name}: ${this.#reason(error, value)}`)
      }
    }
    this.#log(`[email-secret] encrypt failed: ${reasons.join('; ')}`)
    throw new SecretStoreUnavailableError(`邮件授权码保存失败（${reasons.join('; ')}）`)
  }

  async #candidates(reasons: string[]): Promise<Cipher[]> {
    const candidates: Cipher[] = []
    try {
      const storage = this.#safeStorage ?? await loadSafeStorage()
      if (!storage.isEncryptionAvailable()) throw new Error('safeStorage 加密不可用')
      candidates.push(safeCipher(storage))
    } catch (error) {
      const reason = this.#reason(error, '')
      reasons.push(`safeStorage: ${reason}`)
      this.#log(`[email-secret] safeStorage unavailable: ${reason}`)
    }
    try {
      const port = this.#dpapi ?? (this.#platform === 'win32' ? new PowerShellDpapi() : undefined)
      if (port === undefined) throw new Error('Windows DPAPI 仅在 win32 可用')
      candidates.push(dpapiCipher(port))
    } catch (error) {
      const reason = this.#reason(error, '')
      reasons.push(`dpapi: ${reason}`)
      this.#log(`[email-secret] dpapi unavailable: ${reason}`)
    }
    return candidates
  }

  #reason(error: unknown, secret: string): string {
    const message = error instanceof Error ? error.message : String(error)
    return redactSecret(message, secret).slice(0, 300)
  }

  #file(projectId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(projectId) || projectId === '.' || projectId === '..') {
      throw new Error('EMAIL_SECRET_INVALID: project id is not a safe file name')
    }
    return join(this.#dir, `${projectId}.bin`)
  }
}
