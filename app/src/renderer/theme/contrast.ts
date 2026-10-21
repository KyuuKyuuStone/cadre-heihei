/**
 * contrast.ts —— WCAG 对比度测量引擎（纯函数，零 node/DOM 依赖）
 *
 * 来源：cc-heihei v1.7.9 `desktop/src/theme/contrast.test.ts` 内联实现提取。
 * 机制口径：`docs/product/design/01-主题与对比度棘轮规范.md` §5。
 *
 * 迁移改动：
 *   - CSS 文本由调用方注入（前身用 vite `?raw`，本仓 renderer 不耦合构建工具），
 *     因此本模块不 import node:fs——测试侧读文件后传入；
 *   - CR/LF 归一化内置（Windows 检出 core.autocrlf=true 下同一份 CSS 是 CRLF，
 *     选择器字面量用 LF 拼接会让 indexOf 整文件失败——前身教训，见原文件头注释）。
 *
 * 关键不变量（违反即棘轮假绿，design/01 §8）：
 *   1. 半透明先 flatten 到 surface，再把文本 flatten 到填充色上，顺序不可反；
 *   2. 同名选择器出现多次时后声明获胜（blockBody 拼接后 reverse）；
 *   3. 比较用 toFixed(2) 后的两位小数（与前身断言口径一致）。
 */

export type Rgb = { r: number; g: number; b: number; a: number }

/** 归一化换行：Windows 检出的 CRLF → LF。 */
export function normalizeCss(rawCss: string): string {
  return rawCss.replace(/\r\n/g, '\n')
}

/**
 * 拼接所有写在 `selector` 上的块体。
 *
 * 一个选择器合法地出现多次（`:root` 同时承载 layering scale、ANSI 调色板与
 * 语义层等独立块），后声明获胜。只读第一个匹配曾把 `--color-surface`
 * 解析到 z-index 刻度块上抛出 "unresolved token"——前身在案缺陷。
 */
export function blockBody(css: string, selector: string): string {
  const bodies: string[] = []
  let cursor = 0
  for (;;) {
    const start = css.indexOf(`${selector} {`, cursor)
    if (start < 0) break
    const open = css.indexOf('{', start)
    let depth = 0
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      if (css[i] === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(css.slice(open + 1, i))
          cursor = i
          break
        }
      }
    }
    if (cursor < open) throw new Error(`Unclosed block: ${selector}`)
  }
  if (bodies.length === 0) throw new Error(`Missing block: ${selector}`)
  // Later blocks win, so search them first.
  return bodies.reverse().join('\n')
}

/** 从第一个定义该 token 的块读值，跟随 var() 别名；检测循环引用。 */
export function resolve(
  css: string,
  token: string,
  selectors: readonly string[],
  seen = new Set<string>(),
): string {
  if (seen.has(token)) throw new Error(`Cyclic token: ${token}`)
  seen.add(token)

  for (const selector of selectors) {
    const match = blockBody(css, selector).match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
    if (!match) continue
    const value = match[1]!.trim()
    const alias = value.match(/^var\(\s*(--[\w-]+)\s*\)$/)
    return alias ? resolve(css, alias[1]!, selectors, seen) : value
  }
  throw new Error(`Unresolved token: ${token}`)
}

export function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => Number(p.trim()))
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 }
  }
  throw new Error(`Unsupported color: ${value}`)
}

/** 按合成器方式把半透明色展平到不透明底色上。 */
export function flatten(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

/** WCAG 相对亮度：sRGB 分段线性化后按 0.2126/0.7152/0.0722 加权。 */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 对比度：(L亮 + 0.05) / (L暗 + 0.05)，范围 1–21。 */
export function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** 与前身断言口径一致：两位小数后比较。 */
export function ratio2(fg: Rgb, bg: Rgb): number {
  return Number(contrast(fg, bg).toFixed(2))
}
