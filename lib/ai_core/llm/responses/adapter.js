import path from "node:path"
import { createSdkClient } from "../openai/adapter.js"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import log from "../../helpers/log.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys, nextApiKey } from "../api-keys.js"
import { resolveModelConfig } from "../model-config.js"
import { applyMediaCapabilities, mediaCapabilities } from "../media-capabilities.js"
import { retryAttempts, isRetryableError, isTimeoutError, isUserAbortError, sleepWithSignal } from "../retry.js"
import { formatMsgTime } from "../../helpers/time.js"

function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "?"
  return `${key.slice(0, 5)}***${key.slice(-4)}`
}

const REQUEST_TIMEOUT_MS = 300_000
const RETRY_DELAY_MIN_MS = 15_000
const RETRY_DELAY_MAX_MS = 40_000

function textWithContext(msg) {
  if (!msg.time) return msg.content || ""
  const ctx = msg.chat_type ? ` ${msg.chat_type}${msg.chat_type === "群聊" && msg.group_name ? ` ${msg.group_name}` : ""}` : ""
  return `[${formatMsgTime(msg.time)}${ctx}] ${msg.content || ""}`
}

function flatten(list) {
  return (list || []).flatMap(x => (Array.isArray(x) ? x : [x])).filter(Boolean)
}

function mediaParts(msg) {
  const parts = []
  for (const url of flatten(msg.images)) {
    if (typeof url === "string" && (url.startsWith("data:image/") || /^https?:\/\//i.test(url))) {
      parts.push({ type: "input_image", image_url: url, detail: "auto" })
    } else {
      // 动画 GIF 会被媒体层转成 video/mp4；此处给文本占位，避免静默丢失
      parts.push({ type: "input_text", text: typeof url === "string" && url.startsWith("data:video/") ? "[视频]" : "[图片]" })
    }
  }
  const paths = msg.file_paths || []
  for (let i = 0; i < (msg.files || []).length; i++) {
    const data = msg.files[i]
    // 非 data URI 是媒体层的失败占位，正文里已有 [文件] 标记，不再重复
    if (typeof data !== "string" || !data.startsWith("data:")) continue
    parts.push({ type: "input_file", file_data: data, filename: path.basename(paths[i] || "") || "file" })
  }
  for (const _ of flatten(msg.audios)) parts.push({ type: "input_text", text: "[音频]" })
  for (const _ of flatten(msg.videos)) parts.push({ type: "input_text", text: "[视频]" })
  return parts
}

/** 项目内部消息 → Responses API input / instructions
 *  连续 user 消息在这里合并，避免依赖服务端对同角色连续输入的处理。
 */
export function convertMessages(messages) {
  const input = []
  const instructions = []

  const pushUser = content => {
    if (!content.length) return
    const last = input[input.length - 1]
    if (last?.role === "user" && Array.isArray(last.content)) last.content = [...last.content, ...content]
    else if (last?.role === "user" && typeof last.content === "string") last.content = [{ type: "input_text", text: last.content }, ...content]
    else input.push({ role: "user", content })
  }

  for (const msg of messages) {
    if (!msg) continue

    if (msg.role === "system") {
      if (msg.content) instructions.push(msg.content)
      continue
    }

    if (msg.role === "user") {
      const content = []
      if (msg.content) content.push({ type: "input_text", text: textWithContext(msg) })
      content.push(...mediaParts(msg))
      if (msg.runtime_context) content.push({ type: "input_text", text: msg.runtime_context })
      pushUser(content)
      continue
    }

    if (msg.role === "assistant") {
      // Responses stateless 回放：优先原样回传 output items（保留 id/call_id/encrypted_content）
      if (msg.response_items?.length) {
        for (const item of msg.response_items) {
          if (!item) continue
          if (!["message", "function_call", "reasoning"].includes(item.type)) continue
          if (item.type === "reasoning" && !item.encrypted_content) continue
          input.push(item)
        }
        continue
      }
      if (msg.content) input.push({ role: "assistant", content: msg.content })
      for (const tc of msg.tool_calls || []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || "{}" })
      }
      continue
    }

    if (msg.role === "tool") {
      const parts = []
      if (msg.content) parts.push({ type: "input_text", text: msg.content })
      parts.push(...mediaParts(msg))
      const output = parts.length === 0 ? "" : parts.length === 1 && parts[0].type === "input_text" ? parts[0].text : parts
      input.push({ type: "function_call_output", call_id: msg.tool_call_id, output })
    }
  }

  return { input, instructions: instructions.join("\n\n") || undefined }
}

