/**
 * SQLite schema（backend/01 §1；B5 原型已验证 WAL/幂等/乐观锁语义）。
 *
 * 只建表与约束；迁移只向前（schema_meta.schema_version 单调递增）。
 * 触发器是应用层校验之外的数据库层兜底：终态不可迁移、delivered 不得跳过 review。
 */
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 2

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  display_name TEXT,
  description  TEXT,
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_members_project_role ON members (project_id, role);

CREATE TABLE IF NOT EXISTS tasks (
  task_id                TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  seq                    INTEGER NOT NULL,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  body_bytes             INTEGER NOT NULL,
  body_sha256            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  dispatcher_session_id  TEXT NOT NULL,
  assignee_session_id    TEXT NOT NULL,
  attempt                INTEGER NOT NULL DEFAULT 0,
  supersedes_task_id     TEXT,
  superseded_by_task_id  TEXT,
  latest_dispatch_message_id TEXT,
  latest_report_message_id   TEXT,
  created_at             TEXT NOT NULL,
  dispatched_at          TEXT,
  accepted_at            TEXT,
  started_at             TEXT,
  delivered_at           TEXT,
  review_started_at      TEXT,
  closed_at              TEXT,
  updated_at             TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks (project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_assignee ON tasks (project_id, assignee_session_id, status);

CREATE TRIGGER IF NOT EXISTS tasks_terminal_guard
BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('verified', 'failed', 'cancelled') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal transition: terminal state is immutable');
END;

CREATE TRIGGER IF NOT EXISTS tasks_review_guard
BEFORE UPDATE OF status ON tasks
WHEN OLD.status = 'delivered' AND NEW.status IN ('verified', 'rework', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'illegal transition: delivered must pass review');
END;

CREATE TABLE IF NOT EXISTS messages (
  message_id       TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  direction        TEXT NOT NULL,
  channel          TEXT NOT NULL,
  from_session_id  TEXT NOT NULL,
  to_session_id    TEXT,
  body             TEXT NOT NULL,
  body_bytes       INTEGER NOT NULL,
  body_sha256      TEXT NOT NULL,
  preview          TEXT NOT NULL,
  deliverables_json TEXT,
  idempotency_key  TEXT NOT NULL,
  delivery_state   TEXT NOT NULL DEFAULT 'delivered',
  error_code       TEXT,
  received_at      TEXT NOT NULL,
  delivered_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, delivered_at);

CREATE TABLE IF NOT EXISTS task_events (
  event_id         TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor_session_id TEXT NOT NULL,
  reason           TEXT,
  message_id       TEXT,
  idempotency_key  TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, at);

CREATE TABLE IF NOT EXISTS idempotency (
  project_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  operation         TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  ledger_result_json TEXT,
  receipt_json      TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key)
);
`

export function initSchema(db: DatabaseSync): void {
  db.exec(DDL)
  migrate(db)
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION))
}

/** v1 → v2：messages 增加 deliverables_json（既有库原地补列）。 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: unknown }>
  if (!columns.some((column) => String(column.name) === 'deliverables_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN deliverables_json TEXT`)
  }
}
