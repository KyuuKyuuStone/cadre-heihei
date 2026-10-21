/** 临时 SQLite 目录：测试结束关闭连接后整体删除，不污染仓库。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempDb {
  readonly dir: string
  readonly path: string
  cleanup(): void
}

export function makeTempDb(prefix = 'cadre-sqlite-'): TempDb {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    path: join(dir, 'collab.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
