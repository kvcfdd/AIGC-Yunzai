import log from "../helpers/log.js"
import { resolveModelConfig } from "../llm/model-config.js"
import { collectApiKeys, nextApiKey } from "../llm/api-keys.js"
import { retryAttempts, isRetryableError, sleepWithSignal } from "../llm/retry.js"
import { getProxyDispatcher } from "../llm/network-proxy.js"
import { resolveKnowledgeConfig } from "./config.js"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_RETRIES = 10
const RETRY_DELAY_MIN_MS = 1_000
const RETRY_DELAY_MAX_MS = 3_000

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function clamp01(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0
}

function rerankUrl(baseUrl) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
  return /\/rerank$/i.test(base) ? base : `${base}/rerank`
}

/** 兼容 Jina / Cohere / vLLM / DashScope 等常见返回结构 */
function normalizeRows(data) {
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : Array.isArray(data?.output?.results) ? data.output.results : []
  const out = []
  for (const row of rows) {
    const index = Number(row?.index ?? row?.document_index)
    const score = Number(row?.relevance_score ?? row?.score ?? row?.relevance)
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(score)) continue
    out.push({ index, score: clamp01(score) })
  }
  return out
}

/** 通用 /rerank 请求 — 兼容 Jina / Cohere / vLLM / DashScope 等接口 */
async function requestRerank({ query, documents, model, topN, baseUrl, apiKey, headers, extraBody, dispatcher, signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetch(rerankUrl(baseUrl), {
    method: "POST",
    signal: requestSignal,
    headers: { "Content-Type": "application/json", ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, query, documents, top_n: topN, ...extraBody }),
    ...(dispatcher ? { dispatcher } : {}),
  })
  const text = await res.text().catch(() => "")
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
    err.status = res.status
    throw err
  }
  if (!text) return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("重排服务返回了非 JSON 响应")
  }
  return normalizeRows(data)
}

/**
 * 解析使用点选中的重排模型，参数与 embedding 一致：
 * 连接信息来自 aigc.models[] 中选中的条目，使用点只负责 enable / model_config / top_n。
 */
export function resolveRerankConfig(config, rerank) {
  const rc = rerank || resolveKnowledgeConfig(config).rerank
  if (!rc?.enable || !rc.modelConfig) return null
  const source = resolveModelConfig({ model_config: rc.modelConfig }, config?.aigc)
  const model = String(source.model || "").trim()
  const baseUrl = String(source.base_url || "").trim()
  if (!model || !baseUrl) return null

  return {
    model,
    baseUrl,
    apiKeys: collectApiKeys(source, {}),
    proxy: source.proxy === true,
    headers: { ...(source.headers || {}) },
    extraBody: { ...(source.extra_body || {}) },
    timeoutMs: clampInt(source.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS),
    retryCount: clampInt(source.retry_count, 0, 0, MAX_RETRIES),
    topN: rc.topN || 5,
  }
}

/**
 * 通用重排 — 返回 [{ index, score }]；未配置时返回 null。
 * 与 embedding 一样支持多 Key 轮询、可重试错误退避与请求中断。
 */
export async function rerankDocuments(query, documents, { config, rerank, signal } = {}) {
  const list = (documents || []).map(text => String(text ?? ""))
  if (!list.length) return []
  const rc = resolveRerankConfig(config, rerank)
  if (!rc) return null

  const dispatcher = getProxyDispatcher(rc.proxy)
  const attempts = Math.max(rc.apiKeys.length, retryAttempts(rc.retryCount))
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const apiKey = nextApiKey(rc.apiKeys, "rerank")
    try {
      return await requestRerank({
        query: String(query || ""),
        documents: list,
        model: rc.model,
        topN: Math.min(rc.topN, list.length),
        baseUrl: rc.baseUrl,
        apiKey,
        headers: rc.headers,
        extraBody: rc.extraBody,
        dispatcher,
        signal,
        timeoutMs: rc.timeoutMs,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      lastError = err
      if (attempt + 1 >= Math.max(rc.apiKeys.length, 1) && attempt < attempts - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`重排调用失败 (${rc.model}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, signal)
      } else {
        log.warn(`重排调用失败 (${rc.model}): ${err.message}`)
      }
    }
  }
  throw lastError || new Error("重排请求失败")
}
