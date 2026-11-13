import path from "node:path"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys } from "../api-keys.js"
import { resolveModelConfig } from "../model-config.js"
import { retryAttempts } from "../retry.js"
import { mediaCapabilities, prepareMessagesForApi } from "../media-capabilities.js"
import { formatUsage } from "../usage.js"
import { REQUEST_TIMEOUT_MS, runWithRetry, maskKey, textWithContext, flatten, isRealMedia } from "../provider-utils.js"
import { STATUS_BAR } from "../message-builders.js"
import { createOpenAIClient } from "../sdk-client.js"
import { isAnimatedFrames, animatedFramesNote } from "../../media/animated.js"

/** 统一 tool_call 形状 */
function normalizeToolCall(tc) {
  return {
    id: tc.id,
    type: "function",
    function: { name: tc.function?.name, arguments: tc.function?.arguments || "{}" },
  }
}

function pushImagePart(parts, url) {
  if (typeof url === "string" && (url.startsWith("data:image/") || /^https?:\/\//i.test(url))) {
    parts.push({ type: "image_url", image_url: { url } })
    return
  }
  // 非图片 data URI 给文本占位，避免静默丢失
  parts.push({ type: "text", text: typeof url === "string" && url.startsWith("data:video/") ? "[视频]" : "[图片]" })
}

function imageParts(msg) {
  const parts = []
  for (const item of msg.images || []) {
    if (!item) continue
    if (isAnimatedFrames(item)) {
      parts.push({ type: "text", text: animatedFramesNote(item.length) })
      for (const url of item) pushImagePart(parts, url)
    } else if (Array.isArray(item)) {
      // 超长图切段：逐段送出
      for (const url of item) pushImagePart(parts, url)
    } else {
      pushImagePart(parts, item)
    }
  }
  return parts
}

function audioParts(msg) {
  const parts = []
  for (const uri of flatten(msg.audios)) {
    if (!isRealMedia(uri)) {
      parts.push({ type: "text", text: "[音频]" })
      continue
    }
    if (!uri.startsWith("data:audio/")) throw new AigcError("UNSUPPORTED_MEDIA", "OpenAI 适配器仅支持 base64 音频数据，不支持直接传 URL")
    const m = /^data:audio\/([^;]+);base64,(.+)$/i.exec(uri)
    if (!m) {
      parts.push({ type: "text", text: "[音频]" })
      continue
    }
    const fmt = m[1].toLowerCase()
    const format = fmt === "wav" || fmt === "x-wav" ? "wav" : fmt === "mpeg" || fmt === "mp3" ? "mp3" : null
    // 能力开启时不做静默降级：不支持该格式就直接报错，由用户关闭 media.audio 或改用兼容端点
    if (!format) throw new AigcError("UNSUPPORTED_MEDIA", `OpenAI 适配器不支持 audio/${fmt} 输入；请关闭 media.audio 或改用支持该格式的端点`)
    parts.push({ type: "input_audio", input_audio: { data: m[2], format } })
  }
  return parts
}

function fileParts(msg) {
  const parts = []
  const paths = msg.file_paths || []
  for (let i = 0; i < (msg.files || []).length; i++) {
    const uri = msg.files[i]
    if (typeof uri !== "string") continue
    if (!uri.startsWith("data:")) {
      // 能力开启时不做静默降级：真实文件 URL 无法内联，直接报错；[xx异常] 占位则跳过
      if (isRealMedia(uri)) throw new AigcError("UNSUPPORTED_MEDIA", "OpenAI 适配器仅支持 base64 文件数据，不支持直接传 URL")
      continue
    }
    parts.push({ type: "file", file: { file_data: uri, filename: path.basename(paths[i] || "") || "file" } })
  }
  return parts
}

function videoParts(msg) {
  return flatten(msg.videos).map(url => {
    if (typeof url === "string" && (url.startsWith("data:video/") || /^https?:\/\//i.test(url))) {
      // 千问等 OpenAI 兼容端点用 video_url 接收视频；需在模型配置里显式开启 media.video
      return { type: "video_url", video_url: { url } }
    }
    return { type: "text", text: "[视频]" }
  })
}

/** 消息媒体 → OpenAI Chat Completions content parts */
function mediaParts(msg) {
  return [...imageParts(msg), ...audioParts(msg), ...fileParts(msg), ...videoParts(msg)]
}

/** 项目内部消息 → OpenAI Chat Completions messages
 *  打断合并会在历史中留下连续 user 消息；这里合并成一条，兼容更严格的服务端。
 *  replayReasoning: 回传历史 reasoning_content */
export function convertMessages(messages, { replayReasoning = true } = {}) {
  const out = []
  let toolMedia = []

  const toParts = content => (Array.isArray(content) ? content : [])
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
      if (msg.runtime_context) parts.push({ type: "text", text: msg.runtime_context })
      pushUser(parts)
      continue
    }

    if (msg.role === "assistant") {
      const m = { role: "assistant", content: msg.content || null }
      if (replayReasoning && msg.reasoning_content) m.reasoning_content = msg.reasoning_content
      if (msg.tool_calls?.length) m.tool_calls = msg.tool_calls.map(normalizeToolCall)
      if (m.content || m.tool_calls) out.push(m)
      continue
    }

    if (msg.role === "tool") {
      const textParts = []
      if (msg.content) textParts.push({ type: "text", text: msg.content })
      if (msg[STATUS_BAR]) textParts.push({ type: "text", text: msg[STATUS_BAR] })
      const content = msg[STATUS_BAR] ? textParts : (textParts[0]?.text ?? "")
      out.push({ role: "tool", tool_call_id: msg.tool_call_id, content })
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
    messages: convertMessages(messages, { replayReasoning: modelConfig.reasoning_replay !== false }),
    [field]: maxOutput,
    stream: false,
  }
  if (options.tools?.length) params.tools = options.tools
  if (options.tool_choice) params.tool_choice = options.tool_choice

  return { params, channel }
}

/** 统一 usage 形状 */
function parseUsage(usage) {
  if (!usage) return null
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || usage.cached_tokens || 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  }
}

