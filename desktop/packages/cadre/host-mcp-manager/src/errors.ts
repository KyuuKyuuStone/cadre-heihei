/**
 * Structured failure for the Cadre MCP routes.
 * @module
 */
import type { McpErrorCode } from './types.ts'

/**
 * A manager-side failure the route returns as `{ok:false, code, message, remediation}`.
 * `remediation` tells the operator which action clears the failure, which is why
 * it travels on the response instead of being derived in the client.
 */
export class McpError extends Error {
  readonly code: McpErrorCode
  readonly status: number
  readonly remediation: string

  /**
   * @param code - structured code the client switches on.
   * @param status - HTTP status the route replies with.
   * @param message - short Chinese sentence naming what failed.
   * @param remediation - short Chinese sentence naming the next action.
   */
  constructor(code: McpErrorCode, status: number, message: string, remediation: string) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.status = status
    this.remediation = remediation
  }
}
