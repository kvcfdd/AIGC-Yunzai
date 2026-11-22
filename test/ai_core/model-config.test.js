import test from "node:test"
import assert from "node:assert/strict"
import { resolveModelConfig } from "../../lib/ai_core/llm/model-config.js"

const aigc = {
  adapter: "gemini",
  model_config: "a",
  models: [
    { name: "a", model: "m-a", max_output_tokens: 100, retry_count: 1 },
    { name: "b", model: "m-b", max_output_tokens: 200, retry_count: 2 },
  ],
}

test("models: 默认使用全局 model_config", () => {
  const c = resolveModelConfig({}, aigc)
  assert.equal(c.name, "a")
  assert.equal(c.adapter, "gemini")
  assert.equal(c.model, "m-a")
  assert.equal(c.max_output_tokens, 100)
  assert.equal(c.retry_count, 1)
})

test("models: 使用点覆盖 model_config / adapter / 参数", () => {
  const c = resolveModelConfig({ model_config: "b", adapter: "responses", max_output_tokens: 50 }, aigc)
  assert.equal(c.name, "b")
  assert.equal(c.adapter, "responses")
  assert.equal(c.max_output_tokens, 50)
  assert.equal(c.retry_count, 2)
})

test("models: adapter 只来自使用点或全局", () => {
  assert.equal(resolveModelConfig({ model_config: "b" }, aigc).adapter, "gemini")
  assert.equal(resolveModelConfig({ model_config: "b", adapter: "responses" }, aigc).adapter, "responses")
  assert.equal(resolveModelConfig({ model_config: "b" }, { models: aigc.models, adapter: "openai" }).adapter, "openai")
  // 模型配置里即使写了 adapter 也不参与选择
  assert.equal(resolveModelConfig({ model_config: "b" }, { models: [{ name: "b", adapter: "openai" }] }).adapter, "gemini")
})

test("models: 缺省时取第一个配置", () => {
  const c = resolveModelConfig({}, { models: aigc.models })
  assert.equal(c.name, "a")
  assert.equal(c.adapter, "gemini")
})

test("models: 任意命名 + openai 兼容", () => {
  const c = resolveModelConfig({ model_config: "deepseek", adapter: "openai" }, { models: [{ name: "deepseek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" }] })
  assert.equal(c.name, "deepseek")
  assert.equal(c.adapter, "openai")
  assert.equal(c.model, "deepseek-chat")
})

test("models: 未知配置报错", () => {
  assert.throws(() => resolveModelConfig({ model_config: "missing" }, aigc), /未找到模型配置/)
})

test("models: context_window 默认 1048576（1M），可由全局/模型条目/使用点覆盖", () => {
  assert.equal(resolveModelConfig({}, { models: [{ name: "a" }] }).context_window, 1_048_576)
  assert.equal(resolveModelConfig({}, { models: [{ name: "a", context_window: 200000 }] }).context_window, 200000)
  assert.equal(resolveModelConfig({ model_config: "a", context_window: 500000 }, { models: [{ name: "a", context_window: 200000 }] }).context_window, 500000)
  assert.equal(resolveModelConfig({}, { models: [{ name: "a" }], context_window: 123456 }).context_window, 123456)
})
