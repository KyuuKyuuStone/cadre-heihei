/**
 * 回执自证口径测试：中文、emoji 代理对、CRLF、BOM。
 * 阳性对照：按 UTF-16 slice 截断的实现必须与正确实现产生不同结果。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildBodyReceipt, previewOf, utf16BrokenPreview } from '../../src/collab/dispatch/index.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

function independentlyExpected(body: string) {
  return {
    bodyBytes: Buffer.from(body, 'utf8').length,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    preview: Array.from(body).slice(0, 50).join(''),
  }
}

it('口径：中文正文按 UTF-8 字节计数、预览取 50 code point', () => {
  const body = '界'.repeat(60)
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)
  assert.equal(receipt.bodyBytes, 180)
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.equal(receipt.preview, expected.preview)
  assert.equal([...receipt.preview].length, 50)
  assert.equal(receipt.preview.length, 50, '中文 BMP 字符 1 code unit = 1 code point')
})

it('口径：emoji 代理对不得被 UTF-16 截断（阳性对照）', () => {
  const body = `${'a'.repeat(49)}😀${'b'.repeat(10)}`
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)

  assert.equal([...receipt.preview].length, 50)
  assert.equal(receipt.preview.endsWith('😀'), true, '第 50 个 code point 应完整保留 emoji')
  assert.equal(receipt.preview, expected.preview)
  assert.equal(receipt.bodySha256, expected.bodySha256)

  const broken = utf16BrokenPreview(body)
  assert.notEqual(receipt.preview, broken, '正确实现必须与 UTF-16 截断结果不同')
  assert.equal(broken.endsWith('😀'), false)
  const lastUnit = broken.charCodeAt(broken.length - 1)
  assert.ok(lastUnit >= 0xd800 && lastUnit <= 0xdbff, 'UTF-16 截断留下孤立高代理')
})

it('口径：CRLF 原样计数（不做换行规范化）', () => {
  const body = '第一行\r\n第二行'
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodyBytes, Buffer.byteLength('第一行\n第二行', 'utf8') + 1)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.equal(receipt.preview, expected.preview)
  assert.equal(receipt.preview.includes('\r\n'), true)
})

it('口径：BOM 原样计数（不去 BOM）', () => {
  const body = '\uFEFF你好'
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodyBytes, 9, 'BOM 3 字节 + 两个汉字 6 字节')
  assert.equal(receipt.preview.codePointAt(0), 0xfeff)
  assert.notEqual(receipt.bodySha256, createHash('sha256').update('你好', 'utf8').digest('hex'))
})

it('口径：恰好 50 与 51 个 code point 的边界', () => {
  const exact = 'x'.repeat(50)
  const over = 'x'.repeat(51)
  assert.equal(previewOf(exact), exact)
  assert.equal(previewOf(over), 'x'.repeat(50))
  assert.equal([...previewOf(over)].length, 50)
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})