function mapToolChoice(choice) {
  if (choice === "none" || choice === "auto" || choice === "required") return choice
  if (choice && typeof choice === "object") {
    const name = choice.function?.name || choice.name
    if (name) return { type: "function", name }
  }
  return undefined
}

/** 构造 Responses API 请求参数（纯函数，便于测试） */
export function buildResponseParams(messages, options = {}, modelConfig = {}) {
  const model = options.model || modelConfig.model
  if (!model) throw new AigcError("MODEL_REQUIRED", "Responses 模型配置缺少 model")

  const maxOutput = options.max_output_tokens ?? modelConfig.max_output_tokens ?? 65536
  const { input, instructions } = convertMessages(messages)

  const params = {
    ...(modelConfig.extra_body || {}),
    model,
    input,
    max_output_tokens: maxOutput,
    store: false,
    stream: false,
    background: false,
    ...(instructions ? { instructions } : {}),
  }

  // stateless 下推理项必须带回 encrypted_content，才能跨轮继续
  const include = modelConfig.extra_body?.include ?? ["reasoning.encrypted_content"]
  if (Array.isArray(include) && include.length) params.include = include

  if (options.tools?.length) {
    params.tools = options.tools.map(t => ({
      type: "function",
      name: t.function?.name,
      description: t.function?.description,
      parameters: t.function?.parameters || { type: "object", properties: {} },
      strict: false,
    }))
  }
  const toolChoice = mapToolChoice(options.tool_choice)
  if (toolChoice) params.tool_choice = toolChoice

  return { params, channel: options.channel || "default" }
}

/** Responses API 响应 → 项目统一响应格式 */
export function parseResponse(response) {
  if (!response) return { content: "", tool_calls: undefined, usage: null, blocked: true, finishReason: "EMPTY" }

  let content = ""
  const tool_calls = []
  let reasoning = ""

  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text") content += c.text || ""
        else if (c.type === "refusal") content += c.refusal || ""
      }
    } else if (item.type === "function_call") {
      // 输出被截断/未完成时参数不完整，不能拿去执行
      if (item.status && item.status !== "completed") continue
      tool_calls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } })
    } else if (item.type === "reasoning") {
      for (const s of item.summary || []) {
        if (s.type === "summary_text") reasoning += s.text || ""
      }
    }
  }
  if (!content && typeof response.output_text === "string") content = response.output_text

  const usage = response.usage
    ? {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
      }
    : null

  const status = response.status
  const reason = response.incomplete_details?.reason
  const failed = !!response.error || status === "failed" || status === "cancelled" || (status === "incomplete" && reason !== "content_filter" && !content && !tool_calls.length)
  const blocked = !failed && reason === "content_filter"

  return {
    content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    reasoning_content: reasoning || undefined,
    response_items: response.output,
    response_id: response.id,
    blocked,
    failed,
    finishReason: response.error?.message || reason || status,
    usage,
  }
}

async function responsesChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Responses API Key")

  const caps = mediaCapabilities(modelConfig, "responses")
  const { params, channel } = buildResponseParams(applyMediaCapabilities(messages, caps), options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher()
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)
  let lastError

  for (let attempt = 0; attempt < attempts; attempt++) {
    const api_key = nextApiKey(keys, channel)
    const t0 = Date.now()
    try {
      const client = createSdkClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout })
      const response = await client.responses.create(params, { signal: options.signal, timeout, maxRetries: 0 })
      log.debug(`Responses API 调用完成 ${params.model} ${Date.now() - t0}ms`)

      const u = response.usage || {}
      const inT = u.input_tokens ?? 0
      const outT = u.output_tokens ?? 0
      const cached = u.input_tokens_details?.cached_tokens ?? 0
      const thinking = u.output_tokens_details?.reasoning_tokens ?? 0
      const cachePct = inT > 0 ? Math.round((cached / inT) * 100) : 0
      log.info(`[${channel}] Token: 输入${inT} | 输出${outT} | 思考${thinking} | 总消耗${u.total_tokens ?? 0} | 缓存命中${cached}(${cachePct}%) | key: ${maskKey(api_key)}`)

      return parseResponse(response)
    } catch (err) {
      if (options.signal?.aborted || isUserAbortError(err)) throw new DOMException("Aborted", "AbortError")
      if (isTimeoutError(err)) err = new AigcError("TIMEOUT", `请求超时[${timeout / 1000}秒]`)
      if (!isRetryableError(err)) throw err

      lastError = err
      if (attempt < attempts - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`Responses API 调用失败 (key ${maskKey(api_key)}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, options.signal)
      }
    }
  }

  throw lastError
}

class ResponsesAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return responsesChat(messages, options)
  }
}

export { ResponsesAdapter }
