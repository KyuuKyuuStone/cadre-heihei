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
