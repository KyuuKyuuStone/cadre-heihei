/** Pick the tray bitmap that stays visible on the current Windows taskbar shade. */

import { join } from 'node:path'

/** Inputs resolved at the call site so the choice is testable without Electron. */
export interface TrayIconPathOptions {
  /** Whether the system currently uses its dark color scheme. */
  readonly dark: boolean
  /** Unpackaged dev run reads from the project's `resources/`. */
  readonly development: boolean
  /** `app.getAppPath()` for the development path. */
  readonly appPath: string
  /** `process.resourcesPath` for the packaged path. */
  readonly resourcesPath: string
}

/**
 * `tray.ico` is the paper-colored silhouette for dark taskbars; `tray-light.ico`
 * is the colored seal for light taskbars. The two are not interchangeable: the
 * paper silhouette disappears on a paper-colored light taskbar.
 */
export function resolveTrayIconPath(options: TrayIconPathOptions): string {
  const file = options.dark ? 'tray.ico' : 'tray-light.ico'
  return options.development
    ? join(options.appPath, 'resources', file)
    : join(options.resourcesPath, file)
}
