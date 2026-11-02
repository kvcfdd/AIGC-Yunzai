import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { REQUEST_TIMEOUT_MS } from "./provider-utils.js"

/** 有代理时把 undici dispatcher 注入 SDK 的 fetch */
function proxyFetch(dispatcher) {
  if (!dispatcher) return undefined
  return (input, init) => fetch(input, { ...(init || {}), dispatcher })
}

/** 创建 OpenAI SDK 客户端 */
export function createOpenAIClient({ apiKey, baseURL, headers, dispatcher, timeout = REQUEST_TIMEOUT_MS }) {
  const fetchImpl = proxyFetch(dispatcher)
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: headers,
    timeout,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

/** 创建 Anthropic SDK 客户端 */
export function createAnthropicClient({ apiKey, baseURL, headers, dispatcher, timeout = REQUEST_TIMEOUT_MS, apiVersion = "2023-06-01" }) {
  const defaultHeaders = { ...headers, "anthropic-version": apiVersion }
  // SDK 1.x 默认用 Authorization: Bearer；同时补 x-api-key，兼容 Anthropic 及第三方兼容端点
  if (!Object.keys(defaultHeaders).some(k => k.toLowerCase() === "x-api-key")) defaultHeaders["x-api-key"] = apiKey

  const fetchImpl = proxyFetch(dispatcher)
  return new Anthropic({
    apiKey,
    baseURL,
    defaultHeaders,
    timeout,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}
