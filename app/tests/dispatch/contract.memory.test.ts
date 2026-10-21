/** 派活/汇报契约：内存实现。 */
import { InMemoryDispatchService } from '../../src/collab/dispatch/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { runDispatchContract } from './contract-shared.ts'
import { TEST_MEMBERS } from './test-support.ts'

runDispatchContract('memory', () => {
  let tick = 0
  let id = 0
  const now = (): IsoTimestamp =>
    new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
  const newId = (): string => `mem-dispatch-${++id}`
  const service = new InMemoryDispatchService({
    now,
    newId,
    serverVersion: 'test-server',
    members: TEST_MEMBERS,
  })
  return { service, close() {} }
})
