/**
 * Cadre employee surfaces (ADR-0022 T3/T4).
 *
 * The Session row menu raises one overlay dialog: promote a Session to an
 * employee, or edit the employee it already is. The dialog reads the official
 * agent-preset roster and the official model catalog; on submit it applies the
 * preset (blank Sessions only), applies the model through `session.selectModel`,
 * then records the employee row through the desktop bridge. Every step reports
 * its own structured failure — nothing is reported as saved unless it is.
 *
 * The row-leading badge reads the same employee roster; an empty roster leaves
 * the 16px seat empty rather than rendering a placeholder.
 */
import { useEffect, useState } from 'react'
import {
  Button, IconUserOutlineRegular, IconUsersOutlineRegular, Input, MenuItemButton, Modal, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CadreEmployee.module.css'

/**
 * Local view of the two ui-workspace seats this package occupies. The owner
 * declares them; declaring them here keeps ui-sidebar (a dependency of
 * ui-workspace) from importing ui-workspace's client program back.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.workspaces.session.menu.item': {
      kind: 'list'
      scope: 'root'
      owner: { readonly sessionId: string; readonly displayTitle: string }
      hookContext: readonly [open: boolean, setOpen: (open: boolean) => void]
      inject: { hooks: {
        menuOpenState: SlotHookFactory<'sidebar.workspaces.session.menu.item', () => readonly [open: boolean, setOpen: (open: boolean) => void]>
      } }
    }
    'sidebar.session.row.leading': {
      kind: 'list'
      scope: 'root'
      owner: { readonly sessionId: string }
    }
  }
}

/** One employee row as `cadre:listEmployees` returns it. */
export interface EmployeeRecord {
  readonly sessionId: string
  readonly projectId?: string
  readonly displayName?: string
  readonly templateId?: string
  readonly personaNote?: string
  readonly preferredProviderId?: string
  readonly preferredModel?: string
}

/** One bridge write; `null` clears a column, `undefined` keeps it. */
export interface EmployeeWrite {
  readonly sessionId: string
  readonly displayName?: string | null
  readonly templateId?: string | null
  readonly personaNote?: string | null
  readonly preferredProviderId?: string | null
  readonly preferredModel?: string | null
}

/** Shared employee roster state (plugin-level store). */
export interface EmployeeListState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly employees: readonly EmployeeRecord[]
  /** `code · message` when the roster read failed. */
  readonly error: string | null
}

/** One pending dialog request raised by the row menu. */
export interface EmployeeDialogRequest {
  readonly sessionId: string
  readonly displayTitle: string
}

/** One official preset reduced to what the dialog renders. */
export interface PresetOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly broken?: string
  readonly isDefault?: boolean
}

/** One provider group from `session/modelCatalog`. */
export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: { readonly defaultEffort?: string }
}

export interface CatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
}

/** Structured outcome of one submit step. */
export interface StepOutcome {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
}

export type Load<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string }

/** Full model catalog reduced for both employee surfaces. */
export interface ModelCatalog {
  readonly groups: readonly CatalogGroup[]
  readonly defaultProvider: string
  readonly defaultModel: string
}

/** Menu entry face. */
export interface EmployeeMenuInjected {
  hooks: { employees: HostObservable<EmployeeListState> }
  openEmployeeDialog: (request: EmployeeDialogRequest) => void
}

/** Row-leading badge face. */
export interface EmployeeBadgeInjected {
  hooks: { employees: HostObservable<EmployeeListState> }
}

