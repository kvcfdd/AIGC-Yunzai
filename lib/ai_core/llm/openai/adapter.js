import path from "node:path"
import OpenAI from "openai"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import log from "../../helpers/log.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys, rotateApiKeys } from "../api-keys.js"
import { resolveModelConfig } from "../model-config.js"
import { isRetryableError, isTimeoutError, isUserAbortError, sleepWithSignal } from "../retry.js"
import { mediaCapabilities, prepareMessagesForApi } from "../media-capabilities.js"
import { formatMsgTime } from "../../helpers/time.js"

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

/** 用户消息文本 + 时间/会话上下文 */
function textWithContext(msg) {
  if (!msg.time) return msg.content || ""
  const ctx = msg.chat_type ? ` ${msg.chat_type}${msg.chat_type === "群聊" && msg.group_name ? ` ${msg.group_name}` : ""}` : ""
  return `[${formatMsgTime(msg.time)}${ctx}] ${msg.content || ""}`
}

function flatten(list) {
  return (list || []).flatMap(x => (Array.isArray(x) ? x : [x])).filter(Boolean)
}

function imageParts(msg) {
  const parts = []
  for (const url of flatten(msg.images)) {
    if (typeof url === "string" && (url.startsWith("data:image/") || /^https?:\/\//i.test(url))) parts.push({ type: "image_url", image_url: { url } })
    else parts.push({ type: "text", text: "[图片]" })
  }
  return parts
}

function audioParts(msg) {
  const parts = []
  for (const uri of flatten(msg.audios)) {
    if (typeof uri !== "string" || !uri.startsWith("data:audio/")) {
      parts.push({ type: "text", text: "[音频]" })
      continue
    }
    const m = /^data:audio\/([^;]+);base64,(.+)$/i.exec(uri)
    const fmt = m?.[1]?.toLowerCase()
    if (!m || !["wav", "x-wav", "mpeg", "mp3"].includes(fmt)) {
      parts.push({ type: "text", text: "[音频格式不支持]" })
      continue
    }
    parts.push({ type: "input_audio", input_audio: { data: m[2], format: fmt === "wav" || fmt === "x-wav" ? "wav" : "mp3" } })
  }
  return parts
}

function fileParts(msg) {
  const parts = []
  const paths = msg.file_paths || []
  for (let i = 0; i < (msg.files || []).length; i++) {
    const uri = msg.files[i]
    if (typeof uri === "string" && uri.startsWith("data:")) {
      parts.push({ type: "file", file: { file_data: uri, filename: path.basename(paths[i] || "") || "file" } })
    } else {
      parts.push({ type: "text", text: "[文件]" })
    }
  }
  return parts
}

function videoParts(msg) {
  return flatten(msg.videos).map(() => ({ type: "text", text: "[视频]" }))
}

/** 消息媒体 → OpenAI Chat Completions content parts */
export function mediaParts(msg) {
  return [...imageParts(msg), ...audioParts(msg), ...fileParts(msg), ...videoParts(msg)]
}

/** 项目内部消息 → OpenAI Chat Completions messages
 *  打断合并会在历史中留下连续 user 消息；这里合并成一条，兼容更严格的服务端。
 */
export function convertMessages(messages) {
  const out = []
  let toolMedia = []

  const toParts = content => {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
    return Array.isArray(content) ? content : []
  }
  const pushUser = content => {
    const parts = toParts(content)
    if (!parts.length) return
    const last = out[out.length - 1]
    if (last?.role === "user") last.content = [...toParts(last.content), ...parts]
    else out.push({ role: "user", content: parts })
  }
  const flushToolMedia = () => {
    if (!toolMedia.length) return
    pushUser(toolMedia)
    toolMedia = []
  }

  for (const msg of messages) {
    if (!msg) continue
    if (msg.role !== "tool") flushToolMedia()

    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content || "" })
      continue
    }

    if (msg.role === "user") {
      const parts = []
      if (msg.content) parts.push({ type: "text", text: textWithContext(msg) })
      parts.push(...mediaParts(msg))
      pushUser(parts)
      continue
    }

    if (msg.role === "assistant") {
      const m = { role: "assistant", content: msg.content || null }
      if (msg.tool_calls?.length) {
        m.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function?.name, arguments: tc.function?.arguments || "{}" },
        }))
      }
      if (m.content || m.tool_calls) out.push(m)
      continue
    }

    if (msg.role === "tool") {
      out.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content || "" })
      const parts = mediaParts(msg)
      if (parts.length) toolMedia.push({ type: "text", text: `[工具 ${msg.name || "unknown"} 返回的媒体]` }, ...parts)
    }
  }
  flushToolMedia()
  return out
}

