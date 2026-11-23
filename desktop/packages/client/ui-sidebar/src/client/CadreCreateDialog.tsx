/**
 * Create dialog for the sidebar's project-row ＋ and New Session menu.
 *
 * The dialog owns only the identity form; Session creation and the roster
 * write stay in the plugin index (one seam for every entry point). It never
 * asks the user to leave the sidebar: a successful create opens the new
 * Session immediately.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  loadCustomRoles, removeCustomRole, saveCustomRole,
  type CustomRole,
} from './cadre-roster-source.ts'
import css from './CadreCreateDialog.module.css'
import type { SidebarKey } from './locales.ts'

const INK_PRIMARY = 'var(--dsw-alias-label-primary)'
const BODY_TEXTAREA: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  resize: 'vertical',
  font: 'inherit',
  padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: INK_PRIMARY,
}

/** A create request raised by a ＋ menu. */
export interface CadreCreateRequest {
  readonly kind: 'supervisor' | 'worker'
  readonly token: number
  /** The project (official Workspace id) the new member belongs to. */
  readonly workspaceId?: string
  /** Display title of that project, resolved by the requester. */
  readonly projectLabel?: string
}

type RoleGroup = 'dev' | 'novel' | 'general'

interface RoleTemplate {
  readonly id: string
  readonly name: string
  readonly duty: string
}

const ROLE_GROUPS: readonly { readonly id: RoleGroup; readonly labelKey: SidebarKey }[] = [
  { id: 'dev', labelKey: 'create.group.dev' },
  { id: 'novel', labelKey: 'create.group.novel' },
  { id: 'general', labelKey: 'create.group.general' },
]

/** Role templates (product-model §4); picking one fills name and duty. */
const ROLE_TEMPLATES: Readonly<Record<RoleGroup, readonly RoleTemplate[]>> = {
  dev: [
    { id: 'dev-backend', name: '后端', duty: '负责服务端接口、数据模型与业务逻辑。先读现有约定再改，保持兼容并可测试；交付说明接口变更与验证方式。不做界面视觉检查与代码审查，结构决策先问架构师。' },
    { id: 'dev-frontend', name: '前端', duty: '负责按设计师规格实现界面与交互。复用既有组件与设计令牌，覆盖加载、空与错误状态；交付附关键截图与自测结论。不自行做视觉设计决策（争议交设计师），不替他人审查代码。' },
    { id: 'dev-test', name: '测试', duty: '负责用例设计、执行与回归，黑盒优先：实际操作页面与接口验证，失败给截图与可复现步骤。覆盖正常与边界路径，定位根因给出证据，不为通过而修改产品代码，不做代码级审查。' },
    { id: 'dev-review', name: '代码审查', duty: '负责深读改动代码，审查正确性、安全性与可维护性。指出具体文件与行号，区分必须修改与建议，不替作者重写。界面视觉问题交设计师，运行行为问题交测试，不重复它们的检查。' },
    { id: 'dev-design', name: '设计师', duty: '负责 UI 与交互设计：基于现有设计体系给出可落地的布局、状态与文案规格。验证页面用浏览器截图检查对齐、间距、状态与交互反馈，交付附截图与位置说明的界面检查结论。非必要不读代码；确需定位视觉问题根因时只定点读对应组件，把线索交给前端，不改代码。' },
    { id: 'dev-docs', name: '技术文档', duty: '负责使用指南、交付记录与说明文档，以代码与实测为依据，写清结论、证据与未验证项。项目结构文档与架构决策归架构师，本文档岗不重复；不改业务代码。' },
    { id: 'dev-ops', name: '运维脚本', duty: '负责构建、部署与排障脚本。优先幂等与可回滚，危险操作显式确认并保留原始日志，不擅自修改共享配置。不改业务代码。' },
    { id: 'dev-ue', name: '虚幻引擎开发', duty: '负责 UE 蓝图、C++ 与资源集成。遵循项目现有模块划分与性能预算，交付可复现的构建与运行步骤。' },
    { id: 'dev-architect', name: '架构师', duty: '负责当前项目的结构思考与技术咨询：梳理模块边界、依赖关系与数据流，产出结构文档；回答组长的技术问题，给约束、备选与代价，体现专业判断。只写文档与方案，不改业务代码，不做代码审查与测试。' },
  ],
  novel: [
    { id: 'novel-writer', name: '写作', duty: '负责章节正文创作。保持人物口吻与叙事节奏一致，按大纲推进，交付成稿并标注本次修改点。' },
    { id: 'novel-plot', name: '故事策划', duty: '负责世界观、主线与章节大纲。给出冲突推进与人物弧光，明确取舍，不直接代写正文。' },
    { id: 'novel-lore', name: '设定编辑', duty: '负责设定库与一致性校验。维护人物、地点与时间线，发现矛盾先列证据再改，不擅自推翻既有设定。' },
    { id: 'novel-copyedit', name: '文字编辑', duty: '负责润色与校对。统一语体、修正语病与标点，保留作者风格，交付修改说明而不是静默改写。' },
    { id: 'novel-art', name: '绘画师', duty: '负责插画与视觉设定。按文本气质确定构图、色彩与风格，交付可追溯的素材与使用说明。' },
    { id: 'novel-translate', name: '翻译', duty: '负责中英互译与术语统一。忠于原意并保留语气，建立专名对照表，交付双语对照稿。' },
  ],
  general: [
    { id: 'general-plan', name: '策划', duty: '负责把目标拆成可执行方案。给出范围、步骤、依赖与验收标准，标明假设与风险，不空谈方向。' },
    { id: 'general-research', name: '资料整理', duty: '负责检索、筛选与归纳资料。标注来源与时间，区分事实与推测，交付结构化摘要与原始链接。' },
    { id: 'general-proposal', name: '方案撰写', duty: '负责把需求写成可评审的方案。结论先行，论据可核查，列出备选与代价，控制篇幅。' },
    { id: 'general-quality', name: '质量检查', duty: '负责按清单核验交付物（文档、界面截图、运行结果），逐项给通过/不通过与证据。代码改动审查归代码审查岗，界面视觉归设计师，不重复；不用口头保证代替检查。' },
    { id: 'general-coord', name: '协作协调', duty: '负责对齐任务边界与进度。记录谁在做什么、卡在哪里，及时升级冲突，不替他人做专业决策。' },
  ],
}