/** Overlay dialog face: every read and write the dialog performs. */
export interface EmployeeDialogInjected {
  hooks: {
    request: HostObservable<EmployeeDialogRequest | null>
  }
  closeEmployeeDialog: () => void
  getEmployee: (sessionId: string) => Promise<{ ok: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  listPresets: () => Promise<Load<readonly PresetOption[]>>
  loadModels: () => Promise<Load<ModelCatalog>>
  isBlank: (sessionId: string) => boolean | undefined
  /** Preset the Session currently projects, used to roll back a partial submit. */
  currentPreset: (sessionId: string) => string | undefined
  applyPreset: (sessionId: string, presetId: string) => Promise<StepOutcome>
  applyModel: (sessionId: string, providerId: string, modelId: string, reasoningEffort?: string) => Promise<StepOutcome>
  saveEmployee: (input: EmployeeWrite) => Promise<StepOutcome & { employee?: EmployeeRecord }>
  refreshEmployees: () => void
}

/** `code · message` for one structured failure; shared by both employee surfaces. */
export function failureText(outcome: { readonly code?: string; readonly message?: string } | undefined): string {
  return `${outcome?.code ?? 'UNKNOWN'} · ${outcome?.message ?? '未知错误'}`
}

/**
 * Employee templates are the registered `cadre-*` presets. A Session running
 * any other preset (for example the official `standard`) is not an employee
 * template, so the column stays NULL rather than recording a foreign id.
 */
const CADRE_TEMPLATE_ID = /^cadre-[a-z0-9][a-z0-9-]{0,63}$/

/** Template glyphs keep the 16px badge legible; unknown templates fall back to 员. */
const TEMPLATE_GLYPHS: Record<string, string> = {

  'cadre-dev': '开',
  'cadre-novel': '写',
  'cadre-general': '通',
  'cadre-roleplay': '扮',
}

function glyphOf(employee: EmployeeRecord): string {
  return (employee.templateId === undefined ? undefined : TEMPLATE_GLYPHS[employee.templateId]) ?? '员'
}

function badgeTitle(employee: EmployeeRecord): string {
  const name = employee.displayName ?? employee.sessionId
  const template = employee.templateId ?? '未设模板'
  return `员工 · ${name} · ${template}`
}

/**
 * Row menu entry: 「转为员工」 for a Session that is not an employee yet,
 * 「员工设置」 once `cadre:listEmployees` reports one.
 */
export function EmployeeMenuItem({
  sessionId, displayTitle, useMenuOpenState, useEmployees, openEmployeeDialog,
}: PropsRuntime<'sidebar.workspaces.session.menu.item'> & InjectFace<EmployeeMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const employees = useEmployees(state => state.employees)
  const employee = employees.find(row => row.sessionId === sessionId)
  return (
    <MenuItemButton
      icon={employee === undefined ? <IconUserOutlineRegular /> : <IconUsersOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        openEmployeeDialog({ sessionId, displayTitle })
      }}
    >
      {employee === undefined ? '转为员工' : '员工设置'}
    </MenuItemButton>
  )
}

/** Row-leading badge; renders nothing when this Session is not an employee. */
export function EmployeeRowBadge({
  sessionId, useEmployees,
}: PropsRuntime<'sidebar.session.row.leading'> & InjectFace<EmployeeBadgeInjected>) {
  const employees = useEmployees(state => state.employees)
  const employee = employees.find(row => row.sessionId === sessionId)
  if (employee === undefined) return null
  return (
    <span className={css.badge} title={badgeTitle(employee)} aria-label={badgeTitle(employee)}>
      {glyphOf(employee)}
    </span>
  )
}

/** Overlay entry: nothing until a row asks for the dialog. */
export function EmployeeDialog({ useRequest, ...actions }: InjectFace<EmployeeDialogInjected>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return <EmployeeDialogForm key={request.sessionId} request={request} {...actions} />
}

interface DialogError {
  readonly step: string
  readonly code: string
  readonly message: string
  readonly hint: string
}

