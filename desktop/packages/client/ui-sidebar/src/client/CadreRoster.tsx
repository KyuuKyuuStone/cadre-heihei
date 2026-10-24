/**
 * Roster panel (W1): who is in this project, and which row is the supervisor.
 *
 * The supervisor is marked four ways at once (design c07dd22): a fixed top
 * group, a 3px indigo left bar, a filled square with 600-weight text, and a
 * solid 「主管」 badge. Employees use a hollow circle, 400 weight, no bar and
 * no badge. Status and last activity come from the roster adapter; this file
 * only renders its view model.
 */
import { useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CadreRoster.module.css'
import { activityText, type RosterMember, type RosterStatus } from './cadre-roster-source.ts'

const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
const TEXT_ERROR = 'var(--dsw-alias-state-error-primary)'
const SUPERVISOR_INDIGO = '#2B4C6F'

/** Panel state; the panel owns loading, this component renders it. */
export type RosterState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly members: readonly RosterMember[] }
  | { readonly kind: 'error'; readonly reason: string }

const STATUS_LABELS: Record<RosterStatus, string> = {
  review: '待验收',
  working: '执行中',
  idle: '空闲',
  offline: '离线',
  departed: '已离职',
}

/** @param status - roster status. @returns the icon plus pulse for review. */
function StatusIcon({ status }: { readonly status: RosterStatus }) {
  if (status === 'working') return <StateDot state="ongoing" />
  if (status === 'review') {
    return <span className={css.waiting}><StateDot state="warning" /></span>
  }
  return <span style={{ opacity: status === 'offline' ? 0.45 : 1 }}><StateDot state="idle" /></span>
}

/** Role mark: filled square for the supervisor, hollow circle for employees. */
function RoleMark({ supervisor }: { readonly supervisor: boolean }) {
  return supervisor
    ? <span aria-hidden="true" style={{
        width: 10, height: 10, flex: 'none', background: TEXT_PRIMARY, borderRadius: 1,
      }} />
    : <span aria-hidden="true" style={{
        width: 10, height: 10, flex: 'none', border: `1.5px solid ${TEXT_SECONDARY}`, borderRadius: '50%',
      }} />
}

/** Supervisor badge: ink fill, inverted label — readable in both themes. */
function SupervisorBadge() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 18, padding: '0 7px',
      borderRadius: 9, background: 'var(--dsw-alias-label-primary)',
      color: 'var(--dsw-alias-label-primary-inverted)',
      fontSize: 11, fontWeight: 600, lineHeight: 1,
    }}>
      主管
    </span>
  )
}

function MemberRow({ member, now, onRetire }: {
  readonly member: RosterMember
  readonly now: number
  readonly onRetire: (member: RosterMember) => void
}) {
  const supervisor = member.role === 'supervisor'
  const departed = member.status === 'departed'
  const offline = member.status === 'offline' || departed
  return (
    <li style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      borderLeft: `3px solid ${supervisor ? SUPERVISOR_INDIGO : 'transparent'}`,
      background: supervisor ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
      borderRadius: supervisor ? '0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0' : 0,
      opacity: offline ? 0.6 : 1,
      minWidth: 0,
    }}>
      <RoleMark supervisor={supervisor} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            color: TEXT_PRIMARY, fontWeight: supervisor ? 600 : 400, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {member.name}
          </span>
          {supervisor && <SupervisorBadge />}
        </span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
          {supervisor ? '主管 · 调度（只读，不执行）' : '员工'}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: TEXT_SECONDARY, fontSize: 12 }}>
          <StatusIcon status={member.status} />
          {STATUS_LABELS[member.status]}
        </span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 11 }}>{activityText(member, now)}</span>
      </div>
      {!departed && (
        <Button variant="outline" size="sm" onClick={() => { onRetire(member) }}>离职</Button>
      )}
    </li>
  )
}

/** @param title - group heading. @param count - member count. */
function GroupHeading({ title, count }: { readonly title: string; readonly count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px' }}>
      <span style={{ color: TEXT_SECONDARY, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>{title}</span>
      <span style={{ color: TEXT_SECONDARY, fontSize: 11 }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--dsw-alias-border-l1)' }} />
    </div>
  )
}

/**
 * Render the roster block. Creation lives on the project row's 「＋」 menu
 * (W8), so the roster itself only reads, filters and offers departure.
 * @param props.state - loading / ready / error.
 * @param props.onRetry - retry the roster read.
 * @param props.onRetire - ask for confirmation before marking a member departed.
 * @returns the roster section.
 */
export function CadreRoster({ state, onRetry, onRetire }: {
  readonly state: RosterState
  readonly onRetry: () => void
  readonly onRetire: (member: RosterMember) => void
}) {
  const [view, setView] = useState<'active' | 'departed'>('active')
  const members = state.kind === 'ready' ? state.members : []
  const active = members.filter(member => member.status !== 'departed')
  const departed = members.filter(member => member.status === 'departed')
  const visible = view === 'active' ? active : departed
  const supervisors = visible.filter(member => member.role === 'supervisor')
  const supervisor = supervisors[0]
  const multiple = supervisors.length > 1
  const employees = visible.filter(member => member.role === 'worker')
  const hidden = multiple ? supervisors.length - 1 : 0
  const now = Date.now()

  return (
    <section aria-label="花名册" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: 13, fontWeight: 600, color: TEXT_SECONDARY }}>花名册</h3>
        {state.kind === 'ready' && <Tag tone="neutral">{active.length} 人在职</Tag>}
        <Button variant={view === 'active' ? 'primary' : 'outline'} size="sm" onClick={() => { setView('active') }}>在职</Button>
        <Button variant={view === 'departed' ? 'primary' : 'outline'} size="sm" onClick={() => { setView('departed') }}>
          已离职 {departed.length}
        </Button>
      </div>

      {state.kind === 'loading' && (
        <div role="status" aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0' }}>
          <StateDot state="ongoing" />
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>读取花名册…</span>
        </div>
      )}

      {state.kind === 'error' && (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
          <span style={{ color: TEXT_ERROR }}>花名册读取失败：{state.reason}</span>
          <div><Button variant="outline" size="sm" onClick={onRetry}>重试</Button></div>
        </div>
      )}

      {state.kind === 'ready' && visible.length === 0 && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' }}>
          <span>{view === 'active' ? '本项目还没有在职成员' : '还没有已离职成员'}</span>
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
            {view === 'active'
              ? '用项目行的「＋」新建员工或主管；离职的人会进入「已离职」列表。'
              : '离职记录只读保留，用于查看历史归属。'}
          </span>
        </div>
      )}

      {supervisor !== undefined && (
        <>
          <GroupHeading title="主管" count={1} />
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            <MemberRow member={supervisor} now={now} onRetire={onRetire} />
          </ul>
          {hidden > 0 && (
            <p role="alert" style={{ margin: '4px 0 0', color: TEXT_ERROR, fontSize: 12 }}>
              台账里还有 {hidden} 个主管，违反「每项目最多一个」；已隐藏，请在台账修正。
            </p>
          )}
        </>
      )}

      {employees.length > 0 && (
        <>
          <GroupHeading title="员工" count={employees.length} />
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {employees.map(member => (
              <MemberRow key={member.sessionId} member={member} now={now} onRetire={onRetire} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