interface ProviderOption {
  readonly providerId: string
  readonly name: string
  readonly defaultModel: string
  readonly models?: readonly {
    readonly id: string
    readonly reasoning?: {
      readonly efforts?: readonly { readonly id: string; readonly name?: string }[]
      readonly defaultEffort?: string
    }
  }[]
  readonly enabled?: boolean
}

interface RosterRow {
  readonly sessionId: string
  readonly role: string
  readonly displayName?: string
  readonly state?: string
}

interface CadreCreateBridge {
  listRoster?(query: { projectId: string }): Promise<{
    members?: readonly RosterRow[]
    rows?: readonly RosterRow[]
    warning?: { readonly code?: string; readonly message?: string }
  } | undefined>
  listProviders?(): Promise<{
    ok?: boolean
    providers?: readonly ProviderOption[]
    code?: string
    message?: string
  } | undefined>
  bindSession?(query: {
    sessionId: string
    providerId: string
    model: string
    reasoningEffort?: string
  }): Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  reportIn?: (query: {
    sessionId: string
    projectId: string
    role: 'supervisor' | 'worker'
    displayName: string
    duty?: string
  }) => Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
}

/**
 * Provider → model → reasoning-effort picker shared by both create forms.
 *
 * Supervisor creation is a singleton, but the model choice is the same shape
 * as an employee's; keeping one picker avoids the two forms drifting apart.
 * @returns the three radio groups, or a hint when no provider is configured.
 */
