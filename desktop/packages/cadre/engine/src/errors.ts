/**
 * Failure normalization shared by both EnginePort bindings.
 * @module @deepseek-ai/dsh-cadre-engine/errors
 */
import type { EngineError, Result } from './types.ts'

/** Code reported when the call never reached an official surface. */
export const TRANSPORT_ERROR_CODE = 'ENGINE_UNAVAILABLE'

/**
 * Reduce a thrown official failure to the port's error value.
 * @param cause - value thrown by the official service or transport.
 * @returns the official code and message, or the transport code.
 */
export function errorOf(cause: unknown): EngineError {
  const code = typeof (cause as { readonly code?: unknown } | null)?.code === 'string'
    ? (cause as { readonly code: string }).code
    : TRANSPORT_ERROR_CODE
  const message = cause instanceof Error
    ? cause.message
    : typeof (cause as { readonly message?: unknown } | null)?.message === 'string'
      ? (cause as { readonly message: string }).message
      : String(cause)
  const field = typeof (cause as { readonly field?: unknown } | null)?.field === 'string'
    ? (cause as { readonly field: string }).field
    : undefined
  return { code, message, ...(field === undefined ? {} : { field }) }
}

/**
 * Wrap one official failure.
 * @param error - normalized failure.
 * @returns the failure result.
 */
export function failure<T>(error: EngineError): Result<T> {
  return { ok: false, error }
}
