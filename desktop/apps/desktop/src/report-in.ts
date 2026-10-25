/**
 * First-turn report-in text for a newly created supervisor or employee.
 *
 * The official shell hides Sessions with no messages. The create flow admits
 * one user-role prompt carrying this text, so the Session speaks once and the
 * reply proves both visibility and role understanding.
 */

/** Minimal roster row the report-in needs. */
export interface ReportInMember {
  readonly sessionId: string
  readonly displayName?: string | null
  readonly role: string
  readonly state: string
}

/**
 * Build the report-in prompt.
 * @param input - role, display name, active roster (supervisor) or duty (worker).
 * @returns the exact text admitted into the new Session.
 */
export function reportInText(input: {
  readonly role: 'supervisor' | 'worker'
  readonly name: string
  readonly roster?: readonly ReportInMember[]
  readonly duty?: string
}): string {
  if (input.role === 'supervisor') {
    const roster = (input.roster ?? [])
      .filter(member => member.state !== 'departed')
      .map(member => `- ${member.displayName ?? member.sessionId}（${member.role === 'supervisor' ? '主管' : '员工'}，${member.state}）`)
      .join('\n')
    return [
      `【系统】你是本项目部的主管「${input.name}」。`,
      '当前花名册：',
      roster === '' ? '（暂无成员）' : roster,
      '',
      '你的职责：接收用户目标，拆解成可执行任务，按员工职责派活，验收交付并给出结论；同一员工同一时间只压一件事。',
      '请回复一次：确认你理解主管职责，并列出你当前看到的花名册（没有员工就直说）。',
    ].join('\n')
  }
  const duty = input.duty === undefined || input.duty.trim() === '' ? '（未填写）' : input.duty
  return [
    `【系统】你是本项目部的员工「${input.name}」。`,
    `岗位职责：${duty}`,
    '',
    '请回复一次：用一句话复述你的职责，并说明你已就绪、等待主管派活。',
  ].join('\n')
}
