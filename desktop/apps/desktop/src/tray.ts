/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */

import { Menu, nativeImage, Tray } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /** 按系统明暗解析多尺寸 ICO 路径；切换主题时重新调用。 */
  readonly resolveIconPath: (dark: boolean) => string
  /** 构造时的系统明暗，决定首个托盘图标。 */
  readonly dark: boolean
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined
  private dark: boolean

  /** @param options - Icon resolver, current shade, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    this.dark = options.dark
    const tray = new Tray(nativeImage.createFromPath(options.resolveIconPath(options.dark)))
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** 系统明暗切换时换版：纸色剪影用于深色任务栏，彩色印章用于浅色任务栏。 */
  setDark(dark: boolean): void {
    if (this.dark === dark) return
    this.dark = dark
    this.tray?.setImage(nativeImage.createFromPath(this.options.resolveIconPath(dark)))
  }

  /** Rebuild the tooltip and context menu in the current locale. */
  relabel(): void {
    const tray = this.tray
    if (tray === undefined) return
    const { messages } = this.options.locale()
    tray.setToolTip(messages.aboutProduct)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }
}
