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
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  loadCustomRoles, removeCustomRole, saveCustomRole,
  type CustomRole,
} from './cadre-roster-source.ts'
import css from './CadreCreateDialog.module.css'

const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const BODY_TEXTAREA: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  resize: 'vertical',
  font: 'inherit',
  padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: TEXT_PRIMARY,
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

const ROLE_GROUPS: readonly { readonly id: RoleGroup; readonly label: string }[] = [
  { id: 'dev', label: '软件开发' },
  { id: 'novel', label: '小说' },
  { id: 'general', label: '通用' },
]

/** Role templates (product-model §4); picking one fills name and duty. */
const ROLE_TEMPLATES: Readonly<Record<RoleGroup, readonly RoleTemplate[]>> = {
  dev: [
    { id: 'dev-backend', name: '后端', duty: '负责服务端接口、数据模型与业务逻辑。先读现有约定再改，保持兼容并可测试；交付时说明接口变更与验证方式。' },
    { id: 'dev-frontend', name: '前端', duty: '负责界面与交互实现。复用既有组件与设计令牌，覆盖加载、空与错误状态；交付时附关键截图与自测结论。' },
    { id: 'dev-test', name: '测试', duty: '负责用例设计、执行与回归。覆盖正常与边界路径，定位失败根因并给出可复现步骤，不为通过而修改产品代码。' },
    { id: 'dev-review', name: '代码审查', duty: '负责审查改动的正确性、安全性与可维护性。指出具体文件与行号，区分必须修改与建议，不替作者直接重写。' },
    { id: 'dev-design', name: '设计师', duty: '负责交互与视觉方案。基于现有设计体系给出可落地的布局、状态与文案，交付可实现规格而不是概念图。' },
    { id: 'dev-docs', name: '技术文档', duty: '负责设计说明、使用指南与交付记录。以代码与实测为依据，写清结论、证据与未验证项，保持术语一致。' },
    { id: 'dev-ops', name: '运维脚本', duty: '负责构建、部署与排障脚本。优先幂等与可回滚，危险操作必须显式确认并保留日志，不擅自修改共享配置。' },
    { id: 'dev-ue', name: '虚幻引擎开发', duty: '负责 UE 蓝图、C++ 与资源集成。遵循项目现有模块划分与性能预算，交付可复现的构建与运行步骤。' },
    { id: 'dev-architect', name: '架构师', duty: '负责边界划分、接口契约与技术取舍。先给约束、备选与代价，再落最小改动，避免为假设中的未来过度设计。' },
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
    { id: 'general-quality', name: '质量检查', duty: '负责按清单核验交付物。逐项给出通过或不通过及证据，发现缺口直接指出，不用口头保证代替检查。' },
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
  listRoster?(query: { projectId: string }): Promise<{ members?: readonly RosterRow[]; rows?: readonly RosterRow[] } | undefined>
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
  useCreateRequest, closeCreate, createRosterEntry, refreshSupervisor,
}: PropsRuntime<'shell.overlay'> & InjectFace<CadreCreateInjected>) {
  const request = useCreateRequest(value => value)
  if (request === null) return null
  return (
    <CadreCreateForm
      key={request.token}
      request={request}
      closeCreate={closeCreate}
      createRosterEntry={createRosterEntry}
      refreshSupervisor={refreshSupervisor}
    />
  )
}

