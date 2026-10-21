/**
 * 派活/汇报实现出口。
 *
 * - `dispatch-service.ts`：实现无关的运行时逻辑；
 * - `in-memory-dispatch.ts` / `sqlite-dispatch.ts`：两种仓储；
 * - 不接 HTTP、不接 harness；接通道时只替换编排层。
 */
export * from './body-receipt.ts'
export * from './client-command.ts'
export * from './store-port.ts'
export * from './dispatch-service.ts'
export * from './in-memory-dispatch.ts'
export * from './sqlite-dispatch.ts'