/** 构造 Chat Completions 请求参数（纯函数，便于测试） */
export function buildChatParams(messages, options = {}, modelConfig = {}) {
  const model = options.model || modelConfig.model
  if (!model) throw new AigcError("MODEL_REQUIRED", "OpenAI 模型配置缺少 model")

  const channel = options.channel || "default"
  const maxOutput = options.max_output_tokens ?? modelConfig.max_output_tokens ?? 65536
  const field = modelConfig.max_tokens_field === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"

  const params = {
    // 透传厂商额外参数（temperature/top_p/reasoning_effort 等），关键字段随后覆盖
    ...(modelConfig.extra_body || {}),
    model,
    messages: convertMessages(messages),
    [field]: maxOutput,
    stream: false,
  }
  if (options.tools?.length) params.tools = options.tools
  if (options.tool_choice) params.tool_choice = options.tool_choice

  return { params, channel }
}

/** Chat Completion → 项目统一响应格式 */
export function parseChatCompletion(completion) {
  const choice = completion?.choices?.[0]
  if (!choice) {
    return { content: "", tool_calls: undefined, usage: null, blocked: true, finishReason: "EMPTY" }
  }

  const m = choice.message || {}
  const raw = m.content
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(p => (typeof p === "string" ? p : p?.text || "")).join("") : ""
  const content = text || (m.refusal ? m.refusal : "")
  const tool_calls = m.tool_calls?.map(tc => ({
    id: tc.id,
    type: "function",
    function: { name: tc.function?.name, arguments: tc.function?.arguments || "{}" },
  }))
  const reasoning_content = typeof m.reasoning_content === "string" ? m.reasoning_content : typeof m.reasoning === "string" ? m.reasoning : undefined
  const usage = completion.usage
    ? {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
      }
    : null

  return {
    content: content || "",
    tool_calls: tool_calls?.length ? tool_calls : undefined,
    reasoning_content,
    blocked: choice.finish_reason === "content_filter",
    finishReason: choice.finish_reason,
    usage,
  }
}

/** 创建 SDK 客户端 — 自定义 baseURL / headers / 超时 / 代理 */
export function createSdkClient({ apiKey, baseURL, headers, dispatcher, timeout = REQUEST_TIMEOUT_MS }) {
  const fetchImpl = dispatcher
    ? (input, init) =>
        fetch(input, {
          ...(init || {}),
          dispatcher,
        })
    : undefined

  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: headers,
    timeout,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

async function openaiChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 OpenAI API Key")

  const caps = mediaCapabilities(modelConfig, "openai")
  const messagesForApi = await prepareMessagesForApi(messages, caps, { signal: options.signal })
  const { params, channel } = buildChatParams(messagesForApi, options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher()
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const rotated = rotateApiKeys(keys, options.retry_count ?? modelConfig.retry_count, channel)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const api_key = rotated[attempt]
    const t0 = Date.now()
    try {
      const client = createSdkClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout })
      const completion = await client.chat.completions.create(params, { signal: options.signal, timeout, maxRetries: 0 })
      log.debug(`OpenAI API 调用完成 ${params.model} ${Date.now() - t0}ms`)

      const u = completion.usage || {}
      const inT = u.prompt_tokens ?? 0
      const outT = u.completion_tokens ?? 0
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0
      const thinking = u.completion_tokens_details?.reasoning_tokens ?? 0
      const cachePct = inT > 0 ? Math.round((cached / inT) * 100) : 0
      log.info(`[${channel}] Token: 输入${inT} | 输出${outT} | 思考${thinking} | 总消耗${u.total_tokens ?? 0} | 缓存命中${cached}(${cachePct}%) | key: ${maskKey(api_key)}`)

      return parseChatCompletion(completion)
    } catch (err) {
      if (options.signal?.aborted || isUserAbortError(err)) throw new DOMException("Aborted", "AbortError")
      if (isTimeoutError(err)) err = new AigcError("TIMEOUT", `请求超时[${timeout / 1000}秒]`)
      if (!isRetryableError(err)) throw err

      lastError = err
      if (attempt < rotated.length - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`OpenAI API 调用失败 (key ${maskKey(api_key)}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, options.signal)
      }
    }
  }

  throw lastError
}

/** OpenAI 兼容适配器 — Chat Completions */
class OpenAIAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return openaiChat(messages, options)
  }
}

export { OpenAIAdapter }
