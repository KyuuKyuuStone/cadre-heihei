/** ADR-0019 supervisor 判定：内存实现（prototypeOnly 静态 resolver）。 */
import { InMemoryTaskLedger, PrototypeOnlySupervisorResolver } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { runSupervisorContract, P1 } from './supervisor-shared.ts'

runSupervisorContract('memory', (options) => {
  let tick = 0
  let id = 0
  const ledger = new InMemoryTaskLedger({
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
    newId: () => `adr-mem-${++id}`,
    supervisorResolver:
      options.supervisorResolver ??
      new PrototypeOnlySupervisorResolver(
        options.supervisors.map((sessionId) => ({ projectId: P1, sessionId })),
      ),
  })
  return { ledger, close() {} }
})
