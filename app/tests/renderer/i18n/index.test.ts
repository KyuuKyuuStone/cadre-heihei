// 从 cc-heihei v1.7.9（desktop/src/i18n/index.test.tsx）搬迁。
// 适配：去掉 React hook 用例（新 renderer 尚未引入 UI 框架，hook 未搬迁，
// 已登记到 MIGRATION.md 未适配项）；保留全部 translate 纯函数与边表机制断言。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { translate } from '../../../src/renderer/i18n/index.ts'
import { en } from '../../../src/renderer/i18n/locales/en.ts'
import { zh } from '../../../src/renderer/i18n/locales/zh.ts'
import { zh as zhTW } from '../../../src/renderer/i18n/locales/zh-TW.ts'
import { jp } from '../../../src/renderer/i18n/locales/jp.ts'
import { kr } from '../../../src/renderer/i18n/locales/kr.ts'
import { speechEn, speechJp, speechKr, speechZh, speechZhTW } from '../../../src/renderer/i18n/locales/speech.ts'
import {
  contextSourceEn,
  contextSourceJp,
  contextSourceKr,
  contextSourceZh,
  contextSourceZhTW,
} from '../../../src/renderer/i18n/locales/contextSource.ts'

const locales = { en, zh, 'zh-TW': zhTW, jp, kr }

describe('translate', () => {
  it('resolves every registered locale to its own translation', () => {
    assert.equal(translate('en', 'common.save'), 'Save')
    assert.equal(translate('zh', 'common.save'), '保存')
    assert.equal(translate('zh-TW', 'common.save'), '儲存')
    assert.equal(translate('jp', 'common.save'), '保存')
    assert.equal(translate('kr', 'common.save'), '저장')
  })

  it('interpolates params across the new locales', () => {
    assert.equal(translate('jp', 'session.timeMinutes', { n: 5 }), '5 分前')
    assert.equal(translate('kr', 'session.timeMinutes', { n: 5 }), '5분 전')
  })

  it('localizes agent failures in every registered locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      assert.notEqual(translate(locale, 'settings.agents.loadError'), 'settings.agents.loadError')
    }
  })

  it('describes exactly the standard ~/.claude mode and an external custom mode', () => {
    assert.ok(translate('en', 'settings.general.storageSystemDescription').includes('~/.claude'))
    assert.ok(translate('zh', 'settings.general.storageSystemDescription').includes('~/.claude'))
    assert.ok(translate('zh-TW', 'settings.general.storageSystemDescription').includes('~/.claude'))
    assert.ok(translate('jp', 'settings.general.storageSystemDescription').includes('~/.claude'))
    assert.ok(translate('kr', 'settings.general.storageSystemDescription').includes('~/.claude'))
    assert.ok(translate('en', 'settings.general.storagePortableTitle').includes('custom'))
    assert.ok(translate('zh', 'settings.general.storagePortableTitle').includes('自定义'))
  })

  // The installed-skills overview was dropped in b64069a3, but the UI rollback
  // right after it restored the locale files wholesale and carried its keys back
  // in. Every locale kept the same key count, so a parity check cannot see this.
  it('carries no key for the removed installed-skills overview', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(
        (key) => key.startsWith('market.installedSkills.') || key === 'market.section.installed',
      )
      assert.deepEqual(resurrected, [], `${name} still defines removed installed-skills keys`)
    }
  })

  // Index building/ready/off went silent: the sidebar no longer tells anyone
  // that history is being indexed. Keeping the strings around invites a future
  // change to wire them back into the UI, so they must stay deleted.
  it('carries no key for the silent index states', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(
        (key) => key.startsWith('sidebar.index') && key !== 'sidebar.indexDegraded',
      )
      assert.deepEqual(resurrected, [], `${name} still defines silent index-status keys`)
    }
  })

  it('keeps the five main tables at key parity', () => {
    const baseline = Object.keys(en).sort()
    for (const [name, locale] of Object.entries(locales)) {
      assert.deepEqual(Object.keys(locale).sort(), baseline, `${name} 主表键集合与 en 不一致`)
    }
  })
})

// 边表机制：专项词条不得并入主表；运行时经 translate 合并后可取到。
describe('i18n 边表机制', () => {
  it('keeps edge-table keys out of every main table', () => {
    for (const [name, locale] of Object.entries(locales)) {
      assert.equal(
        Object.hasOwn(locale, 'speech.play'),
        false,
        `${name} 主表被写入了朗读边表键（主表不许增行）`,
      )
      assert.equal(
        Object.hasOwn(locale, 'contextIndicator.basisProvider'),
        false,
        `${name} 主表被写入了上下文基准边表键（主表不许增行）`,
      )
    }
  })

  it('resolves edge-table keys through translate to each locale own value', () => {
    const speech: Record<string, Record<string, string>> = {
      en: speechEn, zh: speechZh, 'zh-TW': speechZhTW, jp: speechJp, kr: speechKr,
    }
    const context: Record<string, Record<string, string>> = {
      en: contextSourceEn, zh: contextSourceZh, 'zh-TW': contextSourceZhTW,
      jp: contextSourceJp, kr: contextSourceKr,
    }
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      // 逐语言比对边表字典值：若某语言漏合并，会 fallback 到英文而在此判红。
      assert.equal(translate(locale, 'speech.play'), speech[locale]!['speech.play'])
      assert.equal(
        translate(locale, 'contextIndicator.basisProvider'),
        context[locale]!['contextIndicator.basisProvider'],
      )
    }
  })
})
