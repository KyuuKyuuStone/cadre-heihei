/** Locale bundles for the context compaction settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type CompactionSettingsLocaleKey =
  | 'title' | 'description' | 'auto' | 'autoInherited' | 'autoEnabled' | 'autoDisabled'
  | 'autoInheritedHint' | 'autoEnabledHint' | 'autoDisabledHint'
  | 'thresholdRatio' | 'thresholdRatioHint' | 'thresholdRatioPlaceholder' | 'invalidRatio'
  | 'behaviorTitle' | 'pressureBudget' | 'overflowFallback' | 'manualCompaction'
  | 'safetyTitle' | 'safetyDescription'
  | 'safetyAbsoluteFields' | 'safetyRetentionFields' | 'safetyStepFields' | 'safetyOverflowFields'
  | 'safetyAbsolute' | 'safetyRetention' | 'safetyStep' | 'safetyOverflow'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable' | 'save' | 'saving' | 'saveFailed'

/** English copy. */
export const en: Record<CompactionSettingsLocaleKey, string> = {
  title: 'Context compaction',
  description: 'Control automatic compaction and when token pressure triggers it.',
  auto: 'Automatic compaction',
  autoInherited: 'Follow deployment',
  autoEnabled: 'On',
  autoDisabled: 'Off',
  autoInheritedHint: 'Follow the deployment composition without saving a user override.',
  autoEnabledHint: 'Automatic pressure checks and context-overflow recovery are enabled. Manual /compact remains available.',
  autoDisabledHint: 'Automatic pressure checks and overflow retries are disabled. Manual /compact remains available.',
  thresholdRatio: 'Pressure threshold ratio',
  thresholdRatioHint: 'Enter a number in (0, 1], such as 0.9. Lower values compact earlier. Exact model policies and absolute capacity limits still take precedence; leave blank to follow the deployment.',
  thresholdRatioPlaceholder: 'Deployment value',
  invalidRatio: 'Enter a number greater than 0 and no more than 1, or leave blank to follow the deployment.',
  behaviorTitle: 'How compaction behaves',
  pressureBudget: 'The pressure budget is the model context window minus the output reservation and safety headroom. The ratio applies to that remaining budget, never beyond its hard capacity ceiling.',
  overflowFallback: 'With automatic compaction on, a confirmed context-overflow error triggers a compaction attempt and one retry when the surface changes. With it off, that automatic fallback is disabled.',
  manualCompaction: 'Use /compact in chat to compact immediately, even below the threshold or while automatic compaction is off.',
  safetyTitle: 'Read-only safety limits',
  safetyDescription: 'These safety fields remain owned by the deployment composition. This page cannot edit them, and the Host rejects writes that try to bypass the page.',
  safetyAbsoluteFields: 'thresholdTokens',
  safetyRetentionFields: 'retainRatio / retainTokens',
  safetyStepFields: 'stepPressureCheck / stepPressureThresholdTokens / stepMinToolCallsBetweenChecks',
  safetyOverflowFields: 'maxOverflowRetries',
  safetyAbsolute: 'Absolute trigger ceiling',
  safetyRetention: 'Recent-conversation retention budgets',
  safetyStep: 'Step-level pressure checks and thresholds',
  safetyOverflow: 'Maximum overflow retries',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The compaction settings namespace is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

/** Simplified Chinese copy. */
export const zh: Record<CompactionSettingsLocaleKey, string> = {
  title: '上下文压缩',
  description: '控制自动压缩以及令牌压力何时触发压缩。',
  auto: '自动压缩',
  autoInherited: '跟随部署',
  autoEnabled: '开启',
  autoDisabled: '关闭',
  autoInheritedHint: '沿用部署组合的设置，不保存用户覆盖。',
  autoEnabledHint: '自动压力检查与上下文溢出恢复已开启，仍可随时使用 /compact 手动压缩。',
  autoDisabledHint: '自动压力检查与溢出重试已关闭，仍可随时使用 /compact 手动压缩。',
  thresholdRatio: '压力触发比例',
  thresholdRatioHint: '填写 (0, 1] 范围内的小数，例如 0.9；数值越小，压缩越早。特定模型策略与绝对容量上限仍优先；留空则跟随部署。',
  thresholdRatioPlaceholder: '部署值',
  invalidRatio: '请输入大于 0 且不超过 1 的数字；留空表示跟随部署。',
  behaviorTitle: '压缩行为说明',
  pressureBudget: '压力预算是模型上下文窗口扣除输出预留与安全余量后的可用空间。比例只作用于这部分预算，不会越过硬性容量上限。',
  overflowFallback: '自动压缩开启时，确认发生上下文溢出后会尝试压缩，并在对话表面发生变化后重试一次；关闭自动压缩也会关闭此自动回退。',
  manualCompaction: '在聊天中输入 /compact 可立即压缩，即使尚未达到阈值或已关闭自动压缩也可使用。',
  safetyTitle: '只读安全限制',
  safetyDescription: '这些安全字段由部署组合管理。本页不能编辑，Host 也会拒绝绕过页面写入这些字段的请求。',
  safetyAbsoluteFields: 'thresholdTokens',
  safetyRetentionFields: 'retainRatio / retainTokens',
  safetyStepFields: 'stepPressureCheck / stepPressureThresholdTokens / stepMinToolCallsBetweenChecks',
  safetyOverflowFields: 'maxOverflowRetries',
  safetyAbsolute: '绝对触发上限',
  safetyRetention: '近期对话保留预算',
  safetyStep: '步骤级压力检查与阈值',
  safetyOverflow: '溢出重试次数上限',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '上下文压缩设置命名空间当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: CompactionSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
