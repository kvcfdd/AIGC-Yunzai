import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/MemorySearchTool.js"

function makeContext(overrides = {}) {
  return {
    event: { self_id: "9", user_id: "1", isGroup: false },
    config: { aigc: { memory: { enable: true } } },
    ...overrides,
  }
}

test("memory_search: 总结未开启时不可用", async () => {
  const ctx = makeContext()
  ctx.config.aigc.memory.enable = false
  const r = await registry.execute("memory_search", { query: "奶茶" }, ctx)
  assert.equal(r.result, "Daily memory summaries are disabled.")
})

test("memory_search: 无过滤条件报错", async () => {
  const r = await registry.execute("memory_search", {}, makeContext())
  assert.match(r.error, /query or start_time/)
})

test("memory_search: start_time 晚于 end_time 报错", async () => {
  const r = await registry.execute("memory_search", { start_time: "2026-11-08", end_time: "2026-11-01" }, makeContext())
  assert.match(r.error, /start_time is later than end_time/)
})

test("memory_search: 时间格式无效报错", async () => {
  const r = await registry.execute("memory_search", { start_time: "昨天" }, makeContext())
  assert.match(r.error, /时间格式无效/)
})

test("memory_search: 缺少对话上下文", async () => {
  const r = await registry.execute("memory_search", { query: "奶茶" }, { config: { aigc: { memory: { enable: true } } } })
  assert.equal(r.result, "No active conversation context.")
})
