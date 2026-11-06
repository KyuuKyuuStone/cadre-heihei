/** Loopback requests must not inherit the system proxy used by the default session. */
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  setProxy: vi.fn(),
}))

vi.mock('electron', () => ({ session: { fromPartition: state.fromPartition } }))

import { LOOPBACK_SESSION_PARTITION, openLoopbackSession } from '../src/loopback-session.ts'

it('opens a dedicated in-memory session with a direct proxy and no HTTP cache', async () => {
  const loopback = { setProxy: state.setProxy }
  state.fromPartition.mockReturnValue(loopback)
  state.setProxy.mockResolvedValue(undefined)
  await expect(openLoopbackSession()).resolves.toBe(loopback)
  expect(state.fromPartition).toHaveBeenCalledWith(LOOPBACK_SESSION_PARTITION, { cache: false })
  expect(state.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
})
