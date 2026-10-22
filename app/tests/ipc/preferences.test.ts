/** 偏好主存储：内存与文件权威、非法值回落。 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  FilePreferencesStore,
  InMemoryPreferencesStore,
} from '../../src/main/preferences.ts'
import { makeTempDb } from '../support/temp-db.ts'

test('内存偏好：默认值、局部更新与非法初始值回落', () => {
  const store = new InMemoryPreferencesStore()
  assert.deepEqual(store.get(), { locale: 'zh', theme: 'white' })
  store.set({ locale: 'zh' })
  assert.deepEqual(store.get(), { locale: 'zh', theme: 'white' })
  store.set({ theme: 'celadon' })
  assert.deepEqual(store.get(), { locale: 'zh', theme: 'celadon' })

  const sanitized = new InMemoryPreferencesStore({
    locale: 'fr' as never,
    theme: 'neon' as never,
  })
  assert.deepEqual(sanitized.get(), { locale: 'zh', theme: 'white' })
})

test('文件偏好：写入后可被新实例读取；损坏文件回退默认值', () => {
  const temp = makeTempDb('cadre-prefs-')
  const filePath = join(temp.path, 'prefs.json')
  try {
    mkdirSync(temp.path, { recursive: true })
    const first = new FilePreferencesStore(filePath)
    assert.deepEqual(first.get(), { locale: 'zh', theme: 'white' })
    first.set({ locale: 'jp', theme: 'paper' })
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
      locale: 'jp',
      theme: 'paper',
    })

    const second = new FilePreferencesStore(filePath)
    assert.deepEqual(second.get(), { locale: 'jp', theme: 'paper' })

    writeFileSync(filePath, '{broken', 'utf8')
    const third = new FilePreferencesStore(filePath)
    assert.deepEqual(third.get(), { locale: 'zh', theme: 'white' })
  } finally {
    temp.cleanup()
  }
})
