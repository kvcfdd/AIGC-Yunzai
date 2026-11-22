import test from "node:test"
import assert from "node:assert/strict"
import { collectApiKeys, nextApiKey } from "../../lib/ai_core/llm/api-keys.js"

const KEYS = ["k1", "k2", "k3"]

test("api-keys: 字符串支持逗号/分号/空白分隔并去重", () => {
  assert.deepEqual(collectApiKeys({ api_keys: "a,b; c\nd, a" }, {}), ["a", "b", "c", "d"])
  assert.deepEqual(collectApiKeys({ api_keys: [" a ", "b", ""] }, {}), ["a", "b"])
  assert.deepEqual(collectApiKeys({}, { api_keys: "x, y" }), ["x", "y"])
  assert.deepEqual(collectApiKeys({}, {}), [])
})

test("api-keys: 每次尝试取下一个 Key，按圈轮换（有头无尾）", () => {
  const channel = "ring"
  const seq = Array.from({ length: 8 }, () => nextApiKey(KEYS, channel))
  assert.deepEqual(seq, ["k1", "k2", "k3", "k1", "k2", "k3", "k1", "k2"])
})

test("api-keys: 只有一个 Key 时始终返回它（重试不受 Key 数限制）", () => {
  const channel = "single"
  assert.equal(nextApiKey(["only"], channel), "only")
  assert.equal(nextApiKey(["only"], channel), "only")
})

test("api-keys: 各通道独立轮询", () => {
  assert.equal(nextApiKey(KEYS, "ind-main"), "k1")
  assert.equal(nextApiKey(KEYS, "ind-ambient"), "k1")
  assert.equal(nextApiKey(KEYS, "ind-main"), "k2")
  assert.equal(nextApiKey(KEYS, "ind-ambient"), "k2")
})

test("api-keys: 空列表返回 undefined", () => {
  assert.equal(nextApiKey([], "empty"), undefined)
  assert.equal(nextApiKey(undefined, "empty"), undefined)
})
