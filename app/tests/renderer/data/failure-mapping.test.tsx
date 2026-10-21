import { describe, expect, it } from 'vitest'
import {
  EMPTY_REASON_KEYS,
  emptyListToViewState,
  failureToViewState,
  isValidationError,
} from '../../../src/renderer/data/failureMapping.ts'
import { translate } from '../../../src/renderer/i18n/index.ts'
import { fakeFailure } from './fake-api.ts'

const t = (key: Parameters<typeof translate>[1]) => translate('zh', key)

describe('ApiFailure → ViewState 映射', () => {
  it('TASK_NOT_FOUND 映射为空态而非错误', () => {
    const state = failureToViewState(fakeFailure('TASK_NOT_FOUND', '任务不存在'), {
      emptyHint: '返回列表',
    })
    expect(state.status).toBe('empty')
    if (state.status !== 'empty') throw new Error('unreachable')
    expect(state.reason).toBe('任务不存在')
    expect(state.hint).toBe('返回列表')
    expect(isValidationError(state)).toBe(false)
  })

  it('CROSS_PROJECT_DENIED 映射为 denied', () => {
    const state = failureToViewState(fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝'))
    expect(state.status).toBe('denied')
    if (state.status !== 'denied') throw new Error('unreachable')
    expect(state.code).toBe('CROSS_PROJECT_DENIED')
  })

  it('INVALID_ARGUMENT 映射为表单错误（非系统错误）', () => {
    const state = failureToViewState(
      fakeFailure('INVALID_ARGUMENT', 'status 非法', { field: 'status' }),
    )
    expect(state.status).toBe('error')
    if (state.status !== 'error') throw new Error('unreachable')
    expect(state.kind).toBe('validation')
    expect(state.field).toBe('status')
    expect(isValidationError(state)).toBe(true)
  })

  it('INTERNAL_ERROR 映射为系统错误且不可重试', () => {
    const state = failureToViewState(fakeFailure('INTERNAL_ERROR', '服务不可用'))
    expect(state.status).toBe('error')
    if (state.status !== 'error') throw new Error('unreachable')
    expect(state.kind).toBe('system')
    expect(state.retryable).toBe(false)
    expect(isValidationError(state)).toBe(false)
  })

  it('空列表使用 reason 文案与服务端 hint', () => {
    const state = emptyListToViewState<readonly never[]>(
      { items: [], empty: true, reason: 'no_tasks', hint: '前往会话流派发任务。' },
      t,
    )
    expect(state.status).toBe('empty')
    if (state.status !== 'empty') throw new Error('unreachable')
    expect(state.reason).toBe(translate('zh', EMPTY_REASON_KEYS.no_tasks))
    expect(state.hint).toBe('前往会话流派发任务。')
  })
})
