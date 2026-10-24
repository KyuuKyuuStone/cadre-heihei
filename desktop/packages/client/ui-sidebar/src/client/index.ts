/** Registers the sidebar shell and cadre contributions that live on its rows. */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
// Type-only: pulls the theme service's Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pull the Client Remote and Session service merges (employee dialog).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarPanelMetadata, SidebarRootInjected } from './contract/slots.ts'
import { CADRE_SKIN_TOKENS, CADRE_THEME_ENABLED, CADRE_THEME_SOURCE } from './cadre-skin.tokens.ts'
import { CadreCreateDialog, type CadreCreateInjected, type CadreCreateRequest } from './CadreCreateDialog.tsx'
import { CadreLedgerOverlay, type CadreLedgerInjected, type CadreLedgerRequest } from './CadreLedgerOverlay.tsx'
import {
  CadreEditMemberMenuItem, CadreProjectRowActions, CadreRetireMenuItem, CadreSessionBadge,
  CadreSessionMarker,
  type CadreEditInjected, type CadreProjectActionsInjected, type CadreRetireInjected,
  type CadreRosterBadgeInjected, type CadreRosterMember, type CadreRosterState,
} from './CadreSidebar.tsx'
import type { CadreSessionRankService } from './cadre-session-rank.ts'
import { CADRE_PROJECT_ID } from './cadre-roster-source.ts'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'
export type { CadreSessionRankService } from './cadre-session-rank.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar controls and global panel copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

interface WorkspaceNavigation {
  startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
  openSession(sessionId: string): void
}

interface RosterRow {
  readonly sessionId: string
  readonly role: string
  readonly displayName?: string
  readonly description?: string
  readonly state?: string
}

/** Optional cadre slice of the desktop bridge. */
interface CadreBridge {
  getEmployee?: (query: { sessionId: string }) => Promise<{ ok?: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  upsertEmployee?: (query: EmployeeWrite) => Promise<{ ok?: boolean; employee?: EmployeeRecord; code?: string; message?: string }>
  listEmployees?: () => Promise<{ ok?: boolean; employees?: readonly EmployeeRecord[]; code?: string; message?: string }>
  listRoster?: (query: { projectId: string }) => Promise<{
    members?: readonly RosterRow[]
    rows?: readonly RosterRow[]
  } | undefined>
  saveMember?: (query: {
    sessionId: string
    projectId?: string
    role: 'worker' | 'supervisor'
    displayName?: string
  }) => Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  retireMember?: (query: { sessionId: string; projectId?: string }) =>
  Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
}

interface EmployeeRecord {
  readonly sessionId: string
  readonly projectId?: string
  readonly displayName?: string
  readonly templateId?: string
  readonly personaNote?: string
}

interface EmployeeWrite {
  readonly sessionId: string
  readonly displayName?: string | null
  readonly personaNote?: string | null
}

interface EmployeeListState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly employees: readonly EmployeeRecord[]
  readonly error: string | null
}

