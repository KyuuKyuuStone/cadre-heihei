/** 运行时注册表的结构化错误；不 import harness，供上层按 EngineError 处理。 */
import type { EngineError, EngineErrorCode } from '../ports/engine.ts'

export class RuntimeRegistryError extends Error implements EngineError {
  readonly code: EngineErrorCode
  readonly retryable: boolean
  readonly rawCode: string

  constructor(code: EngineErrorCode, message: string, retryable: boolean, rawCode: string) {
    super(message)
    this.name = 'RuntimeRegistryError'
    this.code = code
    this.retryable = retryable
    this.rawCode = rawCode
  }
}
