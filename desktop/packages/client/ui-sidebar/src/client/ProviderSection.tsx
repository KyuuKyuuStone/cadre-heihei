/**
 * Cadre provider settings section.
 *
 * Lists model providers from `window.cadre.listProviders`, edits them through
 * `saveProvider`, deletes through `deleteProvider`, and checks format only via
 * `testProvider`. API keys are write-only: the list shows the backend's masked
 * form and the editor never echoes a stored key. Official primitives only.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal, Pill, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/* Bare headings/paras read the semantic tokens explicitly so the warm skin and
   every other theme override reach them. */
const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
const TEXT_ERROR = 'var(--dsw-alias-state-error-primary)'
const TEXT_SUCCESS = 'var(--dsw-alias-state-success-primary)'

interface ProviderModel {
  readonly id: string
}

interface CadreProvider {
  readonly providerId: string
  readonly name: string
  readonly kind: string
  readonly baseUrl?: string
  readonly defaultModel: string
  readonly models?: readonly ProviderModel[]
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly hasKey: boolean
  readonly maskedKey?: string
}

interface ProviderResult {
  readonly ok?: boolean
  readonly code?: string
  readonly message?: string
}

interface ProviderBridge {
  listProviders?: () => Promise<{ ok?: boolean; providers?: CadreProvider[]; code?: string; message?: string }>
  saveProvider?: (input: {
    providerId: string
    name: string
    kind: string
    baseUrl?: string
    apiKey?: string
    defaultModel: string
    models: readonly ProviderModel[]
    enabled?: boolean
    isDefault?: boolean
  }) => Promise<ProviderResult>
  deleteProvider?: (input: { providerId: string }) => Promise<ProviderResult>
  testProvider?: (input: { providerId: string }) => Promise<ProviderResult>
}

const bridge = (): ProviderBridge | undefined => (window as unknown as { cadre?: ProviderBridge }).cadre

interface FormState {
  name: string
  kind: string
  baseUrl: string
  defaultModel: string
  modelsText: string
  apiKey: string
  enabled: boolean
  isDefault: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'deepseek',
  baseUrl: '',
  defaultModel: '',
  modelsText: '',
  apiKey: '',
  enabled: true,
  isDefault: false,
}

function failureText(result: ProviderResult | undefined): string {
  return `${result?.code ?? 'ERROR'} · ${result?.message ?? '操作失败'}`
}

function toForm(provider: CadreProvider): FormState {
  return {
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? '',
    defaultModel: provider.defaultModel,
    modelsText: (provider.models ?? []).map(model => model.id).join(', '),
    apiKey: '',
    enabled: provider.enabled,
    isDefault: provider.isDefault,
  }
}