/** Chat Completion → 项目统一响应格式 */
export function parseChatCompletion(completion) {
  const choice = completion?.choices?.[0]
  if (!choice) {
    return { content: "", tool_calls: undefined, usage: parseUsage(completion?.usage), failed: true, blocked: false, finishReason: "EMPTY" }
  }

  const m = choice.message || {}
  const raw = m.content
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(p => (typeof p === "string" ? p : p?.text || p?.refusal || "")).join("") : ""
  const content = text || (m.refusal ? m.refusal : "")
  const tool_calls = m.tool_calls?.map(normalizeToolCall)
  const reasoning_content = typeof m.reasoning_content === "string" ? m.reasoning_content : typeof m.reasoning === "string" ? m.reasoning : undefined

  return {
    content: content || "",
    tool_calls: tool_calls?.length ? tool_calls : undefined,
    reasoning_content,
    blocked: choice.finish_reason === "content_filter",
    finishReason: choice.finish_reason,
    usage: parseUsage(completion.usage),
  }
}

async function openaiChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 OpenAI API Key")

  const caps = mediaCapabilities(modelConfig, "openai")
  const messagesForApi = await prepareMessagesForApi(messages, caps, { signal: options.signal, skipFallback: options.skipMediaFallback })
  const { params, channel } = buildChatParams(messagesForApi, options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher(modelConfig)
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)

  const { result: completion, apiKey } = await runWithRetry({
    label: "OpenAI",
    keys,
    channel,
    attempts,
    timeout,
    signal: options.signal,
    call: async api_key => {
      const t0 = Date.now()
      const client = createOpenAIClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout })
      const completion = await client.chat.completions.create(params, { signal: options.signal })
      logger.debug(`OpenAI API 调用完成 ${params.model} ${Date.now() - t0}ms`)
      return completion
    },
  })

  const parsed = parseChatCompletion(completion)
  logger.info(`[${channel}] ${formatUsage(parsed.usage, { key: maskKey(apiKey) })}`)
  return parsed
}

/** OpenAI 兼容适配器 — Chat Completions */
class OpenAIAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return openaiChat(messages, options)
  }
}

export { OpenAIAdapter }
