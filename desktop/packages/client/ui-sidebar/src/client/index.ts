/** Registers the sidebar shell and global panel navigation. */
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
import { CadreIcon, CadrePanel, type CadreCreateRequest, type CadrePanelInjected } from './CadrePanel.tsx'
import { CADRE_PROJECT_ID } from './cadre-roster-source.ts'
import {
  EmployeeRowBadge,
  type EmployeeListState, type EmployeeBadgeInjected, type EmployeeRecord, type EmployeeWrite,
} from './CadreEmployee.tsx'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

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

/** Optional employee slice of the desktop bridge (ADR-0022 T1). */
interface EmployeeBridge {
  getEmployee?: (query: { sessionId: string }) => Promise<{ ok?: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  upsertEmployee?: (query: EmployeeWrite) => Promise<{ ok?: boolean; employee?: EmployeeRecord; code?: string; message?: string }>
  deleteEmployee?: (query: { sessionId: string }) => Promise<{ ok?: boolean; code?: string; message?: string }>
  listEmployees?: () => Promise<{ ok?: boolean; employees?: readonly EmployeeRecord[]; code?: string; message?: string }>
  saveMember?: (query: {
    sessionId: string
    projectId?: string
    role: 'worker' | 'supervisor'
    displayName?: string
  }) => Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  retireMember?: (query: { sessionId: string; projectId?: string }) =>
  Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
}

/** Services required by the sidebar plugin. */
export const inject = [
  'slots', 'theme', 'layout', 'uiWorkspace', 'locale', 'shortcuts',
  'sessions', 'remote', 'remote.agentPresets', 'remote.session',
]

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
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

  // ADR-0022 T3/T4: employee roster shared by the row menu, the badge, and the
  // upgrade dialog. The roster is local SQLite behind `window.cadre`; the
  // dialog's preset/model reads go straight to the official Client Remote.
  const employees = createSnapshotStore<EmployeeListState>({ status: 'loading', employees: [], error: null })
  const employeeBridge = (): EmployeeBridge | undefined => (window as unknown as { cadre?: EmployeeBridge }).cadre
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const refreshEmployees = (): void => {
    const bridge = employeeBridge()
    if (bridge?.listEmployees === undefined) {
      employees.set({ status: 'error', employees: employees.getSnapshot().employees, error: '员工通道未接入：window.cadre.listEmployees 未注册' })
      return
    }
    void bridge.listEmployees().then((result) => {
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
      employees.set({ status: 'error', employees: employees.getSnapshot().employees, error: `IPC_ERROR · ${reason(error)}` })
    })
  }
  refreshEmployees()
  const employeeBadgeInjected = (): EmployeeBadgeInjected => ({ hooks: { employees } })
  // W8/W9 creation seam: the official Session is created first, then the member
  // row. A member-write failure is reported honestly; the Session is not deleted.
  // The sidebar's New Session menu and the project-row ＋ share one request
  // store; the panel owns the form.
  const cadreCreateRequest = createSnapshotStore<CadreCreateRequest | null>(null)
  let cadreCreateToken = 0
  const cadrePanelInjected = (): CadrePanelInjected => ({
    openSession: (sessionId) => { workspaceNavigation.openSession(sessionId) },
    hooks: { createRequest: cadreCreateRequest },
    createPlainSession: async () => {
      try {
        const sessionId = String(await ctx.sessions.create({}))
        return { ok: true as const, sessionId }
      } catch (error) {
        return { ok: false as const, code: 'SESSION_CREATE_FAILED', message: reason(error) }
      }
    },
    createRosterEntry: async ({ role, displayName, description }) => {
      const bridge = employeeBridge()
      if (bridge?.saveMember === undefined) {
        return { ok: false as const, code: 'CHANNEL_MISSING', message: 'window.cadre.saveMember 未注册' }
      }
      let sessionId: string
      try {
        sessionId = String(await ctx.sessions.create({}))
      } catch (error) {
        return { ok: false as const, code: 'SESSION_CREATE_FAILED', message: reason(error) }
      }
      try {
        const saved = await bridge.saveMember({
          sessionId, projectId: CADRE_PROJECT_ID, role, displayName,
        })
        if (saved?.ok !== true) {
          return {
            ok: false as const,
            code: saved?.code ?? 'MEMBER_WRITE_FAILED',
            message: `会话已创建（${sessionId}）但花名册写入失败：${saved?.message ?? '未知错误'}`,
          }
        }
        if (role === 'worker' && description !== undefined && bridge.upsertEmployee !== undefined) {
          const noted = await bridge.upsertEmployee({
            sessionId, displayName, personaNote: description,
          })
          if (noted?.ok !== true) {
            console.warn(`cadre: employee description not stored session=${sessionId} ` +
              `code=${noted?.code ?? 'UNKNOWN'}`)
          }
        }
        return { ok: true as const, sessionId }
      } catch (error) {
        return { ok: false as const, code: 'MEMBER_WRITE_FAILED', message: reason(error) }
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

  // One supervisor per project (ledger invariant). The sidebar menu greys its
  // supervisor item from the same roster read the panel uses; it refreshes
  // whenever the menu opens so a create/retire needs no cross-store plumbing.
  const cadreSupervisor = createSnapshotStore(false)
  const refreshCadreSupervisor = (): void => {
    const list = window.cadre?.listRoster
    if (list === undefined) {
      cadreSupervisor.set(false)
      return
    }
    void list({ projectId: CADRE_PROJECT_ID }).then((result) => {
      const members = result?.members ?? result?.rows ?? []
      cadreSupervisor.set(members.some(member => member.role === 'supervisor' && member.state !== 'departed'))
    }).catch(() => { /* keep the last known state */ })
  }
  refreshCadreSupervisor()

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => {
      if (id === 'plugins' || id === 'schedules') ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: id === 'plugins' ? 'plugin' : 'cron' })
      ctx.layout.selectPanel(id)
    },
    requestCadreCreate: (kind) => {
      cadreCreateToken += 1
      cadreCreateRequest.set({ kind, token: cadreCreateToken })
      ctx.layout.selectPanel('cadre' as MainPanelId)
    },
    refreshCadreSupervisor,
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
  // macOS desktop hides the collapsed sidebar entirely, so the open/New
  // Session controls move into the frame's window-chrome seat beside the
  // traffic lights; the occupant reuses the shell's injected actions, and
  // the AppFrame mounts the seat only while the column is fully hidden.
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))
  // Cadre milestone 1: local fork of the shipped panel navigation. The row and
  // its main panel are registered by this plugin rather than discovered as a
  // third-party client bundle (see ADR-0021 §B).
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'cadre',
    order: 30,
    label: () => '项目部',
  }, CadreIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'cadre',
    inject: cadrePanelInjected,
  }, CadrePanel))
  // Providers live on the official Models page; this plugin registers no
  // settings section of its own.
  // W8: employee management moved under the project row; the global settings
  // section and the session "转为员工" menu entry are intentionally gone.
  // ADR-0022 T4: 16px leading cell, rendered only for employee Sessions.
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'cadre-employee',
    order: 100,
    inject: employeeBadgeInjected,
  }, EmployeeRowBadge))
  syncPanels()
}
