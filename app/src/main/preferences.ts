/**
 * 偏好主存储（U-IPC-03：主进程为权威）。
 *
 * `InMemoryPreferencesStore` 供测试/单窗口；`FilePreferencesStore` 落 JSON，
 * 写入用临时文件 + rename，读失败回退默认值，不让偏好故障阻断启动。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_PREFERENCES,
  isPreferenceLocale,
  isPreferenceTheme,
  type Preferences,
  type PreferencesPatch,
} from '../shared/ipc.ts'

export interface PreferencesPort {
  get(): Preferences
  set(patch: PreferencesPatch): Preferences
}

function sanitize(value: unknown): Preferences {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_PREFERENCES }
  const record = value as Record<string, unknown>
  return {
    locale: isPreferenceLocale(record.locale) ? record.locale : DEFAULT_PREFERENCES.locale,
    theme: isPreferenceTheme(record.theme) ? record.theme : DEFAULT_PREFERENCES.theme,
  }
}

export class InMemoryPreferencesStore implements PreferencesPort {
  private current: Preferences

  constructor(initial: Preferences = DEFAULT_PREFERENCES) {
    this.current = sanitize(initial)
  }

  get(): Preferences {
    return { ...this.current }
  }

  set(patch: PreferencesPatch): Preferences {
    this.current = sanitize({ ...this.current, ...patch })
    return this.get()
  }
}

export class FilePreferencesStore implements PreferencesPort {
  private readonly filePath: string
  private readonly initial: Preferences
  private current: Preferences | undefined

  constructor(filePath: string, initial: Preferences = DEFAULT_PREFERENCES) {
    this.filePath = filePath
    this.initial = sanitize(initial)
  }

  get(): Preferences {
    if (this.current !== undefined) return { ...this.current }
    this.current = this.load()
    return { ...this.current }
  }

  set(patch: PreferencesPatch): Preferences {
    const next = sanitize({ ...this.get(), ...patch })
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temp, this.filePath)
    this.current = next
    return { ...next }
  }

  private load(): Preferences {
    if (!existsSync(this.filePath)) return { ...this.initial }
    try {
      return sanitize(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      return { ...this.initial }
    }
  }
}
