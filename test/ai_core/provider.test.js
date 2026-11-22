import test from "node:test"
import assert from "node:assert/strict"
import { getProvider, supportedAdapters } from "../../lib/ai_core/llm/index.js"

test("provider: 当前已实现的请求适配器", () => {
  assert.deepEqual(supportedAdapters(), ["gemini", "openai", "anthropic", "responses"])
  assert.ok(getProvider("gemini"))
  assert.ok(getProvider("openai"))
  assert.ok(getProvider("anthropic"))
  assert.ok(getProvider("responses"))
})

test("provider: 未知请求适配器明确报错", () => {
  assert.throws(() => getProvider("unknown"), /不支持的请求适配器: unknown/)
})