/** One request's dialog; all state dies with the key. */
function EmployeeDialogForm({ request, closeEmployeeDialog, getEmployee, listPresets, loadModels, isBlank, currentPreset, applyPreset, applyModel, saveEmployee, refreshEmployees }: {
  readonly request: EmployeeDialogRequest
} & Omit<InjectFace<EmployeeDialogInjected>, 'useRequest'>) {
  const [loading, setLoading] = useState(true)
  const [employee, setEmployee] = useState<EmployeeRecord | null>(null)
  const [presets, setPresets] = useState<Load<readonly PresetOption[]>>({ ok: true, value: [] })
  const [models, setModels] = useState<Load<{ groups: readonly CatalogGroup[]; defaultProvider: string; defaultModel: string }>>({
    ok: true, value: { groups: [], defaultProvider: '', defaultModel: '' },
  })
  const [displayName, setDisplayName] = useState(request.displayTitle)
  const [templateId, setTemplateId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<DialogError | null>(null)
  const [saved, setSaved] = useState(false)
  const [employeeError, setEmployeeError] = useState<DialogError | null>(null)
  // Remembered before any write so a failed later step can put the composition
  // back; a blank Session's projection is authoritative until the first turn.
  const [originalPreset] = useState(() => currentPreset(request.sessionId))

  const blank = isBlank(request.sessionId)

  const applyModels = (loaded: Load<{ groups: readonly CatalogGroup[]; defaultProvider: string; defaultModel: string }>, record: EmployeeRecord | null) => {
    setModels(loaded)
    if (!loaded.ok) {
      setProviderId('')
      setModelId('')
      return
    }
    const preferredProvider = record?.preferredProviderId
    const preferredModel = record?.preferredModel
    const hasPreferred = preferredProvider !== undefined && preferredModel !== undefined
      && loaded.value.groups.some(group => group.id === preferredProvider
        && group.models.some(model => model.id === preferredModel))
    if (preferredProvider !== undefined && preferredModel !== undefined && hasPreferred) {
      setProviderId(preferredProvider)
      setModelId(preferredModel)
      const selected = loaded.value.groups
        .find(group => group.id === preferredProvider)?.models
        .find(model => model.id === preferredModel)
      setReasoningEffort(selected?.reasoning?.defaultEffort)
      return
    }
    setProviderId(loaded.value.defaultProvider)
    setModelId(loaded.value.defaultModel)
    const selected = loaded.value.groups
      .find(group => group.id === loaded.value.defaultProvider)?.models
      .find(model => model.id === loaded.value.defaultModel)
    setReasoningEffort(selected?.reasoning?.defaultEffort)
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setEmployeeError(null)
      const listed = await getEmployee(request.sessionId)
      if (cancelled) return
      const record = listed.ok ? listed.employee ?? null : null
      setEmployee(record)
      if (!listed.ok) {
        setEmployeeError({
          step: '读取员工记录',
          code: listed.code ?? 'UNKNOWN',
          message: listed.message ?? '未知错误',
          hint: '请确认 desktop 主进程已注册 cadre:getEmployee；本次仍可尝试保存。',
        })
      } else {
        setDisplayName(record?.displayName ?? request.displayTitle)
        if (record?.templateId !== undefined) setTemplateId(record.templateId)
      }
      const [presetList, modelList] = await Promise.all([listPresets(), loadModels()])
      if (cancelled) return
      setPresets(presetList)
      if (presetList.ok) {
        // An existing row wins; otherwise a non-blank Session shows the preset it
        // actually runs, which is what saving will record.
        const projected = blank === false && originalPreset !== undefined && CADRE_TEMPLATE_ID.test(originalPreset)
          ? originalPreset
          : undefined
        const recorded = record?.templateId ?? projected
        const listed = recorded !== undefined && presetList.value.some(preset => preset.id === recorded)
        const fallback = presetList.value.find(preset => preset.broken === undefined)?.id ?? ''
        setTemplateId(listed ? recorded : (recorded ?? fallback))
      }
      applyModels(modelList, record)
      setLoading(false)
    }
    void run()
    return () => { cancelled = true }
  }, [request.sessionId])

  const retryPresets = async () => {
    const listed = await listPresets()
    setPresets(listed)
    if (listed.ok && templateId === '') {
      setTemplateId(listed.value.find(preset => preset.broken === undefined)?.id ?? '')
    }
  }

  const retryModels = async () => {
    const loaded = await loadModels()
    applyModels(loaded, employee)
  }

  const selectModel = (group: CatalogGroup, model: CatalogModel) => {
    setProviderId(group.id)
    setModelId(model.id)
    setReasoningEffort(model.reasoning?.defaultEffort)
    setError(null)
  }

  const templateEnabled = blank === true && !pending
  const blocked = pending || saved || loading || displayName.trim() === ''
  const presetLabel = (id: string): string => (presets.ok
    ? presets.value.find(preset => preset.id === id)?.name
    : undefined) ?? id
  const defaultPreset = presets.ok ? presets.value.find(preset => preset.isDefault)?.id : undefined

  const submit = async () => {
    if (blocked) return
    setPending(true)
    setError(null)
    const applied: string[] = []
    let appliedPreset: string | undefined
    /** Put a blank Session's composition back after a later step failed. */
    const rollbackPreset = async (): Promise<string> => {
      if (appliedPreset === undefined) return ''
      const target = originalPreset ?? defaultPreset
      if (target === undefined || target === '') {
        return `模板已切换为「${presetLabel(appliedPreset)}」，无法确认原模板，未能自动回滚；`
      }
      const back = await applyPreset(request.sessionId, target)
      return back.ok
        ? `模板已回滚为「${presetLabel(target)}」；`
        : `模板已切换为「${presetLabel(appliedPreset)}」，自动回滚失败（${back.code ?? 'UNKNOWN'} · ${back.message ?? '未知错误'}）；`
    }

    if (blank === true && templateId !== '') {
      const preset = await applyPreset(request.sessionId, templateId)
      if (!preset.ok) {
        setPending(false)
        setError({
          step: '模板应用',
          code: preset.code ?? 'UNKNOWN',
          message: preset.message ?? '未知错误',
          hint: '模板未切换，员工记录未写入；会话仍处于空白状态，可直接重试。',
        })
        return
      }
      appliedPreset = templateId
      applied.push('模板已应用')
    }

    if (providerId !== '' && modelId !== '') {
      const model = await applyModel(request.sessionId, providerId, modelId, reasoningEffort)
      if (!model.ok) {
        const rollback = await rollbackPreset()
        setPending(false)
        setError({
          step: '模型应用',
          code: model.code ?? 'UNKNOWN',
          message: model.message ?? '未知错误',
          hint: `${rollback}员工记录尚未写入。检查 Provider 凭据后可在本对话框直接重试。`,
        })
        return
      }
      applied.push('模型已应用')
    }

    // A non-blank Session keeps the composition it started with, so the employee
    // template records that projected preset instead of staying NULL. Presets
    // outside `cadre-*` are not employee templates and leave the column empty.
    const projectedTemplate = blank === false && originalPreset !== undefined && CADRE_TEMPLATE_ID.test(originalPreset)
      ? originalPreset
      : undefined
    const writtenTemplate = blank === true && templateId !== '' ? templateId : projectedTemplate
    const savedResult = await saveEmployee({
      sessionId: request.sessionId,
      displayName: displayName.trim(),
      ...(writtenTemplate === undefined ? {} : { templateId: writtenTemplate }),
      ...(providerId !== '' && modelId !== '' ? { preferredProviderId: providerId, preferredModel: modelId } : {}),
    })
    if (!savedResult.ok) {
      const rollback = await rollbackPreset()
      const modelText = applied.includes('模型已应用') ? `模型已切换为 ${providerId}/${modelId}；` : ''
      setPending(false)
      setError({
        step: '员工记录保存',
        code: savedResult.code ?? 'UNKNOWN',
        message: savedResult.message ?? '未知错误',
        hint: `${rollback}${modelText}员工记录尚未写入；修正后可在本对话框直接重试。`,
      })
      return
    }

    const verified = await getEmployee(request.sessionId)
    if (!verified.ok || verified.employee == null) {
      setPending(false)
      setError({
        step: '保存后回读校验',
        code: verified.ok ? 'NOT_FOUND' : (verified.code ?? 'UNKNOWN'),
        message: verified.ok ? '回读未找到员工记录' : (verified.message ?? '未知错误'),
        hint: '写入已返回成功但未读到记录，不能视为完成；请重新打开对话框核对。',
      })
      refreshEmployees()
      return
    }

    refreshEmployees()
    setEmployee(verified.employee)
    setPending(false)
    setSaved(true)
  }

  const presetRows = presets.ok
    ? presets.value.filter(preset => preset.broken === undefined)
    : []
  const brokenRows = presets.ok ? presets.value.filter(preset => preset.broken !== undefined) : []
  const selectedPreset = presetRows.find(preset => preset.id === templateId)

  const blankHint = blank === true
    ? '当前会话尚未开始第一轮，可选择模板；模板的人格与工具会从本会话生效。'
    : blank === false
      ? '当前会话已开始，模板控件已禁用；模板的人格与工具从下一个新建会话生效，本次仍可改显示名与模型。'
      : '无法确认会话是否已开始（会话列表中未找到该会话）；为避免误改模板，模板控件已禁用。仍可改显示名与模型。'

  const title = employee === null ? '转为员工' : '员工设置'

  return (
    <Modal
      open
      onClose={() => { if (!pending) closeEmployeeDialog() }}
      closeLabel="关闭"
      title={title}
      description={`会话 ${request.sessionId}`}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={() => { closeEmployeeDialog() }}>{saved ? '完成' : '取消'}</Button>
          {!saved && <Button variant="primary" disabled={blocked} onClick={() => { void submit() }}>{pending ? '保存中…' : '保存'}</Button>}
        </>
      )}
    >
      <div className={css.body}>
        {loading && (
          <div className={css.loadingRow} role="status" aria-busy="true">
            <StateDot state="ongoing" />
            <span>读取模板、模型目录与员工记录…</span>
          </div>
        )}

        {employeeError !== null && (
          <p className={css.error} role="alert">
            <span>{employeeError.step}失败：{employeeError.code} · {employeeError.message}</span>
            <span className={css.hint}>{employeeError.hint}</span>
          </p>
        )}

        {!loading && (<>
        <div className={css.field}>
          <label className={css.label} htmlFor="cadre-employee-name">显示名</label>
          <Input
            id="cadre-employee-name"
            value={displayName}
            disabled={pending || saved}
            placeholder="员工显示名（默认会话标题）"
            onChange={event => { setDisplayName(event.target.value); setError(null) }}
          />
          {displayName.trim() === '' && <p className={css.hint}>显示名不能为空。</p>}
        </div>

        <div className={css.field}>
          <span className={css.label}>模板</span>
          <p className={css.hint}>{blankHint}</p>
          {!presets.ok && (
            <p className={css.error} role="alert">
              <span>模板列表读取失败：{presets.code} · {presets.message}</span>
              <span className={css.hint}>检查 Host 是否已加载 agent-preset-registry；本次仍可保存显示名与模型。</span>
            </p>
          )}
          {presets.ok && presetRows.length === 0 && (
            <p className={css.notice}>未发现 cadre-* 模板。请确认 cadre-dev / cadre-novel / cadre-general / cadre-roleplay 已注册；模板缺失时仍可保存显示名与模型。</p>
          )}
          {presetRows.length > 0 && (
            <div className={css.options} role="radiogroup" aria-label="员工模板">
              {presetRows.map(preset => (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={templateId === preset.id ? 'primary' : 'outline'}
                  role="radio"
                  aria-checked={templateId === preset.id}
                  disabled={!templateEnabled}
                  onClick={() => { setTemplateId(preset.id); setError(null) }}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          )}
          {selectedPreset?.description !== undefined && (
            <p className={css.hint}>{selectedPreset.description}</p>
          )}

          {brokenRows.length > 0 && (
            <p className={css.hint}>另有 {brokenRows.length} 个 cadre-* 模板不可用：{brokenRows.map(preset => preset.id).join('、')}。</p>
          )}
          {!presets.ok && (
            <div><Button variant="outline" size="sm" disabled={pending} onClick={() => { void retryPresets() }}>重试模板列表</Button></div>
          )}
        </div>

        <div className={css.field}>
          <span className={css.label}>模型</span>
          {!models.ok && (
            <p className={css.error} role="alert">
              <span>模型目录读取失败：{models.code} · {models.message}</span>
              <span className={css.hint}>本次不会调用 selectModel；修正后可重试。已选中的 provider/模型不会写入。</span>
            </p>
          )}
          {models.ok && models.value.groups.length === 0 && (
            <p className={css.notice}>官方模型目录为空：请先在设置 → 模型 Providers 中添加可用厂商，再回来选择模型。</p>
          )}
          {models.ok && models.value.groups.length > 0 && (
            <div className={css.groups} role="radiogroup" aria-label="员工模型">
              {models.value.groups.map(group => (
                <div key={group.id} className={css.group}>
                  <span className={css.groupName}>{group.name}</span>
                  <div className={css.options}>
                    {group.models.map(model => {
                      const selected = providerId === group.id && modelId === model.id
                      return (
                        <Button
                          key={`${group.id}/${model.id}`}
                          size="sm"
                          variant={selected ? 'primary' : 'outline'}
                          role="radio"
                          aria-checked={selected}
                          disabled={pending || saved}
                          onClick={() => { selectModel(group, model) }}
                        >
                          {model.name}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!models.ok && (
            <div><Button variant="outline" size="sm" disabled={pending} onClick={() => { void retryModels() }}>重试模型目录</Button></div>
          )}
        </div>

        {models.ok && models.value.groups.length === 0 && (
          <p className={css.hint}>没有可路由模型时，本次只保存员工记录。</p>
        )}
        </>)}

        {error !== null && (
          <p className={css.error} role="alert">
            <span>{error.step}失败：{error.code} · {error.message}</span>
            <span className={css.hint}>{error.hint}</span>
          </p>
        )}

        {saved && <p className={css.success} role="status">员工设置已保存，行内徽标已刷新。</p>}
      </div>
    </Modal>
  )
}
