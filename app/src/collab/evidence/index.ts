/**
 * 证据卡核心（N17 第一部分）：结构、校验、原子写/租约、user-role 注入器。
 *
 * 约束：不 import harness/adapters，不接真实模型；纯本地文件。
 */
export * from './types.ts'
export * from './errors.ts'
export * from './integrity.ts'
export * from './fs-utils.ts'
export * from './validation.ts'
export * from './store.ts'
export * from './injector.ts'
