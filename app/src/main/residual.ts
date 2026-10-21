/** 退出后 harness 残留进程统计（S9 口径：node + dsh/deepseek-harness）。 */
import { execFile } from 'node:child_process'

interface ProcessRow {
  readonly ProcessId?: unknown
  readonly Name?: unknown
  readonly CommandLine?: unknown
}

export function countHarnessRows(rows: readonly ProcessRow[]): number {
  return rows.filter((row) => {
    const name = String(row.Name ?? '')
    const command = String(row.CommandLine ?? '')
    return /^node(\.exe)?$/i.test(name) && /dsh|deepseek-harness/i.test(command)
  }).length
}

export function countHarnessProcesses(): Promise<number> {
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | " +
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) return resolve(-1)
        const text = stdout.trim()
        if (text === '') return resolve(0)
        try {
          const parsed = JSON.parse(text) as ProcessRow | ProcessRow[]
          return resolve(countHarnessRows(Array.isArray(parsed) ? parsed : [parsed]))
        } catch {
          return resolve(-1)
        }
      },
    )
  })
}
