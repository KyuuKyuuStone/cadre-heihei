# Cadre Workflow

Use this built-in reference when a task's state is unclear.

- A task starts `open`, then moves through dispatch and execution.
- The assignee reports with `report_task`; the task becomes `delivered`.
- The team lead spot-checks the delivery and either sends it back to `rework` or verifies it.
- Only the roster's team lead may accept or reject a delivery.
- Overdue flags apply to open tasks only; terminal rows keep their due date as history.

Do not infer state from chat: read the ledger or the task view.