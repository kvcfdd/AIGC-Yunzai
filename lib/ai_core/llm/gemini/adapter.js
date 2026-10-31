import cfg from "../../../config/config.js"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import log from "../../helpers/log.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys, nextApiKey } from "../api-keys.js"
import { API_REVISION, resolveThinkingLevel, convertToInteractions, parseInteractionSteps } from "./interactions.js"
import { resolveModelConfig } from "../model-config.js"
import { applyMediaCapabilities, mediaCapabilities } from "../media-capabilities.js"
import { retryAttempts, isRetryableError, isTimeoutError, sleepWithSignal } from "../retry.js"
import { geminiUrl, apiErrorFrom, readJson } from "./http.js"

/** API Key 脱敏: 前 5 位 + *** + 末 4 位，过短返回 ? */
function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "?"
  return `${key.slice(0, 5)}***${key.slice(-4)}`
}

/** 单次请求超时 300 秒 */
const REQUEST_TIMEOUT_MS = 300_000
/** 失败重试间隔 15~40 秒随机 */
const RETRY_DELAY_MIN_MS = 15_000
const RETRY_DELAY_MAX_MS = 40_000

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
      stream: false,
      input,
      generation_config,
      store: false,
      ...(system_instruction ? { system_instruction } : {}),
      ...(tools?.length ? { tools } : {}),
    },
  }
}

/** 响应体可能被数组包裹，取出 interaction 对象 */
export function unwrapInteraction(data) {
  if (Array.isArray(data)) return data.find(item => item && (item.steps || item.status)) || {}
  return data || {}
}

async function geminiChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const url = geminiUrl(options.base_url || modelConfig.base_url, "/interactions")

  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Gemini API Key")

  const caps = mediaCapabilities(modelConfig, "gemini")
  const { params, model, channel } = buildInteractionParams(applyMediaCapabilities(messages, caps), options, modelConfig, cfg.aigc || {})
  const headers = { ...(modelConfig.headers || {}), "Api-Revision": API_REVISION }
  const dispatcher = getLLMProxyDispatcher()
  const requestTimeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)
  let lastError

  for (let attempt = 0; attempt < attempts; attempt++) {
    const api_key = nextApiKey(keys, channel)
    const t0 = Date.now()
    const timeoutSignal = AbortSignal.timeout(requestTimeout)
    const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "x-goog-api-key": api_key,
        },
        body: JSON.stringify(params),
        signal: requestSignal,
        dispatcher,
      })

      if (!res.ok) throw await apiErrorFrom(res)
      const data = await readJson(res)
      log.debug(`Interactions API 调用完成 ${model} ${Date.now() - t0}ms`)

      const interaction = unwrapInteraction(data)
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
      if (attempt < attempts - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`Interactions API 调用失败 (key ${maskKey(api_key)}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, options.signal)
      }
    }
  }

  throw lastError
}

/** Gemini 适配器 — 直接调用 Interactions API */
class GeminiAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return geminiChat(messages, options)
  }
}

export { GeminiAdapter }
export { describeApiError } from "./http.js"
