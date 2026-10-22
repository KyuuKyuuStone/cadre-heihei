/**
 * Cadre employee settings section (ADR-0022 §5).
 *
 * Lists the current project's employee rows from `window.cadre.listEmployees`.
 * Row edits call `cadre:upsertEmployee`; deletion calls `cadre:deleteEmployee`
 * and only removes the employee attributes, never the Session. Every read and
 * write is confirmed by a read-back before success is shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CadreEmployee.module.css'
import {
  failureText,
  type CatalogGroup, type CatalogModel, type EmployeeListState, type EmployeeRecord,
  type EmployeeWrite, type Load, type ModelCatalog, type PresetOption, type StepOutcome,
} from './CadreEmployee.tsx'

const MAX_PERSONA_NOTE = 4000

/** Everything the section reads or writes. */
export interface EmployeeSettingsInjected {
  hooks: { employees: HostObservable<EmployeeListState> }
  listPresets: () => Promise<Load<readonly PresetOption[]>>
  loadModels: () => Promise<Load<ModelCatalog>>
  getEmployee: (sessionId: string) => Promise<{ ok: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  saveEmployee: (input: EmployeeWrite) => Promise<StepOutcome & { employee?: EmployeeRecord }>
  deleteEmployee: (sessionId: string) => Promise<StepOutcome>
  isBlank: (sessionId: string) => boolean | undefined
  refreshEmployees: () => void
}

interface EditError {
  readonly step: string
  readonly code: string
  readonly message: string
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 18 ? sessionId : `${sessionId.slice(0, 10)}…${sessionId.slice(-4)}`
}

function normalizeNote(note: string | undefined): string {
  return note ?? ''
}

/** Settings section listing and editing the project's employees. */
export function EmployeeSection({
  useEmployees, listPresets, loadModels, getEmployee, saveEmployee, deleteEmployee, isBlank, refreshEmployees,
}: PropsRuntime<'settings.section'> & InjectFace<EmployeeSettingsInjected>) {
  const { status, employees, error: rosterError } = useEmployees(state => state)
  const [presets, setPresets] = useState<Load<readonly PresetOption[]> | null>(null)
  const [catalog, setCatalog] = useState<Load<ModelCatalog> | null>(null)
  const [editing, setEditing] = useState<EmployeeRecord | null>(null)
  const [deleting, setDeleting] = useState<EmployeeRecord | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadPresets = useCallback(async () => {
    const loaded = await listPresets()
    setPresets(loaded)
    return loaded
  }, [listPresets])
  const loadCatalog = useCallback(async () => {
    const loaded = await loadModels()
    setCatalog(loaded)
    return loaded
  }, [loadModels])

  useEffect(() => {
    refreshEmployees()
    void loadPresets()
    void loadCatalog()
  }, [refreshEmployees, loadPresets, loadCatalog])

  const presetLabel = (id: string | undefined): string => {
    if (id === undefined) return '未设模板'
    return (presets?.ok === true ? presets.value.find(preset => preset.id === id)?.name : undefined) ?? id
  }

  const remove = async (employee: EmployeeRecord) => {
    setBusy(true)
    setDeleteError(null)
    try {
      const result = await deleteEmployee(employee.sessionId)
      if (!result.ok) {
        setDeleteError(`删除失败：${failureText(result)}`)
        return
      }
      const check = await getEmployee(employee.sessionId)
      if (!check.ok) {
        setDeleteError(`删除后回读失败：${check.code ?? 'UNKNOWN'} · ${check.message ?? '未知错误'}`)
        return
      }
      if (check.employee != null) {
        setDeleteError('删除已返回成功，但回读仍读到员工记录，不能视为完成。')
        return
      }
      refreshEmployees()
      setDeleting(null)
      setNotice(`已删除员工「${employee.displayName ?? employee.sessionId}」；会话与历史记录未受影响。`)
    } catch (cause) {
      setDeleteError(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h2 style={{ margin: 0, flex: 1 }}>员工</h2>
        <Button variant="outline" size="sm" onClick={() => { setNotice(null); refreshEmployees() }}>刷新</Button>
      </div>
      <p style={{ margin: 0 }}>员工是会话的附加属性；删除员工只移除名称、模板、模型与人格补充，不影响会话与历史。</p>

      {notice !== null && <p className={css.success} role="status">{notice}</p>}
      {rosterError !== null && <p className={css.error} role="alert">读取员工失败：{rosterError}</p>}

      {status === 'loading' && (
        <div className={css.loadingRow} role="status" aria-busy="true">
          <StateDot state="ongoing" />
          <span>读取员工…</span>
        </div>
      )}

      {status === 'ready' && employees.length === 0 && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0' }}>
          <span>EMPTY · 还没有员工</span>
          <span className={css.hint}>去左侧会话列表右键点击一个会话，选择「转为员工」；升格后员工会出现在这里。</span>
        </div>
      )}

      {employees.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {employees.map(employee => (
            <li
              key={employee.sessionId}
              style={{
                display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 0',
                borderBottom: '0.5px solid var(--dsw-alias-border-l4)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontWeight: 600 }}>{employee.displayName ?? '未命名员工'}</span>
                <Tag tone="neutral">{presetLabel(employee.templateId)}</Tag>
                <span style={{ flex: 1 }} />
                <Button variant="outline" size="sm" onClick={() => { setNotice(null); setEditing(employee) }}>编辑</Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setNotice(null); setDeleteError(null); setDeleting(employee) }}
                >
                  删除
                </Button>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' }}>
                <span>{employee.preferredProviderId === undefined || employee.preferredModel === undefined
                  ? '未设模型'
                  : `模型 ${employee.preferredProviderId}/${employee.preferredModel}`}</span>
                <span title={employee.sessionId} style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  会话 {shortSessionId(employee.sessionId)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <EmployeeEditForm
          key={editing.sessionId}
          record={editing}
          presets={presets}
          catalog={catalog}
          isBlank={isBlank}
          saveEmployee={saveEmployee}
          getEmployee={getEmployee}
          retryPresets={loadPresets}
          retryModels={loadCatalog}
          onClose={() => { setEditing(null) }}
          onSaved={employee => {
            refreshEmployees()
            setEditing(null)
            setNotice(`已保存员工「${employee.displayName ?? employee.sessionId}」。`)
          }}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => { if (!busy) setDeleting(null) }}
        closeLabel="关闭"
        title="删除员工"
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setDeleting(null) }}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => { if (deleting !== null) void remove(deleting) }}>
              {busy ? '删除中…' : '删除'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p style={{ margin: 0 }}>
            {deleting === null
              ? ''
              : `确定删除员工「${deleting.displayName ?? deleting.sessionId}」？只删除员工属性，不会删除会话，也不影响会话历史。`}
          </p>
          <p className={css.hint}>删除后该会话仍是普通会话，可随时右键再次「转为员工」。</p>
          {deleteError !== null && <p className={css.error} role="alert">{deleteError}</p>}
        </div>
      </Modal>
    </div>
  )
}

/** One employee's edit form; mounted per Session so its state cannot leak. */
function EmployeeEditForm({
  record, presets, catalog, isBlank, saveEmployee, getEmployee, retryPresets, retryModels, onClose, onSaved,
}: {
  readonly record: EmployeeRecord
  readonly presets: Load<readonly PresetOption[]> | null
  readonly catalog: Load<ModelCatalog> | null
  readonly isBlank: (sessionId: string) => boolean | undefined
  readonly saveEmployee: (input: EmployeeWrite) => Promise<StepOutcome & { employee?: EmployeeRecord }>
  readonly getEmployee: (sessionId: string) => Promise<{ ok: boolean; employee?: EmployeeRecord | null; code?: string; message?: string }>
  readonly retryPresets: () => Promise<Load<readonly PresetOption[]>>
  readonly retryModels: () => Promise<Load<ModelCatalog>>
  readonly onClose: () => void
  readonly onSaved: (employee: EmployeeRecord) => void
}) {
  const [displayName, setDisplayName] = useState(record.displayName ?? '')
  const [templateId, setTemplateId] = useState(record.templateId ?? '')
  const [providerId, setProviderId] = useState(record.preferredProviderId ?? '')
  const [modelId, setModelId] = useState(record.preferredModel ?? '')
  const [personaNote, setPersonaNote] = useState(normalizeNote(record.personaNote))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<EditError | null>(null)
  const [localPresets, setLocalPresets] = useState(presets)
  const [localCatalog, setLocalCatalog] = useState(catalog)
  const errorRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => { setLocalPresets(presets) }, [presets])
  useEffect(() => { setLocalCatalog(catalog) }, [catalog])
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [error])

  const blank = isBlank(record.sessionId)
  const templateEditable = blank === true
  const templateHint = blank === true
    ? '模板改动只写入员工记录，不会切换当前会话；下个新建会话生效。'
    : blank === false
      ? '该会话已开始，模板只读；员工记录的模板将在下个新建会话生效。'
      : '无法确认会话是否已开始，模板只读；员工记录的模板将在下个新建会话生效。'

  const chooseModel = (group: CatalogGroup, model: CatalogModel) => {
    setProviderId(group.id)
    setModelId(model.id)
    setError(null)
  }

  const submit = async () => {
    if (busy) return
    const name = displayName.trim()
    if (name === '') {
      setError({ step: '校验', code: 'INVALID_ARGUMENT', message: '显示名不能为空' })
      return
    }
    if (personaNote.length > MAX_PERSONA_NOTE) {
      setError({ step: '校验', code: 'INVALID_ARGUMENT', message: `人格补充不能超过 ${MAX_PERSONA_NOTE} 字` })
      return
    }
    if ((providerId === '') !== (modelId === '')) {
      setError({ step: '校验', code: 'INVALID_ARGUMENT', message: 'provider 与 model 必须同时设置或同时留空' })
      return
    }
    setBusy(true)
    setError(null)
    const note = personaNote.trim() === '' ? null : personaNote
    const sentTemplate = templateEditable && templateId !== '' ? templateId : undefined
    const sentProvider = providerId === '' ? undefined : providerId
    const sentModel = modelId === '' ? undefined : modelId
    try {
      const written = await saveEmployee({
        sessionId: record.sessionId,
        displayName: name,
        personaNote: note,
        ...(sentTemplate === undefined ? {} : { templateId: sentTemplate }),
        ...(sentProvider === undefined ? {} : { preferredProviderId: sentProvider }),
        ...(sentModel === undefined ? {} : { preferredModel: sentModel }),
      })
      if (!written.ok) {
        setError({ step: '员工记录保存', code: written.code ?? 'UNKNOWN', message: written.message ?? '未知错误' })
        return
      }
      const back = await getEmployee(record.sessionId)
      if (!back.ok || back.employee == null) {
        setError({
          step: '保存后回读校验',
          code: back.ok ? 'NOT_FOUND' : (back.code ?? 'UNKNOWN'),
          message: back.ok ? '回读未找到员工记录' : (back.message ?? '未知错误'),
        })
        return
      }
      const stored = back.employee
      const mismatches: string[] = []
      if (stored.displayName !== name) mismatches.push('显示名')
      if (normalizeNote(stored.personaNote) !== personaNote) mismatches.push('人格补充')
      if (sentTemplate !== undefined && stored.templateId !== sentTemplate) mismatches.push('模板')
      if (sentProvider !== undefined && stored.preferredProviderId !== sentProvider) mismatches.push('provider')
      if (sentModel !== undefined && stored.preferredModel !== sentModel) mismatches.push('model')
      if (mismatches.length > 0) {
        setError({
          step: '保存后回读校验',
          code: 'READBACK_MISMATCH',
          message: `写入已返回成功，但回读字段不一致：${mismatches.join('、')}`,
        })
        return
      }
      onSaved(stored)
    } catch (cause) {
      setError({ step: '员工记录保存', code: 'IPC_ERROR', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const presetRows = localPresets?.ok === true ? localPresets.value.filter(preset => preset.broken === undefined) : []
  const groups = localCatalog?.ok === true ? localCatalog.value.groups : []

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      closeLabel="关闭"
      title="编辑员工"
      description={`会话 ${record.sessionId}`}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{busy ? '保存中…' : '保存'}</Button>
        </>
      )}
    >
      <div className={css.body}>
        <div className={css.field}>
          <label className={css.label} htmlFor="cadre-employee-settings-name">显示名</label>
          <Input
            id="cadre-employee-settings-name"
            value={displayName}
            disabled={busy}
            placeholder="员工显示名"
            onChange={event => { setDisplayName(event.target.value); setError(null) }}
          />
        </div>

        <div className={css.field}>
          <span className={css.label}>模板</span>
          <p className={css.hint}>{templateHint}</p>
          {localPresets === null && <p className={css.hint}>读取模板…</p>}
          {localPresets?.ok === false && (
            <p className={css.error} role="alert">
              <span>模板列表读取失败：{failureText(localPresets)}</span>
              <span className={css.hint}>本次保存不会修改模板。</span>
            </p>
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
                  disabled={!templateEditable || busy}
                  onClick={() => { setTemplateId(preset.id); setError(null) }}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          )}
          {localPresets?.ok === false && (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { void retryPresets().then(setLocalPresets) }}
              >
                重试模板列表
              </Button>
            </div>
          )}
        </div>

        <div className={css.field}>
          <span className={css.label}>模型</span>
          {localCatalog === null && <p className={css.hint}>读取模型目录…</p>}
          {localCatalog?.ok === false && (
            <p className={css.error} role="alert">
              <span>模型目录读取失败：{failureText(localCatalog)}</span>
              <span className={css.hint}>本次保存不会修改模型偏好。</span>
            </p>
          )}
          {localCatalog?.ok === true && groups.length === 0 && (
            <p className={css.notice}>模型目录为空：请先在设置 → 模型 Providers 添加厂商。本次保存不会修改模型偏好。</p>
          )}
          {groups.length > 0 && (
            <div className={css.groups} role="radiogroup" aria-label="员工模型">
              {groups.map(group => (
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
                          disabled={busy}
                          onClick={() => { chooseModel(group, model) }}
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
          {localCatalog !== null && !(localCatalog.ok && groups.some(group => group.id === providerId
            && group.models.some(model => model.id === modelId))) && providerId !== '' && (
            <p className={css.notice}>当前模型 {providerId}/{modelId} 不在目录中；不重新选择则保留原值。</p>
          )}
          {localCatalog?.ok === false && (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { void retryModels().then(setLocalCatalog) }}
              >
                重试模型目录
              </Button>
            </div>
          )}
        </div>

        <div className={css.field}>
          <label className={css.label} htmlFor="cadre-employee-persona">人格补充</label>
          <p className={css.hint}>补充这个员工的表达风格与工作偏好；不要写协作规则/谁能验收，这些规则以项目规范为准。</p>
          <textarea
            id="cadre-employee-persona"
            className={css.textarea}
            value={personaNote}
            disabled={busy}
            maxLength={MAX_PERSONA_NOTE}
            rows={5}
            placeholder="例如：解释先给结论；代码示例尽量短。"
            onChange={event => { setPersonaNote(event.target.value); setError(null) }}
          />
          <p className={css.hint}>{personaNote.length} / {MAX_PERSONA_NOTE}</p>
        </div>

        {error !== null && (
          <p ref={errorRef} className={css.error} role="alert">
            <span>{error.step}失败：{error.code} · {error.message}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
