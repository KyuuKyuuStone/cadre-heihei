/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'update.available': '有新版本',
  'update.view': '查看',
  'update.dismiss': '关闭提示',
  'update.upgraded': '团队数据还在，界面设置重置了',
  'update.settings.title': '检查更新',
  'update.settings.description': '启动时检查一次，之后每 24 小时检查 GitHub Releases。关闭后不再发起请求。',
  'update.settings.label': '检查更新',
  'update.settings.saveFailed': '保存失败，请稍后重试。',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'update.available': 'New version',
  'update.view': 'View',
  'update.dismiss': 'Dismiss notice',
  'update.upgraded': 'Your team data is intact; interface settings were reset',
  'update.settings.title': 'Check for updates',
  'update.settings.description': 'Checks once at startup and then every 24 hours against GitHub Releases. Turning this off stops all requests.',
  'update.settings.label': 'Check for updates',
  'update.settings.saveFailed': 'Could not save. Try again.',
} satisfies Record<SidebarKey, string>
