/**
 * MCP 工具发现（tools/list）定义。身份字段不在 schema 中：
 * sessionId/projectId 只来自 server 启动注入。
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'dispatch_task',
    description: '主管派活：创建 dispatched 任务，可取代旧任务。身份取 server 注入值。',
    inputSchema: {
      type: 'object',
      properties: {
        toSessionId: { type: 'string', description: '目标员工会话（本项目、非 offline）' },
        title: { type: 'string', description: '任务标题' },
        body: { type: 'string', description: '派活原文，不裁剪' },
        idempotencyKey: { type: 'string', description: '调用方生成的幂等键' },
        supersedesTaskId: { type: 'string', description: '可选：被取代的旧 taskId' },
      },
      required: ['toSessionId', 'title', 'body', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_task',
    description: '员工汇报：投递成功时系统以 assignee 名义推进 in_progress → delivered。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '可省略；省略时返回 MISSING_TASK_ID + 候选' },
        body: { type: 'string', description: '汇报正文' },
        deliverables: {
          type: 'array',
          items: { type: 'string' },
          description: '交付物路径清单；可为空数组',
        },
        idempotencyKey: { type: 'string' },
      },
      required: ['body', 'deliverables', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tasks',
    description: '任务摘要列表：主管看本项目全部，worker 仅本人任务。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          description: '单状态或状态数组；缺省为未结',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        assigneeSessionId: { type: 'string', description: '仅 supervisor 可指定他人' },
        since: {
          type: 'object',
          description: '增量游标：updatedAt + seq',
          properties: {
            updatedAt: { type: 'string' },
            seq: { type: 'number' },
          },
          required: ['updatedAt', 'seq'],
        },
        limit: { type: 'number', description: '默认 20，上限 100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: '任务详情：正文、状态、迁移审计、最近一次汇报。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_roster',
    description: '花名册双口径：project 视图可派活；global 仅摘要且不可派活。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'global'] },
        forSession: { type: 'string', description: '可选；不得查询他人花名册' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'review_task',
    description: '主管验收入口：enter_review / verify / rework / fail；review 必经。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        action: { type: 'string', enum: ['enter_review', 'verify', 'rework', 'fail'] },
        reason: { type: 'string', description: 'rework/fail 必填' },
        idempotencyKey: { type: 'string' },
      },
      required: ['taskId', 'action', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
] as const

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name)
export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name']
