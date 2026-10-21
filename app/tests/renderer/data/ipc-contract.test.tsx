import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_CHANNEL_VALUES } from '../../../src/shared/ipc.ts'
import {
  RENDERER_CHANNEL_USAGE,
  SESSION_EVENT_KINDS,
  SESSION_EVENT_KINDS_COMPLETE,
} from '../../../src/renderer/data/ipcContract.ts'

/** 契约文档 `frontend/02` §1 的通道字面量：三方（文档 / shared / renderer）对齐。 */
const DOCUMENTED_CHANNELS = {
  whoami: 'app:whoami',
  listTasks: 'collab:listTasks',
  getTask: 'collab:getTask',
  listRoster: 'collab:listRoster',
  sendMessage: 'session:send',
  subscribeSession: 'session:subscribe',
  unsubscribeSession: 'session:unsubscribe',
  sessionEvent: 'session:event',
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
} as const

describe('renderer ↔ shared IPC 契约一致性', () => {
  it('renderer 引用的通道与 IPC_CHANNELS 逐项相等', () => {
    for (const [key, channel] of Object.entries(RENDERER_CHANNEL_USAGE)) {
      expect(channel).toBe(IPC_CHANNELS[key as keyof typeof IPC_CHANNELS])
      expect(channel).toBe(DOCUMENTED_CHANNELS[key as keyof typeof DOCUMENTED_CHANNELS])
    }
  })

  it('renderer 引用的通道均属于 IPC_CHANNEL_VALUES', () => {
    const all = new Set<string>(IPC_CHANNEL_VALUES)
    for (const channel of Object.values(RENDERER_CHANNEL_USAGE)) {
      expect(all.has(channel)).toBe(true)
    }
  })

  it('SessionEvent kind 集合与 shared 类型穷尽一致', () => {
    // SESSION_EVENT_KINDS_COMPLETE 由 tsc 保证：shared 增删 kind 时该常量类型不再是 true。
    expect(SESSION_EVENT_KINDS_COMPLETE).toBe(true)
    expect([...SESSION_EVENT_KINDS]).toEqual([
      'message.delta',
      'message.complete',
      'tool.call',
      'tool.result',
      'compaction.start',
      'compaction.summary',
      'compaction.end',
      'session.error',
      'session.closed',
    ])
  })
})
