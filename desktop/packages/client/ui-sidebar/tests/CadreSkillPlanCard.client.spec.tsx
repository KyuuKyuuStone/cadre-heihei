// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillPlanCard } from '../src/client/CadreSkillPlanCard.tsx'
import { SkillAdminError, skillAdminErrorKey } from '../src/client/CadreSkillAdmin.ts'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never

const PLAN = {
  planId: 'plan-12345678', kind: 'install', packId: 'ai-design',
  sourceUrl: 'https://github.com/elaya/ai-design', author: 'Elaya', license: 'MIT',
  contentHash: 'sha256:abc', targetDir: '~/.dsh/cadre-skills/ai-design',
  actions: ['download', 'verify-hash'], riskFlags: ['untrusted-content'],
  summary: '安装 ai-design', expiresAt: new Date(Date.now() + 600_000).toISOString(), confirmToken: 'token-1',
}
const block = (plan: object): { content: readonly { type: string; text?: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(plan) }],
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Cadre skill plan card', () => {
  it('renders plan metadata and applies with plan id and token', async () => {
    const applyPlan = vi.fn(async () => ({ status: 'applied' as const, packId: 'ai-design' }))
    render(<CadreSkillPlanCard phase="result" block={block(PLAN)} applyPlan={applyPlan} t={t} />)
    expect(screen.getByText('技能变更计划')).toBeTruthy()
    expect(screen.getByText('Elaya')).toBeTruthy()
    expect(screen.getByText('sha256:abc')).toBeTruthy()
    expect(screen.getByText(/download, verify-hash/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
    await waitFor(() => { expect(applyPlan).toHaveBeenCalledWith('plan-12345678', 'token-1', 'apply') })
    expect(await screen.findByText('已执行：ai-design')).toBeTruthy()
  })

  it('disables an expired plan and shows expiry guidance on apply failure', async () => {
    const expired = { ...PLAN, expiresAt: new Date(Date.now() - 1000).toISOString() }
    render(<CadreSkillPlanCard phase="result" block={block(expired)} applyPlan={vi.fn()} t={t} />)
    expect(screen.getByText('已过期')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认执行' }).disabled).toBe(true)
    cleanup()
    const applyPlan = vi.fn(async () => { throw new SkillAdminError('SKILL_ADMIN_PLAN_EXPIRED', 'expired') })
    render(<CadreSkillPlanCard phase="result" block={block(PLAN)} applyPlan={applyPlan} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
    expect(await screen.findByText('计划已过期，请让技能管理员重新生成。')).toBeTruthy()
  })

  it('maps hash, built-in, and permission failures to actionable copy', () => {
    expect(skillAdminErrorKey('SKILL_ADMIN_PLAN_INVALID')).toBe('skills.admin.error.changed')
    expect(skillAdminErrorKey('SKILL_BUILTIN_READONLY')).toBe('skills.admin.error.builtin')
    expect(skillAdminErrorKey('SKILL_ADMIN_FORBIDDEN')).toBe('skills.admin.error.forbidden')
    expect(skillAdminErrorKey('SKILL_ADMIN_PLAN_EXPIRED')).toBe('skills.admin.error.expired')
  })

  it('shows unsupported plans without apply controls', () => {
    render(<CadreSkillPlanCard phase="result" block={block({
      ...PLAN, kind: 'unsupported', reason: '需要登录', confirmToken: undefined,
    })} applyPlan={vi.fn()} t={t} />)
    expect(screen.getByText('不支持')).toBeTruthy()
    expect(screen.getByText('需要登录')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull()
  })
})
