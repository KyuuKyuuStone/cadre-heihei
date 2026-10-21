/** 台账契约：内存实现。 */
import { InMemoryTaskLedger } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { runLedgerContract } from './contract-shared.ts'

runLedgerContract('memory', () => {
  let tick = 0
  let id = 0
  const ledger = new InMemoryTaskLedger({
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
    newId: () => `mem-id-${++id}`,
  })
  return { ledger, close() {} }
})
