import { describe, it } from 'node:test'
import { expect } from '../assert-compat.ts'

import { describeApiFailure, technicalDetailFrom } from '../../../src/renderer/lib/apiErrorMessage.ts'
import { translate } from '../../../src/renderer/i18n/index.ts'

// 搬迁适配：前身通过 zustand store 设 locale；新测试直接绑定 zh，断言语义不变。
const translateKey = (key: Parameters<typeof translate>[1]) => translate('zh', key)

describe('describeApiFailure（v1.7.3 #320s 超时误导性报错）', () => {
  it('timeout 呈现为「任务可能仍在后台运行」的超时语义，而非业务失败', () => {
    const rendered = describeApiFailure('timeout', 'Request timed out after 320s', translateKey)
    // 语义断言：不得再出现「重试」类失败暗示，必须给「后台仍在跑/可查看」的出路
    expect(rendered).toBe(translateKey('api.error.timeout'))
    expect(rendered).not.toBe('Request timed out after 320s')
    expect(rendered).not.toContain('重试')
    expect(rendered).toContain('后台运行')
    // 出路：给「稍后刷新查看」
    expect(rendered).toContain('刷新')
  })

  it('非 timeout（network）仍走既有网络文案；business 契约原样直出', () => {
    const network = describeApiFailure('network', 'Failed to fetch', translateKey)
    expect(network).toBe(translateKey('api.error.network'))

    const business = 'Cross-project dispatch is not allowed: sender workDir could not be resolved'
    // KNOWN_SERVER_MESSAGES 表对 business 与 undefined 分支共享：已知串映射人话，
    // 未知串维持业务直出契约原样。
    const unknown = 'Some unknown business failure'
    expect(describeApiFailure('business', business, translateKey)).toBe(
      translateKey('api.error.crossProjectDispatch'),
    )
    expect(describeApiFailure(undefined, business, translateKey)).toBe(
      translateKey('api.error.crossProjectDispatch'),
    )
    expect(describeApiFailure('business', unknown, translateKey)).toBe(unknown)
    expect(describeApiFailure(undefined, unknown, translateKey)).toBe(unknown)
  })

  it('technicalDetailFrom：business 与 undefined 不补原始错误块；timeout 透出原串', () => {
    expect(technicalDetailFrom('business', '业务提示')).toBeUndefined()
    expect(technicalDetailFrom(undefined, 'raw')).toBeUndefined()
    expect(technicalDetailFrom('timeout', 'Request timed out after 320s')).toEqual({
      message: 'Request timed out after 320s',
      kind: 'timeout',
    })
  })
})
