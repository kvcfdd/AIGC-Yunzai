import test from "node:test"
import assert from "node:assert/strict"
import { resolveEmbeddingConfig } from "../../lib/ai_core/embeddings/index.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

function base() {
  return {
    aigc: {
      models: [
        { name: "chat", base_url: "https://chat.example", api_keys: ["chat-key"], model: "chat-model" },
        {
          name: "vector",
          base_url: "https://embed.example/v1",
          api_keys: ["embed-key"],
          proxy: true,
          model: "text-embedding-3-small",
          dimensions: 1024,
          max_input_chars: 512,
          timeout_ms: 5000,
          retry_count: 1,
          headers: { "X-Test": "1" },
          extra_body: { foo: "bar" },
        },
      ],
      embeddings: { enable: true, model_config: "vector", adapter: "openai", retrieval: { min_similarity: 0.5 } },
    },
  }
}

test("embeddings: 适配器来自 embeddings，其余参数取所选模型条目", () => {
  const ec = resolveEmbeddingConfig(base())
  assert.equal(ec.adapterName, "openai")
  assert.equal(ec.base_url, "https://embed.example/v1")
  assert.deepEqual(ec.api_keys, ["embed-key"])
  assert.equal(ec.proxy, true)
  assert.equal(ec.embeddingModel, "text-embedding-3-small")
  assert.equal(ec.dimensions, 1024)
  assert.equal(ec.maxInputChars, 512)
  assert.equal(ec.timeoutMs, 5000)
  assert.equal(ec.retry_count, 1)
  assert.deepEqual(ec.headers, { "X-Test": "1" })
  assert.deepEqual(ec.extra_body, { foo: "bar" })
  assert.equal(ec.retrieval.minSimilarity, 0.5)
})

test("embeddings: 条目缺少可选参数时使用默认值", () => {
  const cfg = base()
  cfg.aigc.models[1] = { name: "vector", base_url: "https://embed.example/v1", api_keys: "k", model: "embed-1" }
  cfg.aigc.embeddings.adapter = "gemini"
  const ec = resolveEmbeddingConfig(cfg)
  assert.equal(ec.adapterName, "gemini")
  assert.equal(ec.embeddingModel, "embed-1")
  assert.equal(ec.dimensions, 768)
  assert.equal(ec.maxInputChars, 2000)
  assert.equal(ec.timeoutMs, 30000)
  assert.equal(ec.retry_count, 3)
  assert.deepEqual(ec.headers, {})
  assert.deepEqual(ec.extra_body, {})
})

test("embeddings: 不再读取旧版 embeddings 模型参数", () => {
  const cfg = base()
  cfg.aigc.models[1] = { name: "vector", base_url: "https://embed.example/v1", api_keys: "k" }
  cfg.aigc.embeddings.model = "legacy-embed"
  cfg.aigc.embeddings.dimensions = 256
  assert.equal(resolveEmbeddingConfig(cfg), null)

  cfg.aigc.models[1].model = "embed-1"
  const ec = resolveEmbeddingConfig(cfg)
  assert.equal(ec.embeddingModel, "embed-1")
  assert.equal(ec.dimensions, 768)
})

test("embeddings: 未启用返回 null", () => {
  const cfg = base()
  cfg.aigc.embeddings.enable = false
  assert.equal(resolveEmbeddingConfig(cfg), null)
})

test("embeddings: 不支持的适配器报错", () => {
  const cfg = base()
  cfg.aigc.embeddings.adapter = "anthropic"
  assert.throws(() => resolveEmbeddingConfig(cfg), /不支持的 embedding 请求适配器/)
})
