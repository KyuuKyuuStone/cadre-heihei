/**
 * contrast.test.ts —— 六主题 WCAG 对比度棘轮（B7）
 *
 * 机制来源：cc-heihei v1.7.9 `desktop/src/theme/contrast.test.ts`（同构重写，
 * CSS 由本测试用 node:fs 读入后交给纯函数引擎 `src/renderer/theme/contrast.ts`）。
 *
 * 档位口径（用户 2026-10-21 裁定；`docs/product/design/01` §4、`design/02` §4.1）：
 *   AAA_EMPHASIS = 7.0  警示与强调：状态徽标容器对、品牌 chip、主按钮
 *   AA_SMALL_TEXT = 4.5 正文：消息/台账/卡片文本、三级文本、链接文字
 *   AA_CONTROL    = 3.0 控件边界（WCAG 1.4.11）与链接 underline、大字
 *   DECOR_NOTICE  = 2.4 装饰性 1px 分隔（系统通知条边，产品楼层）
 *
 * 判别力：本套件若把任一 -ink token 换回前身旧值（如 white --cc-ok-ink
 * #3A784D，实测 4.61）必须判红；flatten 顺序反了也必须判红（design/01 §8）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  blockBody,
  contrast,
  flatten,
  luminance,
  normalizeCss,
  parseColor,
  resolve,
} from '../../../src/renderer/theme/contrast.ts'

const css = normalizeCss(
  readFileSync(fileURLToPath(new URL('../../../src/renderer/theme/themes.css', import.meta.url)), 'utf8'),
)

const AAA_EMPHASIS = 7.0
const AA_SMALL_TEXT = 4.5
const AA_CONTROL = 3.0
const DECOR_NOTICE = 2.4

/**
 * 每主题解析链：自身 --cc-* 源块 → ink 共享覆盖块（仅 ink 主题）→ :root 语义层。
 * 前身另有 @theme 静态层（Tailwind 构建期），本仓首版未引入 Tailwind，
 * 语义层 token 全部经 var() 指向 --cc-* 源，无需第三层。
 */
const THEME_BLOCKS = {
  white: [':root,\n[data-theme="white"]', ':root'],
  paper: ['[data-theme="paper"]', ':root'],
  'warm-classic': ['[data-theme="warm-classic"]', ':root'],
  celadon: ['[data-theme="celadon"]', ':root'],
  dark: ['[data-theme="dark"]', '[data-theme="dark"],\n[data-theme="ink-blue"]', ':root'],
  'ink-blue': ['[data-theme="ink-blue"]', '[data-theme="dark"],\n[data-theme="ink-blue"]', ':root'],
} as const

type ThemeName = keyof typeof THEME_BLOCKS

/** 量一对「文本 on 填充」：填充先展平到 surface，文本再展平到填充上——顺序不可反。 */
function measure(theme: ThemeName, textToken: string, fillToken: string): number {
  const selectors = THEME_BLOCKS[theme]
  const surface = parseColor(resolve(css, '--color-surface', selectors))
  const fill = flatten(parseColor(resolve(css, fillToken, selectors)), surface)
  const text = flatten(parseColor(resolve(css, textToken, selectors)), fill)
  return Number(contrast(text, fill).toFixed(2))
}

function assertPair(
  theme: ThemeName,
  name: string,
  textToken: string,
  fillToken: string,
  threshold: number,
): void {
  const ratio = measure(theme, textToken, fillToken)
  assert.ok(
    ratio >= threshold,
    `${theme}/${name}: ${textToken} on ${fillToken} 实测 ${ratio}:1，需 ${threshold}:1`,
  )
}

/* ── AAA 7.0：警示与强调（用户裁定新增档，高于前身 AA 4.5）──────────────
   状态徽标八态的容器对（verified→success / delivered→info / rework→warning /
   failed→danger / 进行中三态→brand / cancelled→neutral 见 design/02 §8.2
   待批复映射；neutral 属正文档在 AA 组断言）、错误条、主按钮。 */
