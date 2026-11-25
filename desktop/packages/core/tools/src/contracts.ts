/** Tool error identities that carry a stable machine-routable code. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

import { TOOL_CONTEXT_UNAVAILABLE } from './error-codes.ts'

/**
 * Thrown by a tool body when its composition or call lacks context the tool
 * requires, such as a calling Agent, an injected service, or an open turn.
 * The failure is not an argument the model can correct; `message` names the
 * missing context.
 */
export class ToolContextUnavailableError extends HarnessError {
  /**
   * @param message - names the tool and the missing context.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, TOOL_CONTEXT_UNAVAILABLE, options)
    this.name = 'ToolContextUnavailableError'
  }
}