/** Settings section listing and editing model providers. */
export function ProviderSection(_props: PropsRuntime<'settings.section'>) {
  const [providers, setProviders] = useState<readonly CadreProvider[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<CadreProvider | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CadreProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)

  const load = useCallback(async () => {
    const api = bridge()
    if (api?.listProviders === undefined) {
      setProviders([])
      setError('provider 通道未就绪')
      return
    }
    try {
      const result = await api.listProviders()
      if (result?.ok === false) {
        setError(failureText(result))
        setProviders([])
        return
      }
      setError(null)
      setProviders(result?.providers ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setProviders([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openNew = () => {
    setForm(EMPTY_FORM)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (provider: CadreProvider) => {
    setForm(toForm(provider))
    setFormError(null)
    setEditing(provider)
  }

  const save = async () => {
    const api = bridge()
    if (api?.saveProvider === undefined) {
      setFormError('provider 通道未就绪')
      return
    }
    if (form.name.trim() === '' || form.defaultModel.trim() === '') {
      setFormError('名称与默认模型不能为空')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const providerId = editing === 'new' || editing === null
        ? `prov-${crypto.randomUUID()}`
        : editing.providerId
      const result = await api.saveProvider({
        providerId,
        name: form.name.trim(),
        kind: form.kind,
        ...(form.baseUrl.trim() === '' ? {} : { baseUrl: form.baseUrl.trim() }),
        ...(form.apiKey.trim() === '' ? {} : { apiKey: form.apiKey.trim() }),
        defaultModel: form.defaultModel.trim(),
        models: form.modelsText.split(',').map(part => part.trim()).filter(part => part !== '').map(id => ({ id })),
        enabled: form.enabled,
        isDefault: form.isDefault,
      })
      if (result?.ok === false) {
        setFormError(failureText(result))
        return
      }
      setEditing(null)
      await load()
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (provider: CadreProvider) => {
    const api = bridge()
    if (api?.deleteProvider === undefined) {
      setError('provider 通道未就绪')
      return
    }
    setBusy(true)
    try {
      const result = await api.deleteProvider({ providerId: provider.providerId })
      if (result?.ok === false) {
        setError(failureText(result))
      } else {
        setError(null)
        await load()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setDeleting(null)
    }
  }

  const test = async (provider: CadreProvider) => {
    const api = bridge()
    if (api?.testProvider === undefined) {
      setTestResult({ ok: false, text: 'provider 通道未就绪' })
      return
    }
    setTestResult(null)
    try {
      const result = await api.testProvider({ providerId: provider.providerId })
      setTestResult(result?.ok === false
        ? { ok: false, text: failureText(result) }
        : { ok: true, text: `${result?.message ?? '格式与凭据校验通过'}（仅校验格式/凭据，不发起网络请求）` })
    } catch (cause) {
      setTestResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h2 style={{ margin: 0, flex: 1, color: TEXT_PRIMARY }}>模型 / Providers</h2>
        <Button variant="primary" size="sm" onClick={openNew}>新增 Provider</Button>
      </div>
      <p style={{ margin: 0, color: TEXT_SECONDARY }}>API Key 仅写入本机安全存储；列表只显示脱敏值，不回显明文。</p>

      {error !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{error}</p>}
      {testResult !== null && (
        <p role="status" style={{ margin: 0, color: testResult.ok ? TEXT_SUCCESS : TEXT_ERROR }}>
          {testResult.text}
        </p>
      )}

      {providers === null && (
        <div role="status" aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <StateDot state="ongoing" />
          <span>读取 Providers…</span>
        </div>
      )}

      {providers !== null && providers.length === 0 && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 0' }}>
          <span>还没有配置 Provider</span>
          <span>新增一个模型厂商后即可在会话中选择模型。</span>
        </div>
      )}

      {providers !== null && providers.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {providers.map(provider => (
            <li
              key={provider.providerId}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', flexWrap: 'wrap' }}
            >
              <span style={{ fontWeight: 600 }}>{provider.name}</span>
              <Tag tone="neutral">{provider.kind}</Tag>
              {provider.isDefault && <Tag tone="neutral">默认</Tag>}
              {!provider.enabled && <Tag tone="neutral">已停用</Tag>}
              <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{provider.baseUrl ?? '使用官方端点'}</span>
              <span>默认模型 {provider.defaultModel}</span>
              <Pill>{provider.hasKey ? provider.maskedKey ?? '已配置' : '未配置 Key'}</Pill>
              <Button variant="outline" size="sm" onClick={() => { setTestResult(null); void test(provider) }}>测试</Button>
              <Button variant="outline" size="sm" onClick={() => { openEdit(provider) }}>编辑</Button>
              <Button variant="outline" size="sm" onClick={() => { setError(null); setDeleting(provider) }}>删除</Button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={editing !== null}
        onClose={() => { setEditing(null) }}
        title={editing === 'new' || editing === null ? '新增 Provider' : '编辑 Provider'}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setEditing(null) }}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void save() }}>保存</Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label htmlFor="provider-name">名称</label>
          <Input id="provider-name" value={form.name} disabled={busy} placeholder="例如 DeepSeek 官方"
            onChange={event => { setForm({ ...form, name: event.target.value }) }} />

          <span id="provider-kind-label">类型</span>
          <SegmentedControl
            id="provider-kind"
            label="类型"
            value={form.kind}
            disabled={busy}
            options={[
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'openai', label: 'OpenAI 兼容' },
              { value: 'anthropic', label: 'Anthropic' },
            ]}
            onChange={kind => { setForm({ ...form, kind }) }}
          />

          <label htmlFor="provider-base-url">Base URL</label>
          <Input id="provider-base-url" value={form.baseUrl} disabled={busy} placeholder="留空使用官方端点"
            onChange={event => { setForm({ ...form, baseUrl: event.target.value }) }} />

          <label htmlFor="provider-default-model">默认模型</label>
          <Input id="provider-default-model" value={form.defaultModel} disabled={busy} placeholder="例如 deepseek-chat"
            onChange={event => { setForm({ ...form, defaultModel: event.target.value }) }} />

          <label htmlFor="provider-models">模型列表（逗号分隔）</label>
          <Input id="provider-models" value={form.modelsText} disabled={busy} placeholder="deepseek-chat, deepseek-reasoner"
            onChange={event => { setForm({ ...form, modelsText: event.target.value }) }} />

          <label htmlFor="provider-key">API Key</label>
          <Input
            id="provider-key"
            type="password"
            value={form.apiKey}
            disabled={busy}
            placeholder={editing !== 'new' && editing !== null && editing.hasKey
              ? `已配置 ${editing.maskedKey ?? ''}，留空保持不变`
              : '输入 API Key'}
            onChange={event => { setForm({ ...form, apiKey: event.target.value }) }}
          />

          <div style={{ display: 'flex', gap: '16px' }}>
            <Checkbox checked={form.enabled} label="启用" disabled={busy}
              onChange={enabled => { setForm({ ...form, enabled }) }} />
            <Checkbox checked={form.isDefault} label="设为默认" disabled={busy}
              onChange={isDefault => { setForm({ ...form, isDefault }) }} />
          </div>

          {formError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{formError}</p>}
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={() => { setDeleting(null) }}
        title="删除 Provider"
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDeleting(null) }}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => { if (deleting !== null) void remove(deleting) }}>删除</Button>
          </>
        )}
      >
        <p style={{ margin: 0 }}>
          {deleting === null ? '' : `确定删除「${deleting.name}」？被会话引用时后端会拒绝并提示 INVALID_ARGUMENT。`}
        </p>
      </Modal>
    </div>
  )
}
