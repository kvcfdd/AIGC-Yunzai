import test from "node:test"
import assert from "node:assert/strict"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} } }
globalThis.segment = { at: () => ({}), record: () => ({}), image: () => ({}), file: () => ({}) }
globalThis.redis = { get: async () => null, set: async () => "OK", del: async () => 1, keys: async () => [] }

const registry = (await import("../../lib/ai_core/tools/index.js")).default
const { normalizeToolResult } = await import("../../lib/ai_core/tools/tool-result.js")
const ctx = { event: { isMaster: true }, config: { aigc: {} } }

registry.register({
  name: "fake_deferred_media",
  description: "fake",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ images: ["data:image/png;base64,eA=="], image_paths: ["/tmp/a.png"], text: "Image loaded" }),
})
registry.register({
  name: "fake_deferred_text",
  description: "fake",
  parameters: { type: "object", properties: {} },
  execute: async () => "ok",
})

test("tool_exec: 纯文本结果保持字符串", async () => {
  const r = await registry.execute("tool_exec", { calls: [{ name: "fake_deferred_text", arguments: {} }] }, ctx)
  assert.equal(r.error, undefined)
  assert.equal(typeof r.result, "string")
  assert.equal(JSON.parse(r.result).results[0].result, "ok")
})

test("tool_exec: 延迟工具的媒体结果原样透传", async () => {
  const r = await registry.execute("tool_exec", { calls: [{ name: "fake_deferred_media", arguments: {} }] }, ctx)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.result.images, ["data:image/png;base64,eA=="])
  assert.deepEqual(r.result.image_paths, ["/tmp/a.png"])
  // 媒体不进入文本，也不被结果长度预算截断
  assert.equal(r.result.text.includes("base64"), false)
  assert.equal(JSON.parse(r.result.text).results[0].result, "Image loaded")

  // tool-loop 用 normalizeToolResult 消费该结果，媒体应完整保留
  const normalized = normalizeToolResult(r.result)
  assert.equal(normalized.content, r.result.text)
  assert.deepEqual(normalized.images, ["data:image/png;base64,eA=="])
  assert.deepEqual(normalized.image_paths, ["/tmp/a.png"])
})
