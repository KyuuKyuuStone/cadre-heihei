/** Registers the sidebar shell and global panel navigation. */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
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
import { CadreIcon, CadrePanel } from './CadrePanel.tsx'
import {
  EmployeeDialog, EmployeeMenuItem, EmployeeRowBadge,
  type EmployeeDialogInjected, type EmployeeDialogRequest, type EmployeeListState, type EmployeeMenuInjected,
  type EmployeeBadgeInjected, type EmployeeRecord, type EmployeeWrite,
} from './CadreEmployee.tsx'
import { EmployeeSection, type EmployeeSettingsInjected } from './EmployeeSection.tsx'
import { ProviderSection } from './ProviderSection.tsx'
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
}

/** Optional employee slice of the desktop bridge (ADR-0022 T1). */
interface EmployeeBridge {
  getEmployee?: (query: { sessionId: string }) => Promise<{ ok?: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  upsertEmployee?: (query: EmployeeWrite) => Promise<{ ok?: boolean; employee?: EmployeeRecord; code?: string; message?: string }>
  deleteEmployee?: (query: { sessionId: string }) => Promise<{ ok?: boolean; code?: string; message?: string }>
  listEmployees?: () => Promise<{ ok?: boolean; employees?: readonly EmployeeRecord[]; code?: string; message?: string }>
}

/** Services required by the sidebar plugin. */
export const inject = [
  'slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts',
  'sessions', 'remote', 'remote.agentPresets', 'remote.session',
]

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')

