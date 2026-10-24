# 员工思考强度：真值、写入路径、验证（2026-10-24）

## 1. 官方真值

`ModelSelection.reasoningEffort?: string`（`packages/api/session-controller/src/types.ts:101-105`），
与 `provider`、`model` 同属**官方 per-session `modelSelection` 投影**；
`selectModel(request: SessionSelectModelRequest)` 是唯一写入口，Host 会校验
「该模型是否支持该强度」。可选值来自 **官方模型目录**
`ModelReasoning { efforts[], defaultEffort }`（`types.ts:123-135`），没有我们自造的枚举或影子字段。

## 2. 写入路径（bindSession）

`window.cadre.bindSession` → main `cadreBindSession`：

1. 校验参数（新增 `reasoningEffort?: string`，空串视为未选）；
2. **先写官方**：`hostRpc('session','selectModel',{ request: { sessionId, provider, model, reasoningEffort? } })`
   → 成功才继续；失败返回 `HOST_RPC_FAILED` + Host 原始错误码
   （例：`session/model-unavailable: provider "prov-loop" model "deepseek-chat" does not support reasoning effort "high"`）；
3. 再写本地 `session_providers`（仅展示影子，不含强度字段——强度真值只在官方投影）。

关键坑：Host RPC 的 args 必须按描述符包一层 `request`，否则网关返回
`gateway/arguments-invalid: missing "request"`。

## 3. 思考强度 × 模型组合校验

**不在我们这里校验**：前端只渲染官方目录里该模型实际的 `reasoning.efforts`;
`listProviders` 会把 Host `session/modelCatalog` 的 `reasoning` 合并进每个 model；
没有 efforts 的模型（如 deepseek-chat）不显示强度选择。选定后由 Host `selectModel` 校验，
不支持即报错回到对话框——我们不自造规则、不做预判。

## 4. 实测（`D:/xxw_p/cadre-spike-env/s-loop7`）

- 传不支持的强度：`bindSession(..., reasoningEffort:'high')` →
  `{"ok":false,"code":"HOST_RPC_FAILED", ..., "message":"…does not support reasoning effort \"high\""}`
  （证明直通官方校验，没有本地兜底规则）。
- 不传强度：`{"ok":true,...}`，main 日志 `cadre:bindSession … effort=(default) official=true ok=true`
  （官方投影写入成功后才写本地影子）。
- `listProviders` 返回 `models:[{"id":"deepseek-chat"}]`（无 reasoning），前端因此不显示强度按钮。

## 5. 建员工弹窗

`CadrePanel` 新增「思考强度」按钮组（只在官方目录给出 efforts 时出现），
随 `bindSession` 一起提交；界面注明「思考强度按官方模型目录选择，未选则用模型默认；
写入官方会话模型选择」。原先「当前接口只持久化服务商与模型」的标注已删除。
