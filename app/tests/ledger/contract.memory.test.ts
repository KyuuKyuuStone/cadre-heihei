/** 台账契约：内存实现。 */
import { InMemoryTaskLedger, PrototypeOnlySupervisorResolver } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { runLedgerContract, P1, P2, SUP } from './contract-shared.ts'

runLedgerContract('memory', () => {
  let tick = 0
  let id = 0
  const ledger = new InMemoryTaskLedger({
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
    newId: () => `mem-id-${++id}`,
    // prototypeOnly（ADR-0019）：测试显式注册 supervisor。
    supervisorResolver: new PrototypeOnlySupervisorResolver([
      { projectId: P1, sessionId: SUP },
      { projectId: P2, sessionId: SUP },
    ]),
  })
  return { ledger, close() {} }
})
