import cfg from "../../../config/config.js"
import { getLLMDispatcher } from "../../helpers/proxy.js"
import log from "../../helpers/log.js"
import LlmProvider from "../base.js"
import { AigcError } from "../errors.js"
import { _collectKeys, KEY_IDX, STATEFUL_IDX, _rotateKeys } from "../keys.js"
import { API_REVISION, isGeminiModel, convertToInteractions, parseInteractionSteps } from "./interactions.js"

/** API Key 脱敏: 前 5 位 + *** + 末 4 位，过短返回 ? */
function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "?"
  return `${key.slice(0, 5)}***${key.slice(-4)}`
}

/** 粗略判断响应体是否为 JSON */
function isJsonText(text) {
  if (typeof text !== "string") return false
  const t = text.trim()
  return t.startsWith("{") || t.startsWith("[")
}

async function geminiChat(messages, options = {}) {
  const config = cfg.aigc?.gemini || {}
  const endpoint = options.endpoint || config.endpoint || "https://generativelanguage.googleapis.com"
  const stateful = options.stateful ?? config.stateful ?? false

  const keys = _collectKeys(config, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Gemini API Key")

  const model = options.model || config.model || "gemini-3.6-flash"
  const channel = options.channel || "default"
  const { input, system_instruction, tools } = convertToInteractions(messages, options.tools)

  const body = {
    model,
    input,
    generation_config: {
      max_output_tokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 8192,
    },
  }

  // 仅 Gemini 系列通过 API 参数开启思考；Gemma 系列通过 <|think|> token 激活
  if (isGeminiModel(model)) {
    body.generation_config.thinking_level = options.thinking_level ?? config.thinking_level ?? "medium"
    // 开启思维链转发时返回思考摘要，否则静默思考
    body.generation_config.thinking_summaries = channel === "main" && cfg.aigc?.show_thinking ? "auto" : "none"
  }

  if (options.tool_choice === "none") {
    body.generation_config.tool_choice = "none"
  }

  if (system_instruction) body.system_instruction = system_instruction
  if (tools?.length) body.tools = tools

  // 有状态模式：通过 previous_interaction_id 让服务端管理上下文
  if (stateful && options.previous_interaction_id) {
    body.previous_interaction_id = options.previous_interaction_id
  }

  // 有状态：使用持久游标指向的 key，未触发 429 就一直用它；429 才推进游标到下一个，
  // 无状态：每次请求切换下一个 key
  const retryCnt = stateful ? Math.min(Math.max(options.retry_count ?? cfg.aigc?.retry_count ?? 0, 0), 10) : 0
  let rotated
  if (stateful) {
    const start = (STATEFUL_IDX.get(channel) || 0) % keys.length
    rotated = [...keys.slice(start), ...keys.slice(0, start)]
  } else {
    rotated = _rotateKeys(keys, options.retry_count, channel)
  }
  let lastError

  retryLoop: for (let attempt = 0; attempt < rotated.length; attempt++) {
    const api_key = rotated[attempt]
    const keyTries = stateful ? retryCnt + 1 : 1
    for (let tryCount = 0; tryCount < keyTries; tryCount++) {
      const t0 = Date.now()
      try {
        const res = await fetch(`${endpoint}/v1beta/interactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
            "Api-Revision": API_REVISION,
          },
          body: JSON.stringify(body),
          signal: options.signal,
          dispatcher: getLLMDispatcher(),
        })

        if (!res.ok) {
          const text = await res.text()
          // 有状态模式下 interaction_id 过期 → 抛出特定错误码，由 _replyLoop 捕获后带完整历史重试。
          if ((res.status === 400 || res.status === 404) && stateful && body.previous_interaction_id) {
            throw new AigcError("SESSION_EXPIRED", `Session expired or invalid [${res.status}]`)
          }
          // 非 JSON 响应 → 统一按 520 报错
          const okJson = isJsonText(text)
          throw new AigcError(okJson ? String(res.status) : "520", `API 错误 [${okJson ? res.status : 520}]: ${okJson ? text : "响应非 JSON 格式"}`)
        }

        let data
        try {
          data = await res.json()
        } catch {
          // 200 但响应体非 JSON → 统一按 520 处理
          throw new AigcError("520", "API 错误 [200]: 响应非 JSON 格式")
        }
        log.debug(`Interactions API 调用完成 ${model} ${Date.now() - t0}ms`)

        const steps = data.steps || []

        // 检查状态：completed / requires_action / error
        if (data.status === "error") {
          log.warn(`Interactions API 返回错误状态`)
          return {
            content: "",
            tool_calls: undefined,
            usage: null,
            blocked: true,
            finishReason: data.error?.message || "error",
          }
        }

        // 内容安全拦截
        if (!steps.length && data.status !== "requires_action") {
          log.warn(`Interactions API 空响应，可能被安全拦截`)
          return {
            content: "",
            tool_calls: undefined,
            usage: null,
            blocked: true,
            finishReason: "SAFETY",
          }
        }

        const result = parseInteractionSteps(steps, data.usage)

        // 有状态模式：返回新的 interaction_id 供下次使用
        if (stateful && data.id) {
          result.interaction_id = data.id
        }

        // token 消耗日志: 输入 | 输出 | 思考 | 总消耗 | 缓存命中
        const u = data.usage || {}
        const inT = u.total_input_tokens ?? 0
        const outT = u.total_output_tokens ?? 0
        const totalT = u.total_tokens ?? 0
        const cached = Array.isArray(u.cached_tokens_by_modality) ? u.cached_tokens_by_modality.reduce((sum, m) => sum + (m.tokens || 0), 0) : 0
        const thinking = u.thinking_tokens ?? Math.max(0, totalT - inT - outT)
        log.info(`[${channel}] Token: 输入${inT} | 输出${outT} | 思考${thinking} | 总消耗${totalT} | 缓存命中${cached} | key: ${maskKey(api_key)}`)

        return result
      } catch (err) {
        if (err?.name === "AbortError" || err?.code === "SESSION_EXPIRED" || err?.code === "400") throw err
        lastError = err
        // 429 限流：有状态模式推进持久游标切换下一个 key。
        if (stateful && err?.code === "429") {
          STATEFUL_IDX.set(channel, (STATEFUL_IDX.get(channel) || 0) + 1)
          log.warn(`API 限流 (429)，key ${maskKey(api_key)} 触发，切换到下一个 key 重试 (${attempt + 1}/${rotated.length})`)
          break
        }
        // 有状态模式固定当前 key：非 429 错误重试用尽即失败，不跨 key 轮询
        if (stateful && tryCount >= keyTries - 1) break retryLoop
        if (tryCount < keyTries - 1 || attempt < rotated.length - 1) {
          log.warn(`Interactions API 调用失败 (key ${maskKey(api_key)}): ${err.message}，3秒后重试...`)
          await Bot.sleep(3000)
        }
      }
    }
  }

  throw lastError
}

/** Gemini 适配器 — Interactions API 后端 */
class GeminiAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return geminiChat(messages, options)
  }
}

export { GeminiAdapter }
