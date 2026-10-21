/**
 * 台账纯逻辑与内存仓储出口。
 *
 * 持久化（SQLite）不在本模块范围；接库时按同一接口实现仓储即可。
 */
export * from './rules.ts'
export * from './memory-ledger.ts'
