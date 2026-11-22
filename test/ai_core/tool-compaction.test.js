import test from "node:test"
import assert from "node:assert/strict"
import { collectToolGroups, contextThreshold, CONTEXT_KEEP_TURNS, estimateContextTokens, estimateTextTokens, keepTurnCount, selectToolGroupsForCompaction } from "../../lib/ai_core/core/tool-compaction.js"

test("tool compaction: 普通用户 15/16%，master 落盘 25% / 本轮 65%", () => {
  assert.equal(contextThreshold({ context_window: 1_000_000 }, false, "persist"), 150_000)
  assert.equal(contextThreshold({ context_window: 1_000_000 }, false, "inTurn"), 160_000)
  assert.equal(contextThreshold({ context_window: 1_000_000 }, true, "persist"), 250_000)
  assert.equal(contextThreshold({ context_window: 1_000_000 }, true, "inTurn"), 650_000)
  assert.equal(contextThreshold({ context_window: 128_000 }, false), Math.floor(128_000 * 0.16))
  assert.equal(contextThreshold({ context_window: 128_000 }, true, "persist"), Math.floor(128_000 * 0.25))
  assert.equal(contextThreshold({ context_window: 128_000 }, true, "inTurn"), Math.floor(128_000 * 0.65))
  assert.equal(contextThreshold({ context_window: 0 }, false), 0)
  assert.equal(contextThreshold({}, true), 0)
  assert.equal(contextThreshold({ context_window: 1000, max_output_tokens: 65536 }, false, "inTurn"), 160, "输出预留不超过半个窗口")
  assert.equal(contextThreshold({ context_window: 1000, max_output_tokens: 65536 }, true, "persist"), 250)
  assert.equal(contextThreshold({ context_window: 1000, max_output_tokens: 65536 }, true, "inTurn"), 500)
  assert.equal(contextThreshold({ context_window: 1000, max_output_tokens: 900 }, true, "inTurn"), 500)
  assert.equal(CONTEXT_KEEP_TURNS, 10)
})

test("tool compaction: 保留轮数为 1/10，至少 3 轮，最多 10 轮", () => {
  assert.equal(keepTurnCount(0), 3)
  assert.equal(keepTurnCount(3), 3)
  assert.equal(keepTurnCount(12), 3)
  assert.equal(keepTurnCount(30), 3)
  assert.equal(keepTurnCount(31), 4)
  assert.equal(keepTurnCount(100), 10)
  assert.equal(keepTurnCount(200), 10)
})

test("tool compaction: token 估算包含 system prompt", () => {
  assert.equal(estimateTextTokens(""), 0)
  assert.equal(estimateTextTokens("你好"), 2)
  const messages = [
    { role: "system", content: "你".repeat(1000) },
    { role: "user", content: "你好" },
    { role: "assistant", tool_calls: [{ function: { name: "x", arguments: "{}" } }] },
    { role: "tool", content: "result", images: ["x"] },
  ]
  assert.ok(estimateContextTokens(messages) > 1000 + 765)
  assert.equal(estimateContextTokens([{ role: "system", content: "你好" }]), 2)
})

test("tool compaction: 工具组收集与前 3/4 选择", () => {
  const messages = [
    { role: "user", content: "u" },
    { role: "assistant", tool_calls: [{ function: { name: "a" } }] },
    { role: "tool", content: "r1" },
    { role: "assistant", tool_calls: [{ function: { name: "b" } }] },
    { role: "tool", content: "r2" },
    { role: "assistant", content: "done" },
  ]
  const groups = collectToolGroups(messages)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0], [1, 2])
  assert.deepEqual(groups[1], [3, 4])
  const selected = selectToolGroupsForCompaction(groups)
  assert.equal(selected.remove.length, 1)
  assert.equal(selected.keep.length, 1)
  assert.deepEqual(selectToolGroupsForCompaction([groups[0]]).remove, [groups[0]])
})
