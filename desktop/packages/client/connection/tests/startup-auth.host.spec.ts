/** Connection activation over recoverable browser-authentication state. */

import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  apply,
  inject,
  type ConnectionIndexRequest,
  type ConnectionIndexResponse,
  type HostConnectionHandle,
} from '../src/index.ts'
import { provideBrowserCredentials, RecordCredentials } from './browser-credentials.ts'

const AUTHORITY = '127.0.0.1:3080'

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function request(cookie?: string): ConnectionIndexRequest {
  return {
    method: 'GET',
    url: '/',
    headers: {
      host: AUTHORITY,
      ...cookie === undefined ? {} : { cookie },
    },
  }
}

/** Boot Connection with a credential provider and a route-recording Web carrier. */
async function boot(
  credentials: RecordCredentials,
  prepare?: (ctx: Context) => void,
): Promise<{
  ctx: Context
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  provideBrowserCredentials(ctx, credentials)
  prepare?.(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

/** Exchange the process token for the browser cookie. */
function login(connection: HostConnectionHandle): string {
  const target = new URL(connection.authenticatedUrl(`http://${AUTHORITY}`))
  const res = response()
  expect(connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: AUTHORITY },
  }, res.value)).toBe(false)
  const cookie = res.state.headers?.['set-cookie']?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('token exchange did not set a cookie')
  return cookie
}

/** Credential provider whose durable record operation is unavailable. */
class FailingCredentials extends RecordCredentials {
  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error('credential store unavailable'))
  }
}

describe('Connection startup with browser-authentication state', () => {
  it('starts without a credential record and serves a fresh browser cookie', async () => {
    const credentials = new RecordCredentials()
    const { connection, dispose } = await boot(credentials)
    try {
      expect(credentials.record).toMatchObject({ kind: 'grant', payload: { version: 1 } })
      expect(connection.admit(request(login(connection)))).toHaveProperty('peer')
    } finally { await dispose() }
  })

  it('starts with a cookie issued before the signing secret rotated', async () => {
    const credentials = new RecordCredentials()
    const first = await boot(credentials)
    const stale = login(first.connection)
    await first.dispose()

    credentials.record = {
      kind: 'grant',
      payload: { version: 1, secret: randomBytes(32).toString('base64url') },
    }
    const restarted = await boot(credentials)
    try {
      expect(restarted.connection.admit(request(stale))).toEqual({ rejection: 401 })
      expect(restarted.connection.admit(request(login(restarted.connection)))).toHaveProperty('peer')
    } finally { await restarted.dispose() }
  })

  it('starts by replacing a corrupt credential record and reports the repair', async () => {
    const credentials = new RecordCredentials()
    credentials.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    let warn: MockInstance | undefined
    const { connection, dispose } = await boot(credentials, (ctx) => {
      warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    })
    try {
      expect(credentials.record).toMatchObject({ kind: 'grant', payload: { version: 1 } })
      expect(connection.admit(request(login(connection)))).toHaveProperty('peer')
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn?.mock.calls[0]?.[0])).toContain('replaced')
    } finally { await dispose() }
  })

  it('starts with an in-memory secret when the credential record cannot be written', async () => {
    const credentials = new FailingCredentials()
    let warn: MockInstance | undefined
    const { connection, dispose } = await boot(credentials, (ctx) => {
      warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    })
    try {
      expect(credentials.record).toBeUndefined()
      expect(connection.admit(request(login(connection)))).toHaveProperty('peer')
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn?.mock.calls[0]?.[0])).toContain('in-memory signing secret')
    } finally { await dispose() }
  })
})
