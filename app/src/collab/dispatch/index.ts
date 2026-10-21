/**
 * 派活/汇报内存实现出口（W1-06）。
 *
 * 不接 HTTP、不接 harness、不接 SQLite；接通道与持久化时只替换本层实现。
 */
export * from './body-receipt.ts'
export * from './client-command.ts'
export * from './in-memory-dispatch.ts'