function ProviderModelPicker({
  providers, providerId, modelId, effortId, onProvider, onModel, onEffort, t,
}: {
  readonly providers: readonly ProviderOption[]
  readonly providerId: string
  readonly modelId: string
  readonly effortId: string
  readonly onProvider: (providerId: string, defaultModel: string) => void
  readonly onModel: (modelId: string) => void
  readonly onEffort: (effortId: string) => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const selectedProvider = providers.find(provider => provider.providerId === providerId)
  const models = selectedProvider?.models ?? []
  const efforts = selectedProvider?.models?.find(model => model.id === modelId)?.reasoning?.efforts ?? []
  return (
    <>
      <span className={css.sectionTitle}>{t('create.providerSection')}</span>
      {providers.length === 0
        ? <span className={css.hint}>{t('create.noProvider')}</span>
        : (
          <div className={css.grid} role="radiogroup" aria-label={t('create.providerAria')}>
            {providers.map(provider => (
              <Button
                key={provider.providerId}
                variant={providerId === provider.providerId ? 'primary' : 'outline'}
                onClick={() => { onProvider(provider.providerId, provider.defaultModel) }}
              >
                {provider.name}
              </Button>
            ))}
          </div>
        )}
      {models.length > 0 && (
        <div className={css.grid} role="radiogroup" aria-label={t('create.modelAria')}>
          {models.map(model => (
            <Button
              key={model.id}
              variant={modelId === model.id ? 'primary' : 'outline'}
              onClick={() => { onModel(model.id) }}
            >
              {model.id}
            </Button>
          ))}
        </div>
      )}
      {efforts.length > 0 && (
        <div className={css.grid} role="radiogroup" aria-label={t('create.effortAria')}>
          {efforts.map(effort => (
            <Button
              key={effort.id}
              variant={effortId === effort.id ? 'primary' : 'outline'}
              onClick={() => { onEffort(effort.id) }}
            >
              {effort.name ?? effort.id}
            </Button>
          ))}
        </div>
      )}
    </>
  )
}

/** Injected create seam: the plugin owns Session + roster writes and navigation. */
export interface CadreCreateInjected {
  hooks: { createRequest: HostObservable<CadreCreateRequest | null> }
  closeCreate: () => void
  createRosterEntry(input: {
    role: 'supervisor' | 'worker'
    displayName: string
    description?: string
    /** Short job title shown on the Session row (template name). */
    position?: string
    workspaceId?: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }>
  refreshSupervisor: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wide create dialog (680px at desktop sizes); supervisor and worker share
 * the same shell so their width and spacing stay aligned.
 */
export function CadreCreateDialog({
  useCreateRequest, closeCreate, createRosterEntry, refreshSupervisor, t,
}: PropsRuntime<'shell.overlay'> & InjectFace<CadreCreateInjected> & PropsLocale<'sidebar'>) {
  const request = useCreateRequest(value => value)
  if (request === null) return null
  return (
    <CadreCreateForm
      key={request.token}
      request={request}
      closeCreate={closeCreate}
      createRosterEntry={createRosterEntry}
      refreshSupervisor={refreshSupervisor}
      t={t}
    />
  )
}

function CadreCreateForm({
  request, closeCreate, createRosterEntry, refreshSupervisor, t,
}: {
  readonly request: CadreCreateRequest
  readonly t: PropsLocale<'sidebar'>['t']
} & Omit<CadreCreateInjected, 'hooks' | 'useCreateRequest'>) {
  const bridge = (): CadreCreateBridge | undefined => (window as unknown as { cadre?: CadreCreateBridge }).cadre
  const kind = request.kind
  const [supervisor, setSupervisor] = useState<RosterRow | undefined>(undefined)
  // The supervisor is a singleton role: its default name is the role itself.
  const [name, setName] = useState(kind === 'supervisor' ? t('role.supervisor') : '')
  const [duty, setDuty] = useState('')
  const [position, setPosition] = useState('')
  const [templateGroup, setTemplateGroup] = useState<RoleGroup>('dev')
  const [templateId, setTemplateId] = useState('')
  const [saveAsCustom, setSaveAsCustom] = useState(false)
  const [customRoles, setCustomRoles] = useState<readonly CustomRole[]>(() => loadCustomRoles())
  const [providers, setProviders] = useState<readonly ProviderOption[]>([])
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [effortId, setEffortId] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const list = bridge()
    const read = list?.listProviders
    if (read === undefined) {
      // Model choice is optional for both roles; only the employee form has
      // always required the catalogue, so keep that error and leave the
      // supervisor form usable without it.
      if (kind === 'worker') setError(t('create.providerChannelMissing'))
    } else {
      void read().then((result) => {
        if (cancelled) return
        if (result?.ok === false) {
          setProviders([])
          if (kind === 'worker') setError(t('create.catalogFailed', { message: result.message ?? result.code ?? t('error.unknown') }))
          return
        }
        const usable = (result?.providers ?? []).filter(provider => provider.enabled !== false)
        setProviders(usable)
        const first = usable[0]
        if (first !== undefined) {
          setProviderId(first.providerId)
          setModelId(first.defaultModel)
        }
      }).catch((reason: unknown) => {
        if (!cancelled && kind === 'worker') setError(t('create.providersFailed', { message: errorMessage(reason) }))
      })
    }
    if (kind === 'supervisor') {
      const projectId = request.workspaceId
      const roster = list?.listRoster
      if (projectId === undefined || roster === undefined) return () => { cancelled = true }
      void roster({ projectId }).then((result) => {
        if (cancelled) return
        const members = result?.members ?? result?.rows ?? []
        setSupervisor(members.find(member => member.role === 'supervisor' && member.state !== 'departed'))
      }).catch(() => { /* the create call remains the authority */ })
    }
    return () => { cancelled = true }
  }, [kind, t])

  const applyTemplate = (template: RoleTemplate): void => {
    setTemplateId(template.id)
    setName(template.name)
    setPosition(template.name)
    setDuty(template.duty)
  }

  const submit = async (): Promise<void> => {
    const displayName = name.trim()
    if (displayName === '') {
      setError(kind === 'supervisor' ? t('create.nameRequired.supervisor') : t('create.nameRequired.worker'))
      return
    }
    if (kind === 'worker' && duty.trim() === '') {
      setError(t('create.dutyRequired'))
      return
    }
    if (kind === 'supervisor' && supervisor !== undefined) {
      setError(t('create.supervisorExists', { name: supervisor.displayName ?? supervisor.sessionId }))
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await createRosterEntry({
        role: kind,
        displayName,
        ...(kind === 'worker' ? { description: duty.trim() } : {}),
        ...(kind === 'worker' && position.trim() !== '' ? { position: position.trim() } : {}),
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      })
      if (!result.ok) {
        setError(`${result.code} · ${result.message}`)
        return
      }
      let warning: string | undefined
      // Both roles may pick a model; an empty pick means "official default",
      // which is why create still succeeds without binding anything.
      if (providerId !== '' && modelId !== '') {
        const bind = bridge()?.bindSession
        if (bind !== undefined) {
          const bound = await bind({
            sessionId: result.sessionId,
            providerId,
            model: modelId,
            ...(effortId === '' ? {} : { reasoningEffort: effortId }),
          }).catch((reason: unknown) => ({ ok: false, code: 'BIND_FAILED', message: errorMessage(reason) }))
          if (bound?.ok === false) {
            // The Session and roster row exist; report the model step honestly
            // instead of claiming a complete create.
            const roleLabel = kind === 'supervisor' ? t('role.supervisor') : t('role.worker')
            warning = t('create.boundFailed', { role: roleLabel, code: bound.code ?? 'ERROR', message: bound.message ?? t('error.unknown') })
          }
        }
      }
      if (kind === 'worker' && saveAsCustom) {
        setCustomRoles(saveCustomRole({ id: `role-${String(Date.now())}`, name: displayName, description: duty.trim() }))
      }
      // First-turn report-in: an empty Session is hidden by the official shell,
      // and both roles must state what they understood before taking work.
      const projectId = request.workspaceId
      const report = bridge()?.reportIn
      if (projectId !== undefined) {
        const welcomed = report === undefined
          ? { ok: false, code: 'CHANNEL_MISSING', message: t('create.reportInMissing') }
          : await report({
            sessionId: result.sessionId,
            projectId,
            role: kind,
            displayName,
            ...(kind === 'worker' ? { duty: duty.trim() } : {}),
          }).catch((reason: unknown) => ({ ok: false, code: 'REPORT_FAILED', message: errorMessage(reason) }))
        if (welcomed?.ok === false) {
          const detail = t('create.reportFailed', { code: welcomed.code ?? 'ERROR', message: welcomed.message ?? t('error.unknown') })
          warning = warning === undefined
            ? t('create.createdBut', { role: kind === 'supervisor' ? t('role.supervisor') : t('role.worker'), detail })
            : t('create.warningJoin', { warning, detail })
        }
      }
      refreshSupervisor()
      if (warning !== undefined) {
        setError(warning)
        return
      }
      closeCreate()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  const projectName = request.projectLabel ?? request.workspaceId ?? t('create.noProject')
  return (
    <Modal
      open
      onClose={() => { if (!creating) closeCreate() }}
      title={kind === 'supervisor' ? t('create.title.supervisor') : t('create.title.worker')}
      description={kind === 'supervisor'
        ? t('create.description.supervisor', { project: projectName })
        : t('create.description.worker', { project: projectName })}
      closeLabel={t('dialog.close')}
      className={css.wideDialog ?? ''}
      contentClassName={css.wideContent ?? ''}
      footer={(
        <>
          <Button variant="outline" disabled={creating} onClick={() => { closeCreate() }}>{t('dialog.cancel')}</Button>
          <Button
            variant="primary"
            disabled={creating || request.workspaceId === undefined || name.trim() === ''
              || (kind === 'supervisor' && supervisor !== undefined)}
            onClick={() => { void submit() }}
          >
            {creating ? t('create.creating') : kind === 'supervisor' ? t('create.submit.supervisor') : t('create.submit.worker')}
          </Button>
        </>
      )}
    >
      {request.workspaceId === undefined && (
        <p role="alert" className={css.error}>
          {t('create.noProjectHint')}
        </p>
      )}
      {kind === 'supervisor'
        ? (
          <div className={css.stack}>
            <label className={css.label} htmlFor="cadre-supervisor-name">{t('create.nameLabel')}</label>
            <Input
              id="cadre-supervisor-name"
              value={name}
              placeholder={t('role.supervisor')}
              disabled={creating}
              onChange={(event) => { setName(event.target.value) }}
            />
            <span className={css.hint}>
              {t('create.supervisorHint')}
            </span>
            {supervisor !== undefined && (
              <p role="status" className={css.hint}>
                {t('create.supervisorExistsHint', { name: supervisor.displayName ?? supervisor.sessionId })}
              </p>
            )}
            <div className={css.divider} />
            <ProviderModelPicker
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              effortId={effortId}
              onProvider={(nextProviderId, defaultModel) => {
                setProviderId(nextProviderId)
                setModelId(defaultModel)
                setEffortId('')
              }}
              onModel={(nextModelId) => { setModelId(nextModelId); setEffortId('') }}
              onEffort={setEffortId}
              t={t}
            />
            <span className={css.hint}>
              {t('create.supervisorModelHint')}
            </span>
            {error !== null && <p role="alert" className={css.error}>{error}</p>}
          </div>
        )
        : (
          <div className={css.stackWide}>
            <span className={css.label}>{t('create.templatesLabel')}</span>
            <div className={css.grid} role="radiogroup" aria-label={t('create.groupAria')}>
              {ROLE_GROUPS.map(group => (
                <Button
                  key={group.id}
                  variant={templateGroup === group.id ? 'primary' : 'outline'}
                  onClick={() => { setTemplateGroup(group.id) }}
                >
                  {t(group.labelKey)} {ROLE_TEMPLATES[group.id].length}
                </Button>
              ))}
            </div>
            <div className={`${css.grid} ${css.templateGrid}`} role="radiogroup" aria-label={t('create.templateAria')}>
              {ROLE_TEMPLATES[templateGroup].map(template => (
                <Button
                  key={template.id}
                  variant={templateId === template.id ? 'primary' : 'outline'}
                  onClick={() => { applyTemplate(template) }}
                >
                  {template.name}
                </Button>
              ))}
              {customRoles.map(role => (
                <span key={role.id} className={css.customRole}>
                  <Button
                    variant={templateId === role.id ? 'primary' : 'outline'}
                    onClick={() => {
                      setTemplateId(role.id)
                      setName(role.name)
                      setPosition(role.name)
                      setDuty(role.description)
                    }}
                  >
                    {role.name}{t('create.customSuffix')}
                  </Button>
                  <Button
                    variant="outline"
                    aria-label={t('create.removeCustomAria', { name: role.name })}
                    title={t('create.removeCustomTitle')}
                    onClick={() => { setCustomRoles(removeCustomRole(role.id)) }}
                  >
                    ×
                  </Button>
                </span>
              ))}
            </div>

            <div className={css.field}>
              <label className={css.label} htmlFor="cadre-worker-name">{t('create.workerNameLabel')}</label>
              <Input
                id="cadre-worker-name"
                value={name}
                placeholder={t('create.workerNamePlaceholder')}
                disabled={creating}
                onChange={(event) => { setName(event.target.value) }}
              />
            </div>
            <div className={css.field}>
              <label className={css.label} htmlFor="cadre-worker-duty">{t('create.dutyLabel')}</label>
              <textarea
                id="cadre-worker-duty"
                value={duty}
                placeholder={t('create.dutyPlaceholder')}
                rows={4}
                maxLength={2000}
                disabled={creating}
                onChange={(event) => { setDuty(event.target.value) }}
                style={BODY_TEXTAREA}
              />
              <span className={css.hint}>{t('create.skillsHint')}</span>
            </div>
            <Checkbox
              checked={saveAsCustom}
              label={t('create.saveCustom')}
              disabled={creating}
              onChange={setSaveAsCustom}
            />

            <div className={css.divider} />
            <ProviderModelPicker
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              effortId={effortId}
              onProvider={(nextProviderId, defaultModel) => {
                setProviderId(nextProviderId)
                setModelId(defaultModel)
                setEffortId('')
              }}
              onModel={(nextModelId) => { setModelId(nextModelId); setEffortId('') }}
              onEffort={setEffortId}
              t={t}
            />
            <span className={css.hint}>
              {t('create.workerModelHint')}
            </span>
            {error !== null && <p role="alert" className={css.error}>{error}</p>}
          </div>
        )}
    </Modal>
  )
}
