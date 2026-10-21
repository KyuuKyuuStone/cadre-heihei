/** 证据卡测试夹具：临时项目 + 源文件 + 卡片构造。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IsoTimestamp, TaskId } from '../../src/collab/protocol/index.ts'
import {
  EVIDENCE_SCHEMA_VERSION,
  fingerprintFile,
  sealCard,
  type EvidenceCard,
  type EvidenceCardInput,
  type EvidenceSource,
} from '../../src/collab/evidence/index.ts'

export const AT = '2026-10-21T00:00:00.000Z' as IsoTimestamp
export const TASK_ID = 'task-evidence-1' as TaskId

export interface ProjectFixture {
  readonly root: string
  cleanup(): void
  write(relativePath: string, content: string): void
}

export function makeProject(): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), 'cadre-evidence-'))
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
    write(relativePath, content) {
      const absolute = join(root, relativePath)
      mkdirSync(join(absolute, '..'), { recursive: true })
      writeFileSync(absolute, content, 'utf8')
    },
  }
}

export function sourceFor(projectRoot: string, file: string, line: number): EvidenceSource {
  const fingerprint = fingerprintFile(projectRoot, file)
  return {
    file,
    line,
    fileSha256: fingerprint.sha256,
    fileMtimeMs: fingerprint.mtimeMs,
  }
}

export function cardInput(overrides: Partial<EvidenceCardInput> = {}): EvidenceCardInput {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId: TASK_ID,
    revision: 0,
    currentTask: '实现证据卡核心',
    nextStep: '跑通校验器与注入器',
    createdAt: AT,
    updatedAt: AT,
    items: [],
    ...overrides,
  }
}

export function makeCard(overrides: Partial<EvidenceCardInput> = {}): EvidenceCard {
  return sealCard(cardInput(overrides))
}

export function nextRevision(card: EvidenceCard, overrides: Partial<EvidenceCardInput> = {}): EvidenceCard {
  const { integrity, ...payload } = card
  return sealCard({ ...payload, revision: card.revision + 1, updatedAt: AT, ...overrides })
}