const EMPHASIS_PAIRS = [
  { name: 'success', text: '--color-on-success-container', fill: '--color-success-container' },
  { name: 'warning', text: '--color-on-warning-container', fill: '--color-warning-container' },
  { name: 'danger', text: '--color-on-error-container', fill: '--color-error-container' },
  { name: 'info', text: '--color-on-info-container', fill: '--color-info-container' },
  // 品牌 chip：ink 主题的 on-brand-soft 是从品牌色派生的提亮文字（非主色本身）
  { name: 'brand-chip', text: '--color-on-brand-soft', fill: '--color-brand-soft' },
  // 主按钮：实心墨块（btn-primary-bg=t1 / fg=bg），天然高对比
  { name: 'primary-btn', text: '--color-btn-primary-fg', fill: '--color-btn-primary-bg' },
] as const

describe('AAA 7.0 警示与强调', () => {
  for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
    describe(theme, () => {
      for (const pair of EMPHASIS_PAIRS) {
        it(`${pair.name} 容器对 ≥ 7.0`, () => {
          assertPair(theme, pair.name, pair.text, pair.fill, AAA_EMPHASIS)
        })
      }
    })
  }
})

/* ── AA 4.5：正文（含三级文本——最弱文本层级但非装饰，design/01 §6）───── */
const TEXT_PAIRS = [
  { name: 'body-on-page', text: '--color-text-primary', fill: '--color-surface' },
  { name: 'body-on-user-msg', text: '--color-text-primary', fill: '--color-surface-user-msg' },
  { name: 'secondary-on-page', text: '--color-text-secondary', fill: '--color-surface' },
  { name: 'secondary-on-card', text: '--color-text-secondary', fill: '--color-surface-container' },
  { name: 'tertiary-on-card', text: '--color-text-tertiary', fill: '--color-surface-container' },
  { name: 'tertiary-on-page', text: '--color-text-tertiary', fill: '--color-surface' },
  { name: 'tertiary-on-popover', text: '--color-text-tertiary', fill: '--color-surface-container-lowest' },
  // 系统通知条：中性填充 + 正文（design/02 §3.1，非警示色）
  { name: 'system-notice', text: '--color-text-primary', fill: '--color-surface-container-highest' },
  // 工具输出卡代码区
  { name: 'code-fg', text: '--color-code-fg', fill: '--color-code-bg' },
  // 链接文字（消息流两种底）
  { name: 'link-on-page', text: '--color-text-accent', fill: '--color-surface' },
  { name: 'link-on-user-msg', text: '--color-text-accent', fill: '--color-surface-user-msg' },
] as const

describe('AA 4.5 正文', () => {
  for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
    describe(theme, () => {
      for (const pair of TEXT_PAIRS) {
        it(`${pair.name} ≥ 4.5`, () => {
          assertPair(theme, pair.name, pair.text, pair.fill, AA_SMALL_TEXT)
        })
      }
    })
  }
})

/* ── AA 3.0：控件边界（WCAG 1.4.11）与链接 underline ───────────────────
   --color-border 是 ~1.2:1 的 hairline，永不可用作控件边界；
   控件轮廓一律 --color-border-strong（前身 #1123 教训）。 */
describe('AA 3.0 控件边界与链接 underline', () => {
  for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
    describe(theme, () => {
      for (const fill of ['--color-surface', '--color-surface-container'] as const) {
        it(`border-strong on ${fill} ≥ 3.0`, () => {
          assertPair(theme, 'control-boundary', '--color-border-strong', fill, AA_CONTROL)
        })
      }
      // underline 与链接文字同色（text-accent），3.0 即可见（前身 #1145 教训：
      // 文字对正文仅 1.95-2.55，可点击性全由 underline 承担）
      for (const fill of ['--color-surface', '--color-surface-user-msg'] as const) {
        it(`link underline on ${fill} ≥ 3.0`, () => {
          assertPair(theme, 'link-underline', '--color-text-accent', fill, AA_CONTROL)
        })
      }
    })
  }
})

