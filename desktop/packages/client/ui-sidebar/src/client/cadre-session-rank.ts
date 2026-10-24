/**
 * Cross-plugin session ordering carried by a cordis service.
 *
 * The sidebar owns the roster read; the workspace browser owns the row order.
 * A value import between two client plugins is forbidden by the bundle purity
 * gate, so the sidebar publishes this observable as a service and the browser
 * consumes it (falling back to an empty source when the sidebar is absent).
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Lower rank leads; sessions absent from the map use rank 1. */
export type CadreSessionRank = ReadonlyMap<string, number>

/** Service shape consumed by ui-workspace's sidebar browser. */
export interface CadreSessionRankService {
  readonly source: HostObservable<CadreSessionRank>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cadre-provided session rank; lower values lead a Workspace group. */
    cadreSessionRank: CadreSessionRankService
  }
}
