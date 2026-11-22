import test from "node:test"
import assert from "node:assert/strict"
import { normalizeToolResult } from "../../lib/ai_core/tools/tool-result.js"

test("normalizeToolResult: 字符串直通", () => {
  assert.equal(normalizeToolResult("ok").content, "ok")
})

test("normalizeToolResult: 媒体对象", () => {
  const r = normalizeToolResult({ images: ["data:image/png;base64,x"], image_paths: ["/tmp/a.png"], text: "图片获取成功" })
  assert.equal(r.content, "图片获取成功")
  assert.deepEqual(r.images, ["data:image/png;base64,x"])
  assert.deepEqual(r.image_paths, ["/tmp/a.png"])
})

test("normalizeToolResult: 普通对象 JSON 化", () => {
  const r = normalizeToolResult({ foo: 1 })
  assert.equal(r.content, '{"foo":1}')
})

test("normalizeToolResult: 文件只接收路径", () => {
  const r = normalizeToolResult({ file_paths: ["/tmp/a.txt"], text: "文件获取成功" })
  assert.equal(r.content, "文件获取成功")
  assert.deepEqual(r.file_paths, ["/tmp/a.txt"])
})

test("normalizeToolResult: 文件没有正文时使用默认提示", () => {
  const r = normalizeToolResult({ file_paths: ["/tmp/a.txt"] })
  assert.equal(r.content, "文件获取成功")
  assert.deepEqual(r.file_paths, ["/tmp/a.txt"])
})
