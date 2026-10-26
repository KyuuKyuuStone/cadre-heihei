/**
 * 客户端命令判定（派活前置校验，05 第 8 条）。
 *
 * 判定口径（写死并测试，不按猜测扩大拒绝面）：
 * 1. 先 `trimStart()` 去前导空白（含 U+FEFF BOM，JS 空白定义），再判断是否以 `/` 开头；
 * 2. 命令 token = `/` + 连续的 ASCII 字母/数字/`-`/`_`，遇到空白或其他字符即结束；
 * 3. token 小写后必须**整 token 等于**已知命令（`/compact`、`/clear`），前缀不算；
 * 4. 大小写不敏感（`/CLEAR` 拒绝），但返回命中时的原始 token；
 * 5. 正文开头若不是 `/`（例如 Markdown 代码围栏 ``` 或行内反引号）一律放行——
 *    只检查首个 token，不扫描正文内部，避免误伤「请解释 /compact」这类正常说明。
 */
export const CLIENT_COMMANDS = ['/compact', '/clear'] as const
export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

const COMMAND_TOKEN_RE = /^\/[A-Za-z0-9_-]+/

export function matchClientCommand(body: string): string | null {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('/')) return null
  const match = COMMAND_TOKEN_RE.exec(trimmed)
  if (!match) return null
  const token = match[0]
  return (CLIENT_COMMANDS as readonly string[]).includes(token.toLowerCase()) ? token : null
}
