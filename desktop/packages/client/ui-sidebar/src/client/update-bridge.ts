/** Structural bridge for the lightweight GitHub Releases notice. */
export type CadreUpdateNotice =
  | { readonly kind: 'available'; readonly version: string; readonly url: string }
  | { readonly kind: 'upgraded'; readonly version: string; readonly fromVersion?: string }

/** Optional desktop-only update methods; absent in a plain web shell. */
export interface CadreUpdateBridge {
  getUpdateNotice?: () => Promise<CadreUpdateNotice | null>
  dismissUpdateNotice?: (kind: CadreUpdateNotice['kind']) => Promise<CadreUpdateNotice | null>
  openReleasePage?: () => Promise<void>
  getUpdateCheckEnabled?: () => Promise<boolean>
  setUpdateCheckEnabled?: (enabled: boolean) => Promise<boolean>
  subscribeUpdateNotice?: (listener: (notice: CadreUpdateNotice | null) => void) => () => void
}

/** Read the bridge without assuming it exists. */
export function cadreUpdateBridge(): CadreUpdateBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { cadre?: CadreUpdateBridge }).cadre
}
