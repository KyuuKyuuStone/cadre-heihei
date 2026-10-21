/**
 * 协作协议类型草案的公共出口。
 *
 * 只有类型与契约常量；实现（状态迁移、校验器、通道）不在 W1-04 范围。
 * 业务代码应从本文件导入，不直接跨文件深引（便于后续契约版本化）。
 */
export * from './ids.ts'
export * from './common.ts'
export * from './task-status.ts'
export * from './errors.ts'
export * from './dispatch.ts'
export * from './report.ts'
export * from './roster.ts'
export * from './tool-outputs.ts'
