import cfg from "../../../config/config.js"
import { GoogleGenAI } from "@google/genai"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import log from "../../helpers/log.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys, rotateApiKeys, advanceApiKeyCursor } from "../api-keys.js"
import { API_REVISION, resolveThinkingLevel, convertToInteractions, parseInteractionSteps } from "./interactions.js"
import { resolveModelConfig } from "../model-config.js"
import { applyMediaCapabilities, mediaCapabilities } from "../media-capabilities.js"
import { isRetryableError, isTimeoutError, sleepWithSignal } from "../retry.js"

/** API Key 脱敏: 前 5 位 + *** + 末 4 位，过短返回 ? */
function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "?"
  return `${key.slice(0, 5)}***${key.slice(-4)}`
}

/** 单次请求超时 300 秒 */
const REQUEST_TIMEOUT_MS = 300_000
/** 失败重试间隔 20~60 秒随机 */
const RETRY_DELAY_MIN_MS = 20_000
const RETRY_DELAY_MAX_MS = 60_000

/** 构造 Interactions API 请求参数（纯函数，便于测试） */
export function buildInteractionParams(messages, options = {}, modelConfig = {}, aigc = {}) {
  const model = options.model || modelConfig.model || "gemini-3.8-flash"
  const channel = options.channel || "default"
  const { input, system_instruction, tools } = convertToInteractions(messages, options.tools)

  const generation_config = {
    max_output_tokens: options.max_output_tokens ?? modelConfig.max_output_tokens ?? aigc.max_output_tokens ?? 65536,
    thinking_level: resolveThinkingLevel(model, options.thinking_level ?? modelConfig.thinking_level ?? "medium"),
    thinking_summaries: channel === "main" && aigc.show_thinking ? "auto" : "none",
  }
  if (options.tool_choice === "none") generation_config.tool_choice = "none"

  return {
    model,
    channel,
    params: {
      // 透传厂商额外参数，关键字段随后覆盖
      ...(modelConfig.extra_body || {}),
      model,
      input,
      generation_config,
      store: false,
      ...(system_instruction ? { system_instruction } : {}),
      ...(tools?.length ? { tools } : {}),
    },
  }
}

/** 创建 SDK 客户端 — 自定义 endpoint / 协议版本 / 请求头 / 超时 / 代理 */
export function createSdkClient({ apiKey, endpoint, headers, dispatcher, apiVersion = "v1beta", timeout = REQUEST_TIMEOUT_MS }) {
  const fetchImpl = dispatcher
    ? (input, init) =>
        fetch(input, {
          ...(init || {}),
          dispatcher,
        })
    : undefined

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: endpoint,
      apiVersion,
      headers,
      timeout,
      // 关闭 SDK 自带重试，沿用本适配器的 key 轮询/退避策略
      retryOptions: { attempts: 1 },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  })
}

async function geminiChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const apiVersion = options.api_version || modelConfig.api_version || "v1beta"
  let baseUrl = (options.base_url || modelConfig.base_url || "https://generativelanguage.googleapis.com").replace(/\/+$/, "")
  if (baseUrl.endsWith(`/${apiVersion}`)) baseUrl = baseUrl.slice(0, -(apiVersion.length + 1))

  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Gemini API Key")

  const caps = mediaCapabilities(modelConfig, "gemini")
  const { params, model, channel } = buildInteractionParams(applyMediaCapabilities(messages, caps), options, modelConfig, cfg.aigc || {})
  const headers = { ...(modelConfig.headers || {}), "Api-Revision": API_REVISION }
  const dispatcher = getLLMProxyDispatcher()
  const requestTimeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const rotated = rotateApiKeys(keys, options.retry_count ?? modelConfig.retry_count, channel)
  let lastError
  let attempted = 0

  try {
    for (let attempt = 0; attempt < rotated.length; attempt++) {
      attempted++
      const api_key = rotated[attempt]
      const t0 = Date.now()
      const timeoutSignal = AbortSignal.timeout(requestTimeout)
      const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
      try {
        const client = createSdkClient({ apiKey: api_key, endpoint: baseUrl, headers, dispatcher, apiVersion, timeout: requestTimeout })
        const interaction = await client.interactions.create(params, {
          signal: requestSignal,
          timeout: requestTimeout,
          maxRetries: 0,
          retries: { strategy: "none" },
        })
        log.debug(`Interactions API 调用完成 ${model} ${Date.now() - t0}ms`)

        const steps = interaction.steps || []
        const status = interaction.status

        const hardFail = status === "failed" || status === "cancelled" || status === "error"
        const incomplete = status === "incomplete" || status === "budget_exceeded"
        const reason = interaction.errors?.[0]?.message || status

        // 服务端失败/取消/无内容的不完整 → 失败；不冒充安全拦截
        if (hardFail || (incomplete && !steps.length)) {
          log.warn(`Interactions API 返回失败状态: ${reason}`)
          return {
            content: "",
            tool_calls: undefined,
            usage: null,
            failed: true,
            blocked: false,
            finishReason: reason,
          }
        }

        // 空响应（且没有待执行工具）→ 可能被安全拦截
        if (!steps.length && status !== "requires_action") {
          log.warn(`Interactions API 空响应，可能被安全拦截`)
          return {
            content: "",
            tool_calls: undefined,
            usage: null,
            blocked: true,
            finishReason: "SAFETY",
          }
        }

        const result = parseInteractionSteps(steps, interaction.usage)
        if (incomplete) result.finishReason = status

        // token 消耗日志: 输入 | 输出 | 思考 | 总消耗 | 缓存命中
        const u = interaction.usage || {}
        const inT = u.total_input_tokens ?? 0
        const outT = u.total_output_tokens ?? 0
        const totalT = u.total_tokens ?? 0
        const cached = u.total_cached_tokens ?? (Array.isArray(u.cached_tokens_by_modality) ? u.cached_tokens_by_modality.reduce((sum, m) => sum + (m.tokens || 0), 0) : 0)
        const thinking = u.total_thought_tokens ?? Math.max(0, totalT - inT - outT)
        const cachePct = inT > 0 ? Math.round((cached / inT) * 100) : 0
        log.info(`[${channel}] Token: 输入${inT} | 输出${outT} | 思考${thinking} | 总消耗${totalT} | 缓存命中${cached}(${cachePct}%) | key: ${maskKey(api_key)}`)

        return result
      } catch (err) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError")
        if (timeoutSignal.aborted && !options.signal?.aborted) err = new AigcError("TIMEOUT", `请求超时[${requestTimeout / 1000}秒]`)
        else if (isTimeoutError(err)) err = new AigcError("TIMEOUT", `请求超时[${requestTimeout / 1000}秒]`)
        if (!isRetryableError(err)) throw err

        lastError = err
        if (attempt < rotated.length - 1) {
          const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
          log.warn(`Interactions API 调用失败 (key ${maskKey(api_key)}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
          await sleepWithSignal(delay, options.signal)
        }
      }
    }
  } finally {
    advanceApiKeyCursor(keys, attempted - 1, channel)
  }

  throw lastError
}

/** Gemini 适配器 — 官方 @google/genai SDK（Interactions API） */
class GeminiAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return geminiChat(messages, options)
  }
}

export { GeminiAdapter }
