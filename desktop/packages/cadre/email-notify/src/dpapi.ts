/**
 * Windows DPAPI fallback for hosts where Electron's safeStorage module cannot
 * be loaded. PowerShell receives the secret on stdin and the script through
 * -EncodedCommand, so no plaintext appears in the command line.
 * @module
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Encrypt/decrypt seam used by the secret store. */
export interface DpapiPort {
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

const POWERSHELL_TIMEOUT_MS = 15_000

const ENCRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$value = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($value)',
  '$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($enc))',
].join('\n')

const DECRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$encoded = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($encoded)',
  '$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))',
].join('\n')

/** Resolve the Windows PowerShell executable without relying on PATH. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot?.trim() || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Run one DPAPI script; the secret/ciphertext is written to stdin. */
function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded(script),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | undefined, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve(value ?? '')
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('DPAPI PowerShell 超时'))
    }, POWERSHELL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8 * 1024) stderr += chunk.toString('utf8') })
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (code === 0) finish(undefined, stdout.trim())
      else finish(new Error(`DPAPI PowerShell 失败（exit ${String(code)}）${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 500)}`}`))
    })
    child.stdin.on('error', error => finish(error))
    child.stdin.end(stdin)
  })
}

/** DPAPI provider backed by PowerShell ProtectedData under the current user. */
export class PowerShellDpapi implements DpapiPort {
  async encrypt(value: string): Promise<Buffer> {
    const text = await runPowerShell(ENCRYPT_SCRIPT, value)
    if (text === '') throw new Error('DPAPI 加密没有返回密文')
    return Buffer.from(text, 'base64')
  }

  async decrypt(value: Buffer): Promise<string> {
    return runPowerShell(DECRYPT_SCRIPT, value.toString('base64'))
  }
}
