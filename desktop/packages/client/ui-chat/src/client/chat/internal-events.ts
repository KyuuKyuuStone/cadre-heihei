/** Reserved supervisor-internal message marker (wire text, not translated UI). */
export const CADRE_INTERNAL_PREFIX = '【主管内部】'

export function isCadreInternalEvent(text: string): boolean {
  return text.startsWith(CADRE_INTERNAL_PREFIX)
}