  // ADR-0022 T3/T4: employee roster shared by the row menu, the badge, and the
  // upgrade dialog. The roster is local SQLite behind `window.cadre`; the
  // dialog's preset/model reads go straight to the official Client Remote.
  const employees = createSnapshotStore<EmployeeListState>({ status: 'loading', employees: [], error: null })
  const employeeRequest = createSnapshotStore<EmployeeDialogRequest | null>(null)
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
  const getEmployee = async (sessionId: string) => {
    const bridge = employeeBridge()
    if (bridge?.getEmployee === undefined) return { ok: false, code: 'CHANNEL_MISSING', message: 'window.cadre.getEmployee 未注册' }
    try {
      const result = await bridge.getEmployee({ sessionId })
      if (result?.ok !== true) return { ok: false, code: result?.code ?? 'UNKNOWN', message: result?.message ?? '未知错误' }
      return { ok: true, employee: result.employee ?? null }
    } catch (error) {
      return { ok: false, code: 'IPC_ERROR', message: reason(error) }
    }
  }
  const listPresets = async () => {
    try {
      const result = await ctx.remote.agentPresets.list()
      if (!result.ok) return { ok: false as const, code: result.error.code, message: result.error.message }
      return {
        ok: true as const,
        value: result.value.presets
          .filter(preset => preset.id.startsWith('cadre-'))
          .map(preset => ({
            id: preset.id,
            name: preset.name ?? preset.id,
            ...(preset.description === undefined ? {} : { description: preset.description }),
            ...(preset.broken === undefined ? {} : { broken: preset.broken }),
            ...(preset.isDefault === undefined ? {} : { isDefault: preset.isDefault }),
          })),
      }
    } catch (error) {
      return { ok: false as const, code: 'REMOTE_ERROR', message: reason(error) }
    }
  }
  const loadModels = async () => {
    try {
      const result = await ctx.remote.session.modelCatalog()
      if (!result.ok) return { ok: false as const, code: result.error.code, message: result.error.message }
      return {
        ok: true as const,
        value: {
          groups: result.value.groups.map(group => ({
            id: group.id,
            name: group.name,
            models: group.models.map(model => ({
              id: model.id,
              name: model.name,
              ...(model.reasoning?.defaultEffort === undefined
                ? {}
                : { reasoning: { defaultEffort: model.reasoning.defaultEffort } }),
            })),
          })),
          defaultProvider: result.value.default.provider,
          defaultModel: result.value.default.model,
        },
      }
    } catch (error) {
      return { ok: false as const, code: 'REMOTE_ERROR', message: reason(error) }
    }
  }
  const isBlank = (sessionId: string): boolean | undefined => {
    const byId = ctx.sessions.list.getSnapshot().byId as Record<string, { readonly blank?: boolean } | undefined>
    return byId[sessionId]?.blank
  }
  const currentPreset = (sessionId: string): string | undefined => {
    const byId = ctx.sessions.list.getSnapshot().byId as Record<string, {
      readonly projectionValues?: Readonly<Record<string, unknown>>
    } | undefined>
    const value = byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  }
  const applyPreset = async (sessionId: string, presetId: string) => {
    try {
      const result = await ctx.remote.agentPresets.select(sessionId as never, presetId)
      return result.ok ? { ok: true as const } : { ok: false as const, code: result.error.code, message: result.error.message }
    } catch (error) {
      return { ok: false as const, code: 'REMOTE_ERROR', message: reason(error) }
    }
  }
  const applyModel = async (sessionId: string, provider: string, model: string, reasoningEffort?: string) => {
    try {
      const result = await ctx.remote.session.selectModel({
        sessionId: sessionId as never,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never }),
      })
      return result.ok ? { ok: true as const } : { ok: false as const, code: result.error.code, message: result.error.message }
    } catch (error) {
      return { ok: false as const, code: 'REMOTE_ERROR', message: reason(error) }
    }
  }
  const saveEmployee = async (input: EmployeeWrite) => {
    const bridge = employeeBridge()
    if (bridge?.upsertEmployee === undefined) return { ok: false as const, code: 'CHANNEL_MISSING', message: 'window.cadre.upsertEmployee 未注册' }
    try {
      const result = await bridge.upsertEmployee(input)
      if (result?.ok !== true) return { ok: false as const, code: result?.code ?? 'UNKNOWN', message: result?.message ?? '未知错误' }
      return { ok: true as const, ...(result.employee === undefined ? {} : { employee: result.employee }) }
    } catch (error) {
      return { ok: false as const, code: 'IPC_ERROR', message: reason(error) }
    }
  }
  const deleteEmployee = async (sessionId: string) => {
    const bridge = employeeBridge()
    if (bridge?.deleteEmployee === undefined) return { ok: false as const, code: 'CHANNEL_MISSING', message: 'window.cadre.deleteEmployee 未注册' }
    try {
      const result = await bridge.deleteEmployee({ sessionId })
      if (result?.ok !== true) return { ok: false as const, code: result?.code ?? 'UNKNOWN', message: result?.message ?? '未知错误' }
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, code: 'IPC_ERROR', message: reason(error) }
    }
  }
  const employeeMenuInjected = (): EmployeeMenuInjected => ({
    hooks: { employees },
    openEmployeeDialog: (request) => { employeeRequest.set(request) },
  })
  const employeeBadgeInjected = (): EmployeeBadgeInjected => ({ hooks: { employees } })
  const employeeDialogInjected = (): EmployeeDialogInjected => ({
    hooks: { request: employeeRequest },
    closeEmployeeDialog: () => { employeeRequest.set(null) },
    getEmployee,
    listPresets,
    loadModels,
    isBlank,
    currentPreset,
    applyPreset,
    applyModel,
    saveEmployee,
    refreshEmployees,
  })
  const employeeSettingsInjected = (): EmployeeSettingsInjected => ({
    hooks: { employees },
    listPresets,
    loadModels,
    getEmployee,
    saveEmployee,
    deleteEmployee,
    isBlank,
    refreshEmployees,
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

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => {
      if (id === 'plugins' || id === 'schedules') ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: id === 'plugins' ? 'plugin' : 'cron' })
      ctx.layout.selectPanel(id)
    },
    hooks: { panels, shortcuts: ctx.shortcuts.catalog },
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
    label: () => '协作',
  }, CadreIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'cadre',
  }, CadrePanel))
  // Cadre providers: settings section for the model-provider roster.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'cadre-providers',
    order: 15,
    label: () => '模型 Providers',
    locale: NS,
  }, ProviderSection))
  // ADR-0022 §5: employee roster, between Models (15) and Agent presets (20).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'cadre-employees',
    order: 18,
    label: () => '员工',
    locale: NS,
    inject: employeeSettingsInjected,
  }, EmployeeSection))
  // ADR-0022 T3: session row menu between Rename (200) and Fork (300).
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'cadre-employee',
    order: 250,
    inject: employeeMenuInjected,
  }, EmployeeMenuItem))
  // ADR-0022 T4: 16px leading cell, rendered only for employee Sessions.
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'cadre-employee',
    order: 100,
    inject: employeeBadgeInjected,
  }, EmployeeRowBadge))
  // The dialog outlives the row menu, so it lives in the frame-wide overlay.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'cadre-employee',
    inject: employeeDialogInjected,
  }, EmployeeDialog))
  // Upstream ui-workspace renders a blank row's row-actions strip (and with it
  // every menu entry) only after the first prompt. Blank Sessions are exactly
  // the ones that may still choose a template, so they get a right-click
  // fallback here; non-blank rows keep the official slot entry above.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest('[data-row-key^="session:"]')
      if (row === null) return
      const sessionId = (row.getAttribute('data-row-key') ?? '').slice('session:'.length)
      if (sessionId === '' || isBlank(sessionId) !== true) return
      event.preventDefault()
      employeeRequest.set({ sessionId, displayTitle: row.textContent?.trim() ?? '' })
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => { document.removeEventListener('contextmenu', onContextMenu) }
  }, 'ui-sidebar: blank session employee menu')
  syncPanels()
}
