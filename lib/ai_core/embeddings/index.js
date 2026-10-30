import log from "../helpers/log.js"
import { resolveModelConfig } from "../llm/model-config.js"
import { collectApiKeys, nextApiKey } from "../llm/api-keys.js"
import { retryAttempts, isRetryableError, sleepWithSignal } from "../llm/retry.js"
import { getLLMProxyDispatcher } from "../llm/network-proxy.js"
import gemini from "./gemini.js"
import openai from "./openai.js"

const ADAPTERS = { gemini, openai }
const DEFAULT_DIMENSIONS = 768
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_INPUT_CHARS = 2000
const RETRY_DELAY_MIN_MS = 1_000
const RETRY_DELAY_MAX_MS = 3_000

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function clampFloat(value, fallback, min, max) {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

/**
 * 解析 embedding 配置：
 * 仅复用 aigc.models[] 中所选模型配置的 base_url 与 api_keys，
 * 其余模型/连接参数全部由 aigc.embeddings 独立控制。未启用返回 null。
 */
export function resolveEmbeddingConfig(config) {
  const ec = config?.aigc?.embeddings || {}
  if (ec.enable === false || !ec.model) return null

  // 只取连接地址与 Key，不继承主模型配置的其他字段
  const source = resolveModelConfig({ model_config: ec.model_config }, config?.aigc || {})
  const api = String(ec.api || "gemini").toLowerCase()
  const adapter = ADAPTERS[api]
  if (!adapter) throw new Error(`不支持的 embedding API: ${api}（可选: ${Object.keys(ADAPTERS).join(" / ")}）`)

  return {
    api,
    adapter,
    base_url: source.base_url,
    api_keys: source.api_keys,
    headers: { ...(ec.headers || {}) },
    extra_body: { ...(ec.extra_body || {}) },
    retry_count: clampInt(ec.retry_count, 3, 0, 10),
    embeddingModel: String(ec.model),
    dimensions: clampInt(ec.dimensions, DEFAULT_DIMENSIONS, 1, 8192),
    batchSize: DEFAULT_BATCH_SIZE,
    maxInputChars: clampInt(ec.max_input_chars, DEFAULT_MAX_INPUT_CHARS, 100, 20_000),
    timeoutMs: clampInt(ec.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 300_000),
    retrieval: {
      backfillLimit: clampInt(ec.retrieval?.backfill_limit, 200, 0, 2000),
      topK: clampInt(ec.retrieval?.top_k, 10, 1, 50),
      // 余弦相似度下限；0 表示不过滤
      minSimilarity: clampFloat(ec.retrieval?.min_similarity, 0, 0, 1),
    },
  }
}

/** 是否配置了可用的 embedding（不抛错，供工具/检索判断） */
export function isEmbeddingAvailable(config) {
  try {
    return !!resolveEmbeddingConfig(config)?.adapter
  } catch {
    return false
  }
}

/**
 * 批量生成向量。
 * @param {string[]} texts
 * @param {{ config?: object, signal?: AbortSignal, taskType?: "document"|"query" }} opts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, { config, signal, taskType = "document", embedOverride } = {}) {
  if (embedOverride) return embedOverride(texts, { taskType })
  const list = (texts || []).map(t => String(t ?? ""))
  if (!list.length) return []

  const ec = resolveEmbeddingConfig(config)
  if (!ec) throw new Error("语义检索未启用：请在 aigc.embeddings 配置 enable/model")
  const keys = collectApiKeys(ec, {})
  if (!keys.length) throw new Error("未配置 embedding API Key（aigc.models 对应条目）")

  const dispatcher = getLLMProxyDispatcher()
  const attempts = Math.max(keys.length, retryAttempts(ec.retry_count))
  const out = []
  for (let offset = 0; offset < list.length; offset += ec.batchSize) {
    const batch = list.slice(offset, offset + ec.batchSize).map(text => text.slice(0, ec.maxInputChars))
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const apiKey = nextApiKey(keys, "embedding")
      try {
        const vectors = await ec.adapter.embed(batch, { config: ec, apiKey, dispatcher, signal, taskType, timeoutMs: ec.timeoutMs })
        if (vectors.length !== batch.length) throw new Error(`embedding 返回数量不匹配: ${vectors.length}/${batch.length}`)
        out.push(...vectors)
        lastError = null
        break
      } catch (err) {
        if (signal?.aborted) throw err
        if (!isRetryableError(err)) throw err
        lastError = err
        if (attempt + 1 >= keys.length && attempt < attempts - 1) {
          const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
          log.warn(`Embedding 调用失败 (${ec.api}/${ec.embeddingModel}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
          await sleepWithSignal(delay, signal)
        } else {
          log.warn(`Embedding 调用失败 (${ec.api}/${ec.embeddingModel}): ${err.message}`)
        }
      }
    }
    if (lastError) throw lastError
  }
  return out
}