function CadreCreateForm({
  request, closeCreate, createRosterEntry, refreshSupervisor,
}: {
  readonly request: CadreCreateRequest
} & Omit<CadreCreateInjected, 'hooks' | 'useCreateRequest'>) {
  const bridge = (): CadreCreateBridge | undefined => (window as unknown as { cadre?: CadreCreateBridge }).cadre
  const kind = request.kind
  const [supervisor, setSupervisor] = useState<RosterRow | undefined>(undefined)
  const [name, setName] = useState('')
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
    if (kind === 'supervisor') {
      const projectId = request.workspaceId
      const roster = list?.listRoster
      if (projectId === undefined || roster === undefined) return () => { cancelled = true }
      void roster({ projectId }).then((result) => {
        if (cancelled) return
        const members = result?.members ?? result?.rows ?? []
        setSupervisor(members.find(member => member.role === 'supervisor' && member.state !== 'departed'))
      }).catch(() => { /* the create call remains the authority */ })
      return () => { cancelled = true }
    }
    const read = list?.listProviders
    if (read === undefined) {
      setError('服务商通道未接入：window.cadre.listProviders 未注册')
      return () => { cancelled = true }
    }
    void read().then((result) => {
      if (cancelled) return
      if (result?.ok === false) {
        setProviders([])
        setError(`读取官方模型目录失败：${result.message ?? result.code ?? '未知错误'}`)
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
      if (!cancelled) setError(`读取服务商失败：${errorMessage(reason)}`)
    })
    return () => { cancelled = true }
  }, [kind])

  const applyTemplate = (template: RoleTemplate): void => {
    setTemplateId(template.id)
    setName(template.name)
    setPosition(template.name)
    setDuty(template.duty)
  }

  const submit = async (): Promise<void> => {
    const displayName = name.trim()
    if (displayName === '') {
      setError(kind === 'supervisor' ? '请填写主管名字' : '请填写员工名称')
      return
    }
    if (kind === 'worker' && duty.trim() === '') {
      setError('请填写岗位职责')
      return
    }
    if (kind === 'supervisor' && supervisor !== undefined) {
      setError(`本项目部已有主管（${supervisor.displayName ?? supervisor.sessionId}），请先让其离职`)
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
      if (kind === 'worker' && providerId !== '' && modelId !== '') {
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
            warning = `员工已创建，但模型未绑定（${bound.code ?? 'ERROR'} · ${bound.message ?? '未知错误'}）`
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
          ? { ok: false, code: 'CHANNEL_MISSING', message: 'window.cadre.reportIn 未注册' }
          : await report({
            sessionId: result.sessionId,
            projectId,
            role: kind,
            displayName,
            ...(kind === 'worker' ? { duty: duty.trim() } : {}),
          }).catch((reason: unknown) => ({ ok: false, code: 'REPORT_FAILED', message: errorMessage(reason) }))
        if (welcomed?.ok === false) {
          const detail = `报到消息发送失败（${welcomed.code ?? 'ERROR'} · ${welcomed.message ?? '未知错误'}）`
          warning = warning === undefined ? `${kind === 'supervisor' ? '主管' : '员工'}已创建，但${detail}` : `${warning}；${detail}`
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

  const selectedProvider = providers.find(provider => provider.providerId === providerId)
  const models = selectedProvider?.models ?? []
  const efforts = selectedProvider?.models?.find(model => model.id === modelId)?.reasoning?.efforts ?? []

  const projectName = request.projectLabel ?? request.workspaceId ?? '未选择项目部'
  return (
    <Modal
      open
      onClose={() => { if (!creating) closeCreate() }}
      title={kind === 'supervisor' ? '新建主管' : '新建员工'}
      description={kind === 'supervisor'
        ? `项目部 ${projectName} · 主管只做调度与验收，每项目部限一名`
        : `项目部 ${projectName} · 选模板自动填名称与职责，均可修改`}
      closeLabel="关闭"
      className={css.wideDialog ?? ''}
      contentClassName={css.wideContent ?? ''}
      footer={(
        <>
          <Button variant="outline" disabled={creating} onClick={() => { closeCreate() }}>取消</Button>
          <Button
            variant="primary"
            disabled={creating || request.workspaceId === undefined || name.trim() === ''
              || (kind === 'supervisor' && supervisor !== undefined)}
            onClick={() => { void submit() }}
          >
            {creating ? '创建中…' : kind === 'supervisor' ? '创建主管' : '创建员工'}
          </Button>
        </>
      )}
    >
      {request.workspaceId === undefined && (
        <p role="alert" className={css.error}>
          还没有可用的项目部：请先在侧栏新建或添加一个工作区，再从该行「＋」建人。
        </p>
      )}
      {kind === 'supervisor'
        ? (
          <div className={css.stack}>
            <label className={css.label} htmlFor="cadre-supervisor-name">名字</label>
            <Input
              id="cadre-supervisor-name"
              value={name}
              placeholder="例如：调度员"
              disabled={creating}
              onChange={event => { setName(event.target.value) }}
            />
            <span className={css.hint}>
              主管不选职能、不建模板；每个项目部最多一名。已有主管时需先让其离职。
            </span>
            {supervisor !== undefined && (
              <p role="status" className={css.hint}>
                本项目部已有主管（{supervisor.displayName ?? supervisor.sessionId}），请先让其离职。
              </p>
            )}
            {error !== null && <p role="alert" className={css.error}>{error}</p>}
          </div>
        )
        : (
          <div className={css.stackWide}>
            <div className={css.grid} role="radiogroup" aria-label="角色类别">
              {ROLE_GROUPS.map(group => (
                <Button
                  key={group.id}
                  variant={templateGroup === group.id ? 'primary' : 'outline'}
                  onClick={() => { setTemplateGroup(group.id) }}
                >
                  {group.label} {ROLE_TEMPLATES[group.id].length}
                </Button>
              ))}
            </div>
            <div className={css.grid} role="radiogroup" aria-label="角色模板">
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
                    {role.name}（自定义）
                  </Button>
                  <Button
                    variant="outline"
                    aria-label={`删除自定义角色 ${role.name}`}
                    title="删除这个自定义角色（不影响已创建的员工）"
                    onClick={() => { setCustomRoles(removeCustomRole(role.id)) }}
                  >
                    ×
                  </Button>
                </span>
              ))}
            </div>

            <label className={css.label} htmlFor="cadre-worker-name">名称</label>
            <Input
              id="cadre-worker-name"
              value={name}
              placeholder="选模板后自动填入，可改"
              disabled={creating}
              onChange={event => { setName(event.target.value) }}
            />
            <label className={css.label} htmlFor="cadre-worker-duty">岗位职责（最多 2000 字）</label>
            <textarea
              id="cadre-worker-duty"
              value={duty}
              placeholder="选模板后自动填入；这是运行时注入的员工提示词，可改。"
              rows={5}
              maxLength={2000}
              disabled={creating}
              onChange={event => { setDuty(event.target.value) }}
              style={BODY_TEXTAREA}
            />
            <Checkbox
              checked={saveAsCustom}
              label="保存为自定义角色，供下次复用"
              disabled={creating}
              onChange={setSaveAsCustom}
            />

            <div className={css.divider} />
            <span className={css.sectionTitle}>服务商与模型（可选）</span>
            {providers.length === 0
              ? <span className={css.hint}>未配置服务商，将使用官方默认模型。</span>
              : (
                <div className={css.grid} role="radiogroup" aria-label="服务商">
                  {providers.map(provider => (
                    <Button
                      key={provider.providerId}
                      variant={providerId === provider.providerId ? 'primary' : 'outline'}
                      onClick={() => {
                        setProviderId(provider.providerId)
                        setModelId(provider.defaultModel)
                        setEffortId('')
                      }}
                    >
                      {provider.name}
                    </Button>
                  ))}
                </div>
              )}
            {models.length > 0 && (
              <div className={css.grid} role="radiogroup" aria-label="模型">
                {models.map(model => (
                  <Button
                    key={model.id}
                    variant={modelId === model.id ? 'primary' : 'outline'}
                    onClick={() => { setModelId(model.id); setEffortId('') }}
                  >
                    {model.id}
                  </Button>
                ))}
              </div>
            )}
            {efforts.length > 0 && (
              <div className={css.grid} role="radiogroup" aria-label="思考强度">
                {efforts.map(effort => (
                  <Button
                    key={effort.id}
                    variant={effortId === effort.id ? 'primary' : 'outline'}
                    onClick={() => { setEffortId(effort.id) }}
                  >
                    {effort.name ?? effort.id}
                  </Button>
                ))}
              </div>
            )}
            <span className={css.hint}>
              权限默认完全权限。思考强度按官方模型目录选择，未选则用模型默认；写入官方会话模型选择。
            </span>
            {error !== null && <p role="alert" className={css.error}>{error}</p>}
          </div>
        )}
    </Modal>
  )
}
