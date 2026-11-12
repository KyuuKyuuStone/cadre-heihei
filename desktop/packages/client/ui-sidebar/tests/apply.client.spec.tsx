import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/** Sidebar shell slot registration and its Session/layout callbacks. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { HeaderLeadingControls } from '../src/client/HeaderLeadingControls.tsx'
import { apply as hostApply } from '../src/index.ts'

const owners = new Set<Fiber>()
afterEach(async () => {
  try {
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
  }
})

function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300 })
}

async function bench(declare = true) {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  const layout = { toggleSidebar: vi.fn(), selectPanel: vi.fn() }
  const uiWorkspace = { startSession: vi.fn(), openSession: vi.fn() }
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('theme', { overrideTokens: vi.fn() } as never)
  ctx.provide('sessions', {
    create: vi.fn(async () => 'created-session'),
    list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }), subscribe: () => () => {} },
  } as never)
  ctx.provide('workspaces', {
    list: {
      getSnapshot: () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
      subscribe: () => () => {},
    },
  } as never)
  ctx.provide('layout', layout)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      { name: 'root', children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
        // These seats are declared so the Cadre contributions into them really
        // register: the surface assertions read stored entries, never source
        // text, and a re-introduced contribution changes them.
        'shell.overlay': { kind: 'list', scope: 'root' },
        'settings.general.item': { kind: 'list', scope: 'root' },
        'sidebar.workspaces.project.row.action': { kind: 'list', scope: 'root' },
        'sidebar.session.row.badge': { kind: 'list', scope: 'root' },
        'sidebar.session.row.subtitle': { kind: 'list', scope: 'root' },
        'sidebar.workspaces.session.menu.item': {
          kind: 'list',
          scope: 'root',
          inject: {
            hooks: {
              // The fixture renders no row menu; the hook only has to satisfy
              // the declaration so the retire entry really registers.
              menuOpenState: ((
                _standard: never,
                state: readonly [boolean, (open: boolean) => void],
              ) => () => state) as never,
              shortcuts: createSnapshotStore<readonly ShortcutCatalogEntry[]>([]),
            },
          },
        },
        'conversation.view': { kind: 'list', scope: 'session' },
      } },
      SidebarFrame,
    )
  }
  return { ctx, slots, layout, uiWorkspace }
}

/** Seats this plugin contributes into; the fixture above declares every one. */
const CADRE_SURFACES = [
  'sidebar.panellist',
  'main',
  'shell.overlay',
  'settings.general.item',
  'sidebar.workspaces.project.row.action',
  'sidebar.session.row.badge',
  'sidebar.session.row.subtitle',
  'sidebar.workspaces.session.menu.item',
  'conversation.view',
] as const satisfies readonly (keyof SlotMap)[]

/** Registration id (or key) of every entry a surface currently holds. */
function entryIds(slots: SlotRegistry, surface: keyof SlotMap): string[] {
  return slots.entries(surface).map(entry => entry.options.id ?? entry.options.key ?? '')
}

/** Every id the plugin registered across its declared surfaces. */
function surfaceIds(slots: SlotRegistry): string[] {
  return CADRE_SURFACES.flatMap(surface => entryIds(slots, surface))
}

/** Bench with this plugin applied. */
async function mounted() {
  const fixture = await bench()
  await fixture.ctx.plugin({ inject: [...inject], apply }).await()
  return fixture
}

