/**
 * 回执自证口径测试：中文、emoji 代理对、CRLF、BOM、首尾空白。
 *
 * preview 口径（backend/01 §2.3）：trim → 前 50 个 code point → 有剩余追加 `…`；
 * bodyBytes / bodySha256 始终按实收原样计算，不受 trim 影响。
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

function expectedPreview(body: string): string {
  const trimmed = body.trim()
  const codePoints = Array.from(trimmed)
  return codePoints.length > 50 ? `${codePoints.slice(0, 50).join('')}…` : trimmed
}

function independentlyExpected(body: string) {
  return {
    bodyBytes: Buffer.from(body, 'utf8').length,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    preview: expectedPreview(body),
  }
}

it('口径：中文 60 字 → trim 后前 50 code point + 省略号', () => {
  const body = '界'.repeat(60)
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)
  assert.equal(receipt.bodyBytes, 180)
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.equal(receipt.preview, expected.preview)
  assert.equal(receipt.preview, `${'界'.repeat(50)}…`)
  assert.equal([...receipt.preview].length, 51, '50 个 code point + 一个省略号')
  assert.equal(receipt.preview.endsWith('…'), true)
})

it('口径：emoji 在截断边界不被劈开（阳性对照）', () => {
  const body = `${'a'.repeat(49)}😀${'b'.repeat(10)}`
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)

  assert.equal(receipt.preview, expected.preview)
  assert.equal(receipt.preview, `${'a'.repeat(49)}😀…`)
  assert.equal([...receipt.preview].length, 51)
  const firstFifty = [...receipt.preview].slice(0, 50).join('')
  assert.equal(firstFifty.endsWith('😀'), true, '第 50 个 code point 应完整保留 emoji')
  assert.equal(receipt.bodySha256, expected.bodySha256)

  const broken = utf16BrokenPreview(body)
  assert.notEqual(receipt.preview, broken, '正确实现必须与 UTF-16 截断结果不同')
  assert.equal(broken.endsWith('😀'), false)
  const lastUnit = broken.charCodeAt(broken.length - 1)
  assert.ok(lastUnit >= 0xd800 && lastUnit <= 0xdbff, 'UTF-16 截断留下孤立高代理')
})

it('口径：恰好 50 个 code point 不加省略号', () => {
  const body = `${'a'.repeat(49)}😀`
  const receipt = buildBodyReceipt(body)
  assert.equal([...receipt.preview].length, 50)
  assert.equal(receipt.preview, body)
  assert.equal(receipt.preview.endsWith('…'), false)
})

it('口径：51 个 code point 截到 50 并追加省略号', () => {
  const body = 'x'.repeat(51)
  const receipt = buildBodyReceipt(body)
  assert.equal(receipt.preview, `${'x'.repeat(50)}…`)
  assert.equal([...receipt.preview].length, 51)
})

it('口径：首尾空白被 trim，内部空白保留', () => {
  const body = '  \r\n 前 中 后 \t '
  const receipt = buildBodyReceipt(body)
  assert.equal(receipt.preview, '前 中 后')
  assert.equal(receipt.preview, expectedPreview(body))
})

it('口径：trim 不影响 bodyBytes 与 bodySha256', () => {
  const padded = '  正文  '
  const trimmed = '正文'
  const receipt = buildBodyReceipt(padded)
  const expected = independentlyExpected(padded)
  assert.equal(receipt.preview, '正文')
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.equal(receipt.bodySha256, createHash('sha256').update(padded, 'utf8').digest('hex'))
  assert.notEqual(receipt.bodySha256, createHash('sha256').update(trimmed, 'utf8').digest('hex'))
  assert.equal(receipt.bodyBytes, Buffer.byteLength(trimmed, 'utf8') + 4)
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

it('口径：BOM 影响 bodyBytes/hash，但 preview 被 trim 去掉', () => {
  const body = '\uFEFF你好'
  const receipt = buildBodyReceipt(body)
  const expected = independentlyExpected(body)
  assert.equal(receipt.bodyBytes, 9, 'BOM 3 字节 + 两个汉字 6 字节')
  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.notEqual(receipt.bodySha256, createHash('sha256').update('你好', 'utf8').digest('hex'))
  assert.equal(receipt.preview, '你好')
  assert.equal(receipt.preview.codePointAt(0), 0x4f60, 'preview 不以 BOM 开头')
  assert.equal(previewOf(body), '你好')
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})
