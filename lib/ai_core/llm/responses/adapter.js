import path from "node:path"
import { getLLMProxyDispatcher } from "../network-proxy.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys } from "../api-keys.js"
import { resolveModelConfig } from "../model-config.js"
import { retryAttempts } from "../retry.js"
import { mediaCapabilities, prepareMessagesForApi } from "../media-capabilities.js"
import { formatUsage } from "../usage.js"
import { stripQuotePrefix, STATUS_BAR } from "../message-builders.js"
import { REQUEST_TIMEOUT_MS, runWithRetry, maskKey, textWithContext, flatten, isRealMedia } from "../provider-utils.js"
import { createOpenAIClient } from "../sdk-client.js"
import { isAnimatedFrames, animatedFramesNote } from "../../media/animated.js"

/** 可在 stateless 模式下回放的 output item 类型 */
const REPLAYABLE_ITEMS = new Set(["message", "function_call", "reasoning"])

function pushImagePart(parts, url) {
  if (typeof url === "string" && (url.startsWith("data:image/") || /^https?:\/\//i.test(url))) {
    parts.push({ type: "input_image", image_url: url, detail: "auto" })
    return
  }
  // 非图片 data URI 给文本占位，避免静默丢失
  parts.push({ type: "input_text", text: typeof url === "string" && url.startsWith("data:video/") ? "[视频]" : "[图片]" })
}

function mediaParts(msg) {
  const parts = []
  for (const item of msg.images || []) {
    if (!item) continue
    if (isAnimatedFrames(item)) {
      parts.push({ type: "input_text", text: animatedFramesNote(item.length) })
      for (const url of item) pushImagePart(parts, url)
    } else if (Array.isArray(item)) {
      // 超长图切段：逐段送出
      for (const url of item) pushImagePart(parts, url)
    } else {
      pushImagePart(parts, item)
    }
  }
  const paths = msg.file_paths || []
  for (let i = 0; i < (msg.files || []).length; i++) {
    const data = msg.files[i]
    if (typeof data !== "string") continue
    if (!data.startsWith("data:")) {
      // 能力开启时不做静默降级：真实文件 URL 无法内联，直接报错；[xx异常] 占位则跳过
      if (isRealMedia(data)) throw new AigcError("UNSUPPORTED_MEDIA", "Responses 适配器仅支持 base64 文件数据，不支持直接传 URL")
      continue
    }
    parts.push({ type: "input_file", file_data: data, filename: path.basename(paths[i] || "") || "file" })
  }
  for (const uri of flatten(msg.audios)) {
    if (!isRealMedia(uri)) {
      parts.push({ type: "input_text", text: "[音频]" })
      continue
    }
    const [, fmt, data] = /^data:audio\/([^;]+);base64,(.+)$/i.exec(uri) || []
    const format = fmt === "wav" || fmt === "x-wav" ? "wav" : fmt === "mpeg" || fmt === "mp3" ? "mp3" : null
    if (!format) throw new AigcError("UNSUPPORTED_MEDIA", `Responses 适配器不支持 audio/${fmt || "unknown"} 输入；请关闭 media.audio 或改用支持该格式的端点`)
    parts.push({ type: "input_audio", input_audio: { data, format } })
  }
  for (const uri of flatten(msg.videos)) {
    if (isRealMedia(uri)) throw new AigcError("UNSUPPORTED_MEDIA", "Responses 适配器不支持视频输入；请关闭 media.video")
    parts.push({ type: "input_text", text: "[视频]" })
  }
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
          if (!item || !REPLAYABLE_ITEMS.has(item.type)) continue
          if (item.type === "reasoning" && !item.encrypted_content) continue
          // 落盘前清洗过引用前缀，回放时保持一致
          if (item.type === "message") {
            input.push({
              ...item,
              content: (item.content || []).map(c => (c.type === "output_text" ? { ...c, text: stripQuotePrefix(c.text) } : c)),
            })
          } else {
            input.push(item)
          }
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
      if (msg[STATUS_BAR]) parts.push({ type: "input_text", text: msg[STATUS_BAR] })
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
  const include = modelConfig.extra_body?.include
  if (include != null && !Array.isArray(include)) throw new AigcError("INVALID_INCLUDE", "Responses 的 extra_body.include 必须是数组")
  params.include = include ?? ["reasoning.encrypted_content"]

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
  const response_items = []

  for (const item of response.output || []) {
    if (!item) continue
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

    // 只持久化可回放的 item，避免存储无用类型；未完成的 function_call 一并剔除
    if (!REPLAYABLE_ITEMS.has(item.type)) continue
    if (item.type === "function_call" && item.status && item.status !== "completed") continue
    if (item.type === "reasoning" && !item.encrypted_content) continue
    response_items.push(item)
  }
  if (!content && typeof response.output_text === "string") content = response.output_text

  const usage = response.usage
    ? {
        prompt_tokens: response.usage.input_tokens ?? 0,
        completion_tokens: response.usage.output_tokens ?? 0,
        total_tokens: response.usage.total_tokens ?? 0,
        cached_tokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
        reasoning_tokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
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
    response_items: response_items.length ? response_items : undefined,
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
  const prepared = await prepareMessagesForApi(messages, caps, { signal: options.signal, skipFallback: options.skipMediaFallback })
  const { params, channel } = buildResponseParams(prepared, options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher(modelConfig)
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)

  const { result: response, apiKey } = await runWithRetry({
    label: "Responses",
    keys,
    channel,
    attempts,
    timeout,
    signal: options.signal,
    call: async api_key => {
      const t0 = Date.now()
      const client = createOpenAIClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout })
      const response = await client.responses.create(params, { signal: options.signal })
      logger.debug(`Responses API 调用完成 ${params.model} ${Date.now() - t0}ms`)
      return response
    },
  })

  const parsed = parseResponse(response)
  logger.info(`[${channel}] ${formatUsage(parsed.usage, { key: maskKey(apiKey) })}`)
  return parsed
}

class ResponsesAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return responsesChat(messages, options)
  }
}

export { ResponsesAdapter }