describe('ui-sidebar apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('keeps the removed token surface unregistered', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const b = await mounted()
      // Positive half: the Cadre seats are really occupied, so the negative
      // expectations below cannot pass vacuously.
      expect(entryIds(b.slots, 'sidebar.panellist')).toEqual(['cadre-skills'])
      expect(entryIds(b.slots, 'shell.overlay')).toEqual([
        'cadre-create', 'cadre-ledger', 'cadre-retire', 'cadre-skills',
      ])
      // A restored token panel, card, or view would add one more entry here.
      expect(surfaceIds(b.slots).filter(id => /token/i.test(id))).toEqual([])
      // The removed panel read a snapshot over HTTP; nothing may call it now.
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('does not register or call the removed email settings surface', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const b = await mounted()
      expect(entryIds(b.slots, 'settings.general.item')).toEqual(['cadre-update-check'])
      expect(surfaceIds(b.slots).filter(id => /email|mail/i.test(id))).toEqual([])
      expect(fetchSpy.mock.calls.map(([input]) => input instanceof URL
        ? input.href
        : typeof input === 'string' ? input : input.url)).toEqual([])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('registers the skill Conversation view for every Session without a header chip or status strip', async () => {
    const b = await bench()
    const register = vi.spyOn(b.slots, 'register')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(entryIds(b.slots, 'conversation.view')).toEqual(['skills'])
    const skillRegistration = register.mock.calls.find(([options]) => options.name === 'conversation.view')
    expect(skillRegistration?.[0]).not.toHaveProperty('available')
    const skillView = b.slots.entries('conversation.view')[0]!
    expect(skillView.inject?.()['defaultProjectId']).toEqual(expect.any(Function))
    // The removed header chip and status strip were surfaces of their own; no
    // Cadre entry may name one.
    expect(surfaceIds(b.slots).filter(id => /chip|status/i.test(id))).toEqual([])
  })

  it('does not register the removed edit-profile menu', async () => {
    const b = await mounted()
    // The retire row is the only Cadre row-menu entry; an edit-profile row
    // would make this list longer.
    expect(entryIds(b.slots, 'sidebar.workspaces.session.menu.item')).toEqual(['cadre-retire-member'])
  })

  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'theme', 'layout', 'uiWorkspace', 'locale', 'shortcuts', 'sessions', 'workspaces'])
  })

  it('registers the shell and declares its child seats', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar')).toHaveLength(1)
    expect(b.slots.spec('sidebar.brand.mark')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.brand.name')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.workspaces')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.settings')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.footer.action')).toEqual({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('sidebar.panellist')).toEqual({ kind: 'list', scope: 'root' })
    // Localized text rides the standard locale seat, not the inject face.
    expect(b.slots.entries('sidebar')[0]!.locale).toBe('sidebar')
    // The window-chrome occupant reuses the shell's inject face and locale.
    const leading = b.slots.entries('shell.leading')
    expect(leading).toHaveLength(1)
    expect(leading[0]!.component).toBe(HeaderLeadingControls)
    expect(leading[0]!.locale).toBe('sidebar')
    expect(leading[0]!.inject).toBe(b.slots.entries('sidebar')[0]!.inject)
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    expect(Object.keys(injected)).toEqual(['startSession', 'toggleSidebar', 'selectPanel', 'requestCadreCreate', 'refreshCadreSupervisor', 'hooks'])
    expect(injected.hooks.panels.getSnapshot()).toEqual([
      { id: 'cadre-skills', order: 10, label: 'Skills' },
    ])
    expect(b.slots.entries('main').map(entry => entry.options.key)).toEqual(['cadre-skills'])
    const skillInjected = b.slots.entries('main')[0]!.inject?.()
    const openSession = skillInjected?.['openSession']
    if (typeof openSession !== 'function') throw new Error('skill library openSession injection is missing')
    openSession('skill-session')
    expect(b.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('skill-session')
    // Both arms delegate to the Workspace UI's shared New Session action.
    injected.startSession('workspace' as never)
    expect(b.uiWorkspace.startSession).toHaveBeenCalledWith('workspace')
    injected.startSession()
    expect(b.uiWorkspace.startSession).toHaveBeenLastCalledWith(undefined)
    injected.toggleSidebar()
    expect(b.layout.toggleSidebar).toHaveBeenCalledOnce()
    const panelId = 'custom-panel' as MainPanelId
    injected.selectPanel(panelId)
    expect(b.layout.selectPanel).toHaveBeenCalledExactlyOnceWith(panelId)
    expectTypeOf<Parameters<SidebarRootInjected['selectPanel']>[0]>().toEqualTypeOf<MainPanelId>()
  })

  it('waits for the sidebar declaration before registering', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar')).toHaveLength(0)
    const disposeRoot = b.slots.register({
      name: 'root',
      children: { sidebar: { kind: 'single', scope: 'root' } },
    }, SidebarFrame)
    expect(b.slots.entries('sidebar')).toHaveLength(1)
    disposeRoot()
    await fiber.dispose()
  })

  it('projects plugin-owned panel entries and removes them with their owner', async () => {
    const b = await bench()
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    const panel = b.ctx.plugin({
      inject: ['slots'],
      apply(ctx: Context) {
        ctx.slots.register({ name: 'main', key: 'custom-panel' }, () => 'Custom panel')
        ctx.slots.register({
          name: 'sidebar.panellist', id: 'custom-panel', order: 20, label: 'Custom panel',
        }, () => null)
      },
    })
    try {
      await panel.await()
      await vi.waitFor(() => {
        expect(injected.hooks.panels.getSnapshot()).toEqual([
          { id: 'cadre-skills', order: 10, label: 'Skills' },
          { id: 'custom-panel', order: 20, label: 'Custom panel' },
        ])
      })
      expect(b.slots.entries('main').map(entry => entry.options.key)).toEqual(['cadre-skills', 'custom-panel'])
      await panel.dispose()
      await vi.waitFor(() => { expect(injected.hooks.panels.getSnapshot()).toEqual([
        { id: 'cadre-skills', order: 10, label: 'Skills' },
      ]) })
      expect(b.slots.entries('main').map(entry => entry.options.key)).toEqual(['cadre-skills'])
    } finally {
      await panel.dispose()
      await sidebar.dispose()
    }
  })

  it('removes the entry and child declaration on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar')).toHaveLength(0)
    expect(b.slots.entries('shell.leading')).toHaveLength(0)
    expect(b.slots.spec('sidebar.brand.mark')).toBeUndefined()
    expect(b.slots.spec('sidebar.brand.name')).toBeUndefined()
    expect(b.slots.spec('sidebar.workspaces')).toBeUndefined()
    expect(b.slots.spec('sidebar.footer.action')).toBeUndefined()
    expect(b.slots.spec('sidebar.panellist')).toBeUndefined()
    expect(b.slots.entries('main')).toHaveLength(0)
  })
})
