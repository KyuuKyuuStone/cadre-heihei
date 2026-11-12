/** User-authorized downloads and separate installation of one version-bound Desktop release. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, type AuthInfo } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { gt, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'

const { autoUpdater } = electronUpdater

/** Owns one updater target until its download and installation settle. */
export class DesktopUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private candidate: string | undefined
  private downloaded = false
  private disposed = false
  private checkOperation: Promise<DesktopUpdateState> | undefined
  /** Latest abandoned check whose updater promise may still settle; it blocks retries until it does. */
  private stalledCheck: Promise<DesktopUpdateState> | undefined
  /** Identifies the check allowed to publish, so an abandoned one cannot apply its late result. */
  private checkEpoch = 0
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.downloadOperation === undefined || this.downloaded) return
    const percent = Math.min(100, Math.max(0, progress.percent))
    this.setState({ phase: percent >= 100 ? 'verifying' : 'downloading', ...this.target(), percent })
  }

  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.downloadOperation === undefined || info.version !== this.candidate) return
    this.downloaded = true
  }

  private readonly onError = (error: Error): void => {
    // Check/download promises own their failures. Installation can fail after quitAndInstall returns.
    if (this.current.phase === 'installing') {
      this.setState(this.failure(error, 'install'))
    }
  }

  /**
   * Answer an authenticating-proxy challenge so the request fails instead of waiting for credentials
   * nobody supplies: the app has no interactive credential prompt for updater transport.
   * @param _authInfo - Proxy challenge details; no credential source is configured.
   * @param callback - Electron credential callback; empty credentials cancel the request.
   */
  private readonly onLogin = (_authInfo: AuthInfo, callback: (username: string, password: string) => void): void => {
    callback('', '')
  }

  /**
   * @param publish - Receives observable states for every Desktop window.
   * @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
   * @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
   * @param enabled - Whether this process has a packaged update source.
   * @param currentVersion - Actual installed application version.
   * @param channel - Installed package channel; omitted test/local callers retain nightly.
   * @param downloadResult - Once per completed download attempt, including platform preparation failures.
   * @param checkDeadlineMs - Total budget for one check, spanning config resolution, retries, and transport;
   *   the transport idle deadline bounds only a single request.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<boolean>,
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    private readonly currentVersion: () => string = () => app.getVersion(),
    private readonly downloadResult?: (success: boolean, reason?: string) => void,
    private readonly channel: 'nightly' | 'latest' = 'nightly',
    private readonly checkDeadlineMs: number = Number(process.env.DSH_DESKTOP_UPDATE_CHECK_DEADLINE_MS ?? 20_000),
  ) {
    if (!Number.isSafeInteger(checkDeadlineMs) || checkDeadlineMs < 1000 || checkDeadlineMs > 2_147_483_647) {
      throw new Error('desktop update: check deadline must be an integer from 1000 through 2147483647')
    }
    if (updater === autoUpdater) {
      // electron-updater omits this internal transport property from its public declarations.
      // Real-Electron qualification exercises the pinned dependency integration.
      const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
      transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(
        Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
        (authInfo, callback) => { updater.emit('login', authInfo, callback) },
      )
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.channel = channel
    this.updater.allowPrerelease = channel === 'nightly'
    // Selecting a channel can enable downgrade in electron-updater.
    this.updater.allowDowngrade = false
    this.updater.on('download-progress', this.onProgress)
    this.updater.on('update-downloaded', this.onDownloaded)
    this.updater.on('error', this.onError)
    this.updater.on('login', this.onLogin)
  }

  /** Latest observable state; complete download identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /**
   * Check metadata without downloading, joining any current check.
   * @param manual - Whether a failed check must remain visible in the status indicator.
   * @returns The check result, including a silent automatic failure when applicable.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloadOperation !== undefined || this.installOperation !== undefined || this.downloaded) return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    const stalled = this.stalledCheck === undefined ? undefined : this.failure(new Error(
      'desktop update: the previous check did not finish and still holds the updater'), 'check')
    if (stalled !== undefined) {
      // Re-running would await the same unsettled updater promise, so report the stalled attempt instead.
      if (manual) this.setState(stalled)
      return stalled
    }
    this.checkOperation ??= this.startCheck()
    const result = await this.settleCheck(this.checkOperation)
    if (manual && result.phase === 'error') this.setState(result)
    return result
  }

  /** Start one check whose result may publish only while this epoch stays current. */
  private startCheck(): Promise<DesktopUpdateState> {
    const epoch = ++this.checkEpoch
    const operation: Promise<DesktopUpdateState> = Promise.resolve().then(() => this.doCheck(epoch))
      .finally(() => {
        if (this.checkOperation === operation) this.checkOperation = undefined
      })
    return operation
  }

  /**
   * Wait for one check within the total budget.
   * @param operation - Shared check whose updater promise may never settle.
   * @returns Its result, or a deadline failure that leaves the stalled attempt latched.
   */
  private async settleCheck(operation: Promise<DesktopUpdateState>): Promise<DesktopUpdateState> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => { resolve('deadline') }, this.checkDeadlineMs)
    })
    try {
      const settled = await Promise.race([operation, deadline])
      if (settled !== 'deadline') return settled
      this.abandonCheck(operation)
      return this.failure(Object.assign(new Error('Desktop update check did not finish within the deadline'),
        { code: 'ETIMEDOUT' }), 'check')
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param operation - Unsettled check that keeps `CheckForUpdatesPromise` occupied inside electron-updater.
   */
  private abandonCheck(operation: Promise<DesktopUpdateState>): void {
    if (this.checkOperation === operation) this.checkOperation = undefined
    this.checkEpoch++
    this.stalledCheck = operation
    // The library promise stays pending; only its settlement may reopen checking.
    void operation.finally(() => {
      if (this.stalledCheck === operation) this.stalledCheck = undefined
    })
  }

  /**
   * @param version - Version shown in the user's download confirmation.
   * @returns Download readiness or failure, without authorizing installation.
   */
  async download(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloaded || this.installOperation !== undefined) return this.current
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      this.assertLive()
      if (this.candidate === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
      this.setState({ phase: 'downloading', version, percent: 0 })
      try {
        await this.updater.downloadUpdate()
        if (!this.downloaded) throw new Error('desktop update: platform preparation did not report readiness')
        this.downloadResult?.(true)
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        this.downloaded = false
        this.downloadResult?.(false, error instanceof DesktopUpdatePreparationError ? error.kind : 'download_failed')
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Install a prepared target after a separate user confirmation.
   * @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
   * @returns Installation handoff or a recoverable preparation error.
   */
  async install(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (!this.downloaded || this.downloadOperation !== undefined || version !== this.candidate) throw new Error('desktop update: confirmed target is not ready')
    this.installOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'installing', version })
      try {
        if (!await this.beforeRestart()) return this.setState({ phase: 'ready', version })
        this.assertLive()
        this.updater.quitAndInstall(true, true)
        return this.current
      } catch (error) {
        if (this.current.phase === 'error' && this.current.failedOperation === 'install') return this.current
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
  dispose(): void {
    this.disposed = true
    this.updater.off('download-progress', this.onProgress)
    this.updater.off('update-downloaded', this.onDownloaded)
    this.updater.off('login', this.onLogin)
    // Pending updater promises can still emit EventEmitter errors during shutdown.
    void Promise.allSettled([this.checkOperation, this.stalledCheck, this.downloadOperation, this.installOperation])
      .then(() => { this.updater.off('error', this.onError) })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    return { phase: 'error', ...this.target(), failedOperation,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : {}) }
  }

  private target(): { version?: string } {
    return this.candidate === undefined ? {} : { version: this.candidate }
  }

  /**
   * @param epoch - Check generation allowed to publish its outcome.
   * @returns The published state, or the current state when an abandoned check only settles late.
   */
  private async doCheck(epoch: number): Promise<DesktopUpdateState> {
    try {
      this.assertLive()
      if (!this.enabled()) throw new Error('desktop update: this application has no packaged update source')
      const result = await this.updater.checkForUpdates()
      if (result === null) throw new Error('desktop update: no check result was returned')
      const version = result.updateInfo.version
      if (valid(version) === null) throw new Error('desktop update: feed version is invalid')
      if (this.channel === 'latest' && version.includes('-')) throw new Error('desktop update: latest feed contains a prerelease')
      if (epoch !== this.checkEpoch) return this.current
      this.candidate = result.isUpdateAvailable && gt(version, this.currentVersion()) ? version : undefined
      return this.setState(this.candidate === undefined ? { phase: 'idle' } : { phase: 'available', version })
    } catch (error) {
      return this.failure(error, 'check')
    }
  }
}