/** Services required by the sidebar plugin. */
export const inject = [
  'slots', 'theme', 'layout', 'uiWorkspace', 'locale', 'shortcuts', 'sessions',
]

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root Context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')

  // Warm 「纸 · 墨 · 印」skin: alias-only layers over the user's light/dark
  // preference. One switch (`CADRE_THEME_ENABLED`) removes the whole layer and
  // restores the official palette; disposing the plugin does the same.
  ctx.effect(
    () => (CADRE_THEME_ENABLED
      ? ctx.theme.overrideTokens(CADRE_THEME_SOURCE, CADRE_SKIN_TOKENS)
      : () => {}),
    'ui-sidebar: cadre warm skin',
  )

  const bridge = (): CadreBridge | undefined => typeof window === 'undefined'
    ? undefined
    : (window as unknown as { cadre?: CadreBridge }).cadre

  // Employee profile store (name/description edits go through the same upsert
  // write; the row menu owns the dialog).
  const employees = createSnapshotStore<EmployeeListState>({ status: 'loading', employees: [], error: null })
  const refreshEmployees = (): void => {
    const target = bridge()
    if (target?.listEmployees === undefined) {
      employees.set({ status: 'error', employees: employees.getSnapshot().employees, error: '员工通道未接入：window.cadre.listEmployees 未注册' })
      return
    }
    void target.listEmployees().then((result) => {
      if (result?.ok === true && Array.isArray(result.employees)) {
        employees.set({ status: 'ready', employees: result.employees, error: null })
        return
      }
      employees.set({
        status: 'error',
        employees: employees.getSnapshot().employees,
        error: result?.ok === false
          ? `${result.code ?? 'UNKNOWN'} · ${result.message ?? '未知错误'}`
          : '响应缺少 employees',
      })
    }).catch((error: unknown) => {
      employees.set({ status: 'error', employees: employees.getSnapshot().employees, error: `IPC_ERROR · ${reasonOf(error)}` })
    })
  }
  refreshEmployees()

  // Roster is the ledger's authority for supervisor/worker identity; the same
  // read also feeds the leading rank so the supervisor stays on top.
  const roster = createSnapshotStore<CadreRosterState>({ status: 'loading', members: [], error: null })
  const cadreSupervisor = createSnapshotStore(false)
  // The browser is another client plugin; a cordis service is the only
  // allowed value channel between them (bundle purity gate).
  const sessionRank = createSnapshotStore<ReadonlyMap<string, number>>(new Map())
  const rankService: CadreSessionRankService = { source: sessionRank }
  ctx.provide('cadreSessionRank', rankService)
  const refreshRoster = (): void => {
    const target = bridge()
    if (target?.listRoster === undefined) {
      roster.set({
        status: 'error',
        members: roster.getSnapshot().members,
        error: '花名册通道未接入：window.cadre.listRoster 未注册',
      })
      return
    }
    void target.listRoster({ projectId: CADRE_PROJECT_ID }).then((result) => {
      const members: readonly CadreRosterMember[] = (result?.members ?? result?.rows ?? []).map(member => ({
        sessionId: member.sessionId,
        role: member.role,
        ...(member.displayName === undefined ? {} : { displayName: member.displayName }),
        ...(member.description === undefined ? {} : { description: member.description }),
        ...(member.state === undefined ? {} : { state: member.state }),
      }))
      roster.set({ status: 'ready', members, error: null })
      const supervisors = members
        .filter(member => member.role === 'supervisor' && member.state !== 'departed')
        .map(member => member.sessionId)
      cadreSupervisor.set(supervisors.length > 0)
      sessionRank.set(new Map(supervisors.map(id => [id, 0])))
    }).catch((error: unknown) => {
      roster.set({
        status: 'error',
        members: roster.getSnapshot().members,
        error: `ROSTER_READ_FAILED · ${reasonOf(error)}`,
      })
    })
  }
  refreshRoster()

  // Create/ledger requests are frame-wide overlays: both are opened from the
  // sidebar and never replace the conversation underneath.
  const cadreCreateRequest = createSnapshotStore<CadreCreateRequest | null>(null)
  let cadreCreateToken = 0
  const requestCreate = (kind: 'supervisor' | 'worker', workspaceId?: string): void => {
    cadreCreateToken += 1
    cadreCreateRequest.set({
      kind,
      token: cadreCreateToken,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
  }
  const ledgerRequest = createSnapshotStore<CadreLedgerRequest | null>(null)
  let ledgerToken = 0
  const openLedger = (request: { projectId: string; label: string; cwd?: string }): void => {
    ledgerToken += 1
    ledgerRequest.set({
      projectId: request.projectId,
      label: request.label,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      token: ledgerToken,
    })
  }

  const createRosterEntry = async (input: {
    role: 'supervisor' | 'worker'
    displayName: string
    description?: string
    workspaceId?: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> => {
    const target = bridge()
    if (target?.saveMember === undefined) {
      return { ok: false, code: 'CHANNEL_MISSING', message: 'window.cadre.saveMember 未注册' }
    }
    let sessionId: string
    try {
      sessionId = String(await ctx.sessions.create(input.workspaceId === undefined
        ? {}
        : { workspaceId: input.workspaceId as NonNullable<Parameters<WorkspaceNavigation['startSession']>[0]> }))
    } catch (error) {
      return { ok: false, code: 'SESSION_CREATE_FAILED', message: reasonOf(error) }
    }
    try {
      const saved = await target.saveMember({
        sessionId, projectId: CADRE_PROJECT_ID, role: input.role, displayName: input.displayName,
      })
      if (saved?.ok !== true) {
        return {
          ok: false,
          code: saved?.code ?? 'MEMBER_WRITE_FAILED',
          message: `会话已创建（${sessionId}）但花名册写入失败：${saved?.message ?? '未知错误'}`,
        }
      }
      if (input.role === 'worker' && input.description !== undefined && target.upsertEmployee !== undefined) {
        const noted = await target.upsertEmployee({
          sessionId, displayName: input.displayName, personaNote: input.description,
        })
        if (noted?.ok !== true) {
          console.warn(`cadre: employee description not stored session=${sessionId} ` +
            `code=${noted?.code ?? 'UNKNOWN'}`)
        }
      }
      refreshRoster()
      refreshEmployees()
      // Open the new Session immediately: the sidebar never leaves a blank
      // page behind a completed create.
      workspaceNavigation.openSession(sessionId)
      return { ok: true, sessionId }
    } catch (error) {
      return { ok: false, code: 'MEMBER_WRITE_FAILED', message: reasonOf(error) }
    }
  }

  const createInjected = (): CadreCreateInjected => ({
    hooks: { createRequest: cadreCreateRequest },
    closeCreate: () => { cadreCreateRequest.set(null) },
    createRosterEntry,
    refreshSupervisor: refreshRoster,
  })

  const ledgerInjected = (): CadreLedgerInjected => ({
    hooks: { request: ledgerRequest },
    closeLedger: () => { ledgerRequest.set(null) },
  })

  const rosterBadgeInjected = (): CadreRosterBadgeInjected => ({ hooks: { roster } })

  const projectActionsInjected = (): CadreProjectActionsInjected => ({
    hooks: { cadreSupervisor },
    startSession: (workspaceId) => {
      workspaceNavigation.startSession(workspaceId as Parameters<WorkspaceNavigation['startSession']>[0])
    },
    requestCadreCreate: requestCreate,
    openLedger,
  })

  const retireInjected = (): CadreRetireInjected => ({
    hooks: { roster },
    retire: async (sessionId) => {
      const target = bridge()
      if (target?.retireMember === undefined) {
        return { ok: false, code: 'CHANNEL_MISSING', message: 'window.cadre.retireMember 未注册' }
      }
      try {
        const result = await target.retireMember({ projectId: CADRE_PROJECT_ID, sessionId })
        refreshRoster()
        refreshEmployees()
        return {
          ok: result?.ok === true,
          ...(result?.code === undefined ? {} : { code: result.code }),
          ...(result?.message === undefined ? {} : { message: result.message }),
        }
      } catch (error) {
        return { ok: false, code: 'RETIRE_FAILED', message: reasonOf(error) }
      }
    },
  })

  const editInjected = (): CadreEditInjected => ({
    hooks: { roster },
    updateMember: async ({ sessionId, displayName, description }) => {
      const target = bridge()
      if (target?.upsertEmployee === undefined) {
        return { ok: false, code: 'CHANNEL_MISSING', message: 'window.cadre.upsertEmployee 未注册' }
      }
      try {
        const result = await target.upsertEmployee({
          sessionId,
          displayName,
          personaNote: description,
        })
        refreshRoster()
        refreshEmployees()
        return {
          ok: result?.ok === true,
          ...(result?.code === undefined ? {} : { code: result.code }),
          ...(result?.message === undefined ? {} : { message: result.message }),
        }
      } catch (error) {
        return { ok: false, code: 'UPDATE_FAILED', message: reasonOf(error) }
      }
    },
  })

  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
  const syncPanels = (): void => {
    const next = ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => {
      // The list registration requires an id; StoredEntry erases the slot kind.
      const id = options.id as MainPanelId
      return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
    }).sort((a, b) => a.order - b.order)
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    panels.set(next)
  }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'ui-sidebar: panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')

  // The shell's New Session menu and the project row ＋ share one request
  // store; the overlay dialog owns the form.
  const injectProps = (): SidebarRootInjected => ({
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => {
      if (id === 'plugins' || id === 'schedules') ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: id === 'plugins' ? 'plugin' : 'cron' })
      ctx.layout.selectPanel(id)
    },
    requestCadreCreate: requestCreate,
    refreshCadreSupervisor: refreshRoster,
    hooks: { panels, shortcuts: ctx.shortcuts.catalog, cadreSupervisor },
  })
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    locale: NS,
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.toggle.badge': { kind: 'single', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
    inject: injectProps,
  }, SidebarRoot))
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))

  // Frame-wide overlays: create dialog and read-only ledger. Neither replaces
  // the main conversation.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'cadre-create', locale: NS, inject: createInjected,
  }, CadreCreateDialog))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'cadre-ledger', locale: NS, inject: ledgerInjected,
  }, CadreLedgerOverlay))

  // Project row: ＋ (supervisor/employee/plain) + 台账.
  ctx.slots.inject('sidebar.workspaces.project.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.project.row.action',
    id: 'cadre-project-actions',
    order: 100,
    inject: projectActionsInjected,
  }, CadreProjectRowActions))

  // Session identity: marker in the leading cell + role badge beside the title.
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'cadre-session-marker',
    order: 100,
    inject: rosterBadgeInjected,
  }, CadreSessionMarker))
  ctx.slots.inject('sidebar.session.row.badge', () => ctx.slots.register({
    name: 'sidebar.session.row.badge',
    id: 'cadre-session-badge',
    order: 100,
    inject: rosterBadgeInjected,
  }, CadreSessionBadge))

  // Employee management stays on the Session row menu.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'cadre-edit-member',
    order: 300,
    inject: editInjected,
  }, CadreEditMemberMenuItem))
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'cadre-retire-member',
    order: 400,
    inject: retireInjected,
  }, CadreRetireMenuItem))

  syncPanels()
}