/* ── 2.4：系统通知条装饰边（非控件、非警示，产品楼层；design/02 §4.1）── */
describe('DECOR 2.4 系统通知条装饰边', () => {
  const GROUNDS = [
    '--color-surface-container-highest', // 条自身填充
    '--color-surface', // 页面
    '--color-surface-user-msg', // 相邻用户气泡
  ] as const
  for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
    describe(theme, () => {
      for (const ground of GROUNDS) {
        it(`border-strong on ${ground} ≥ 2.4`, () => {
          assertPair(theme, 'notice-border', '--color-border-strong', ground, DECOR_NOTICE)
        })
      }
    })
  }
})

/* ── 结构完备性：防「加了第七套主题忘了进棘轮」────────────────────── */
describe('主题结构完备性', () => {
  it('六主题各自源块存在且颜色语法合法', () => {
    for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
      for (const selector of THEME_BLOCKS[theme]) {
        assert.ok(blockBody(css, selector).length > 0, `缺块: ${theme} / ${selector}`)
      }
      // 每主题必须能解出三级文字与页面底——解不出说明源块 token 缺失
      for (const token of ['--color-text-primary', '--color-text-tertiary', '--color-surface']) {
        parseColor(resolve(css, token, THEME_BLOCKS[theme]))
      }
    }
  })

  it('THEME_BLOCKS 与 design/01 §2 六主题名单一致', () => {
    assert.deepEqual(
      Object.keys(THEME_BLOCKS).sort(),
      ['celadon', 'dark', 'ink-blue', 'paper', 'warm-classic', 'white'].sort(),
    )
  })
})

/* ── 引擎单元测试：公式与边界（防引擎本身漂移）────────────────────── */
describe('contrast 引擎', () => {
  it('luminance：黑=0 白=1', () => {
    assert.equal(luminance({ r: 0, g: 0, b: 0, a: 1 }), 0)
    assert.ok(Math.abs(luminance({ r: 255, g: 255, b: 255, a: 1 }) - 1) < 1e-9)
  })

  it('contrast：黑白=21，同色=1', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 }
    const white = { r: 255, g: 255, b: 255, a: 1 }
    assert.ok(Math.abs(contrast(black, white) - 21) < 1e-9)
    assert.equal(contrast(black, black), 1)
  })

  it('parseColor：hex 与 rgba', () => {
    assert.deepEqual(parseColor('#96442B'), { r: 150, g: 68, b: 43, a: 1 })
    assert.deepEqual(parseColor('rgba(19, 17, 14, 0.5)'), { r: 19, g: 17, b: 14, a: 0.5 })
    assert.throws(() => parseColor('red'), /Unsupported color/)
  })

  it('flatten：半透明合成顺序——50% 黑叠白=中灰', () => {
    const mid = flatten({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })
    assert.ok(Math.abs(mid.r - 127.5) < 1e-9 && mid.a === 1)
  })

  it('resolve：跟随 var() 别名并检测循环', () => {
    const sample = ':root { --a: var(--b); --b: #FFFFFF; --x: var(--y); --y: var(--x); }'
    assert.deepEqual(parseColor(resolve(sample, '--a', [':root'])), { r: 255, g: 255, b: 255, a: 1 })
    assert.throws(() => resolve(sample, '--x', [':root']), /Cyclic token/)
    assert.throws(() => resolve(sample, '--missing', [':root']), /Unresolved token/)
  })

  it('blockBody：同名块多次出现时后声明获胜', () => {
    const sample = ':root { --a: #000000; }\n:root { --a: #FFFFFF; }'
    assert.deepEqual(parseColor(resolve(sample, '--a', [':root'])), { r: 255, g: 255, b: 255, a: 1 })
  })
})
