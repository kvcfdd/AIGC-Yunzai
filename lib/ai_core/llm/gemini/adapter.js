import cfg from "../../../config/config.js"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys } from "../api-keys.js"
import { API_REVISION, resolveThinkingLevel, convertToInteractions, parseInteractionSteps, parseInteractionUsage } from "./interactions.js"
import { resolveModelConfig } from "../model-config.js"
import { mediaCapabilities, prepareMediaMessages } from "../media-capabilities.js"
import { retryAttempts } from "../retry.js"
import { geminiUrl, apiErrorFrom, readJson } from "./http.js"
import { formatUsage } from "../usage.js"
import { REQUEST_TIMEOUT_MS, runWithRetry, maskKey } from "../provider-utils.js"

/** 构造 Interactions API 请求参数（纯函数，便于测试） */
export function buildInteractionParams(messages, options = {}, modelConfig = {}, aigc = {}) {
  const model = options.model || modelConfig.model
  if (!model) throw new AigcError("MODEL_REQUIRED", "Gemini 模型配置缺少 model")

  const channel = options.channel || "default"
  const { input, system_instruction, tools } = convertToInteractions(messages, options.tools)

  const generation_config = {
    max_output_tokens: options.max_output_tokens ?? modelConfig.max_output_tokens ?? 65536,
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
  const prepared = await prepareMediaMessages(messages, caps, { signal: options.signal, skipFallback: options.skipMediaFallback })
  const { params, model, channel } = buildInteractionParams(prepared, options, modelConfig, cfg.aigc || {})
  const headers = { ...(modelConfig.headers || {}), "Api-Revision": API_REVISION }
  const dispatcher = getLLMProxyDispatcher(modelConfig)
  const requestTimeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)

  const { result: data, apiKey } = await runWithRetry({
    label: "Interactions",
    keys,
    channel,
    attempts,
    timeout: requestTimeout,
    signal: options.signal,
    call: async api_key => {
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
        const json = await readJson(res)
        logger.debug(`Interactions API 调用完成 ${model} ${Date.now() - t0}ms`)
        return json
      } catch (err) {
        if (!options.signal?.aborted && timeoutSignal.aborted) throw new AigcError("TIMEOUT", `请求超时[${requestTimeout / 1000}秒]`)
        throw err
      }
    },
  })

  const interaction = unwrapInteraction(data)
  const steps = Array.isArray(interaction.steps) ? interaction.steps : []
  const status = interaction.status
  const usage = parseInteractionUsage(interaction.usage)

  // 2xx 但结构完全无法识别 → 请求失败，不冒充安全拦截
  if (!Array.isArray(interaction.steps) && status === undefined && interaction.usage === undefined) {
    logger.warn(`Interactions API 返回无法识别的响应结构`)
    return {
      content: "",
      tool_calls: undefined,
      usage,
      failed: true,
      blocked: false,
      finishReason: "EMPTY",
    }
  }

  const hardFail = status === "failed" || status === "cancelled" || status === "error"
  const incomplete = status === "incomplete" || status === "budget_exceeded"
  const reason = interaction.errors?.[0]?.message || status

  // 服务端失败/取消/无内容的不完整 → 失败；不冒充安全拦截
  if (hardFail || (incomplete && !steps.length)) {
    logger.warn(`Interactions API 返回失败状态: ${reason}`)
    return {
      content: "",
      tool_calls: undefined,
      usage,
      failed: true,
      blocked: false,
      finishReason: reason,
    }
  }

  // 空响应（且没有待执行工具）→ 可能被安全拦截
  if (!steps.length && status !== "requires_action") {
    logger.warn(`Interactions API 空响应，可能被安全拦截`)
    return {
      content: "",
      tool_calls: undefined,
      usage,
      blocked: true,
      finishReason: "SAFETY",
    }
  }

  const result = parseInteractionSteps(steps, interaction.usage)
  if (incomplete) result.finishReason = status

  // token 消耗日志: 输入 | 输出 | 思考 | 总消耗 | 缓存命中
  logger.info(`[${channel}] ${formatUsage(result.usage, { key: maskKey(apiKey) })}`)

  return result
}

/** Gemini 适配器 — 直接调用 Interactions API */
class GeminiAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return geminiChat(messages, options)
  }
}

export { GeminiAdapter }
