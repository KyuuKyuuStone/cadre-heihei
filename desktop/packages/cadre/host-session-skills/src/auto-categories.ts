/** Deterministic topic tags for packs whose manifest declares no categories. */

/** Keyword rules per topic; ASCII words match whole words, CJK fragments match substrings. */
const RULES: readonly { readonly category: string; readonly words: readonly string[] }[] = [
  {
    category: '编程',
    words: ['code', 'coding', 'programming', 'programmer', 'debug', 'refactor', 'review', 'lint', 'typescript', 'javascript', 'python', 'rust', 'golang', 'java', '代码', '编程', '调试', '开发'],
  },
  {
    category: '办公',
    words: ['office', 'excel', 'xlsx', 'xls', 'word', 'docx', 'pptx', 'powerpoint', 'spreadsheet', 'presentation', 'slides', '表格', '演示', '办公', '幻灯片'],
  },
  {
    category: '文档',
    words: ['doc', 'docs', 'document', 'documentation', 'pdf', 'markdown', 'write', 'writing', 'report', '文档', '写作', '报告', '精读'],
  },
  {
    category: '设计',
    words: ['design', 'designer', 'ui', 'ux', 'figma', 'layout', 'visual', 'style', '设计', '界面', '视觉', '排版'],
  },
  {
    category: '浏览器',
    words: ['browser', 'chrome', 'edge', 'playwright', 'web', 'webpage', 'website', '浏览器', '网页'],
  },
  {
    category: '工具',
    words: ['tool', 'tools', 'cli', 'shell', 'terminal', 'automation', 'computer', 'desktop', '工具', '自动化', '终端', '桌面'],
  },
  {
    category: '数据',
    words: ['data', 'database', 'sql', 'analytics', 'analysis', 'csv', '数据', '分析', '数据库'],
  },
  {
    category: '创作',
    words: ['image', 'video', 'canvas', 'draw', 'drawing', 'illustration', 'music', 'audio', '图像', '视频', '绘画', '创作', '音乐'],
  },
]

/** Tags assigned when no rule matches, so auto-classified packs never fall into "uncategorized". */
export const FALLBACK_CATEGORY = '其他'

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function matches(haystack: string, word: string): boolean {
  // Short ASCII keywords must not hit inside longer words ("ui" in "guide").
  if (/^[\x00-\x7F]+$/u.test(word)) return new RegExp(`\\b${escapeRegExp(word)}\\b`, 'u').test(haystack)
  return haystack.includes(word)
}

/**
 * Derive up to 8 topic tags from a pack's name and description.
 * Explicit manifest categories always take precedence over this derivation.
 * @param input - pack display name and description, in any language.
 * @returns matched topic tags, or the fallback tag when nothing matches.
 */
export function deriveCategories(input: { readonly name: string; readonly description: string }): readonly string[] {
  const haystack = `${input.name}\n${input.description}`.toLowerCase()
  const tags = RULES.filter(rule => rule.words.some(word => matches(haystack, word))).map(rule => rule.category)
  return tags.length === 0 ? [FALLBACK_CATEGORY] : tags.slice(0, 8)
}