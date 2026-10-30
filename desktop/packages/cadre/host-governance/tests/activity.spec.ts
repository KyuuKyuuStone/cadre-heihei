import { describe, expect, it } from 'vitest'
import { activityFrom, waitingQuestion, type ActivityEvent } from '../src/activity.ts'

const MIN = 60_000
const OLD = Date.UTC(2026, 9, 29, 0, 50, 0)
const NEW_TASK = Date.UTC(2026, 9, 29, 12, 36, 0)

function ask(callId: string, time: number): ActivityEvent {
  return { type: 'tool/call', time, data: { callId, name: 'ask_user_question' } }
}

function result(callId: string, time: number): ActivityEvent {
  return { type: 'tool/result', time, data: { callId } }
}

function activity(time: number): ActivityEvent {
  return { type: 'assistant/message', time, data: {} }
}

describe('windowed waiting_question', () => {
  it('ignores an unanswered question from a previous task window', () => {
    const events = [ask('old-ask', OLD), activity(OLD + MIN)]
    expect(waitingQuestion(events, NEW_TASK)).toBe(false)
    expect(activityFrom(events, NEW_TASK).waitingQuestion).toBe(false)
  })

  it('reports an unanswered question asked inside the current task window', () => {
    const events = [activity(NEW_TASK), ask('new-ask', NEW_TASK + MIN)]
    expect(waitingQuestion(events, NEW_TASK)).toBe(true)
  })

  it('does not report a question that has a matching result', () => {
    const events = [ask('answered', NEW_TASK + MIN), result('answered', NEW_TASK + 2 * MIN)]
    expect(waitingQuestion(events, NEW_TASK)).toBe(false)
  })

  it('reopens the window at rework, so a pre-rework unanswered ask no longer freezes', () => {
    const rework = NEW_TASK + 30 * MIN
    const events = [ask('old-ask', NEW_TASK + MIN), activity(rework)]
    expect(waitingQuestion(events, rework)).toBe(false)
    expect(waitingQuestion([...events, ask('rework-ask', rework + MIN)], rework)).toBe(true)
  })

  it('does not let a result for an old call mask a new unanswered call', () => {
    const events = [
      ask('old', OLD), result('old', OLD + MIN),
      ask('new', NEW_TASK + MIN),
    ]
    expect(waitingQuestion(events, NEW_TASK)).toBe(true)
  })
})

describe('three-state step projection', () => {
  it('reports model_generation for an open turn with a started model call', () => {
    const events: ActivityEvent[] = [
      { type: 'turn/received', time: NEW_TASK, data: { turn: 1 } },
      { type: 'model_call/started', time: NEW_TASK + MIN, data: { turn: 1, step: 1, provider: 'p', model: 'm' } },
    ]
    expect(activityFrom(events, NEW_TASK)).toMatchObject({
      stepKind: 'model_generation', stepSince: NEW_TASK + MIN,
    })
  })

  it('reports tool_execution for an unanswered tool call and no step after a turn closes', () => {
    const events: ActivityEvent[] = [
      { type: 'turn/received', time: NEW_TASK, data: { turn: 1 } },
      { type: 'tool/call', time: NEW_TASK + 2 * MIN, data: { callId: 'c1', name: 'docx_build' } },
    ]
    expect(activityFrom(events, NEW_TASK)).toMatchObject({
      stepKind: 'tool_execution', stepSince: NEW_TASK + 2 * MIN, toolName: 'docx_build',
    })
    const closed: ActivityEvent[] = [
      ...events,
      { type: 'turn/aborted', time: NEW_TASK + 3 * MIN, data: { turn: 1, reason: { kind: 'aborted', reason: 'x' }, hadFirstToken: false } },
      { type: 'turn/end', time: NEW_TASK + 3 * MIN, data: { turn: 1, reason: { kind: 'aborted', reason: 'x' } } },
    ]
    expect(activityFrom(closed, NEW_TASK).stepKind).toBeUndefined()
  })

  it('derives first token, usage and evidence seq from the active step', () => {
    const events: ActivityEvent[] = [
      { type: 'turn/received', time: NEW_TASK, seq: 1, data: { turn: 1 } },
      { type: 'model_call/started', time: NEW_TASK + MIN, seq: 2, data: { turn: 1, step: 1, provider: 'p', model: 'm' } },
      { type: 'model_call/first_token', time: NEW_TASK + MIN + 1000, seq: 3, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: NEW_TASK + 2 * MIN, seq: 4, data: { usage: { outputTokens: 12 } } },
    ]
    expect(activityFrom(events, NEW_TASK)).toMatchObject({
      stepKind: 'model_generation',
      firstTokenAt: NEW_TASK + MIN + 1000,
      tokensSoFar: 12,
      evidenceEventSeq: 3,
    })
  })

  it('marks an open compaction window', () => {
    const events: ActivityEvent[] = [
      { type: 'compaction/start', time: NEW_TASK, data: {} },
      { type: 'compaction/summary', time: NEW_TASK + MIN, data: {} },
    ]
    expect(activityFrom(events, NEW_TASK).compactionActive).toBe(true)
    events.push({ type: 'compaction/end', time: NEW_TASK + 2 * MIN, data: {} })
    expect(activityFrom(events, NEW_TASK).compactionActive).toBeUndefined()
  })
})
