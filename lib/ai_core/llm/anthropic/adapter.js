import { getLLMProxyDispatcher } from "../network-proxy.js"
import LlmProvider from "../provider-base.js"
import { AigcError } from "../errors.js"
import { collectApiKeys } from "../api-keys.js"
import { resolveModelConfig } from "../model-config.js"
import { mediaCapabilities, prepareMediaMessages } from "../media-capabilities.js"
import { retryAttempts } from "../retry.js"
import { formatUsage } from "../usage.js"
import { REQUEST_TIMEOUT_MS, runWithRetry, maskKey, textWithContext, flatten, isRealMedia } from "../provider-utils.js"
import { STATUS_BAR } from "../message-builders.js"
import { createAnthropicClient } from "../sdk-client.js"
import { isAnimatedFrames, animatedFramesNote } from "../../media/animated.js"

function imageBlock(uri) {
  if (typeof uri !== "string") return null
  const m = /^data:(image\/[^;]+);base64,(.+)$/i.exec(uri)
  if (m) {
    const mime = m[1].toLowerCase()
    return { type: "image", source: { type: "base64", media_type: mime === "image/jpg" ? "image/jpeg" : mime, data: m[2] } }
  }
  if (/^https?:\/\//i.test(uri)) return { type: "image", source: { type: "url", url: uri } }
  return null
}

function documentBlock(uri) {
  if (typeof uri !== "string") return null
  if (/^https?:\/\//i.test(uri)) return { type: "document", source: { type: "url", url: uri } }
  if (!uri.startsWith("data:")) return null
  const m = /^data:([^;]+);base64,(.+)$/i.exec(uri)
  if (!m) return null
  const mime = m[1].toLowerCase()
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(m[2], "base64").toString("utf8") } }
  }
  return { type: "document", source: { type: "base64", media_type: mime, data: m[2] } }
}

function pushImageBlock(blocks, uri) {
  const b = imageBlock(uri)
  if (b) blocks.push(b)
  else if (typeof uri === "string" && uri.startsWith("data:video/")) blocks.push({ type: "text", text: "[视频]" })
  else blocks.push({ type: "text", text: "[图片]" })
}

function mediaBlocks(msg) {
  const blocks = []
  for (const item of msg.images || []) {
    if (!item) continue
    if (isAnimatedFrames(item)) {
      blocks.push({ type: "text", text: animatedFramesNote(item.length) })
      for (const uri of item) pushImageBlock(blocks, uri)
    } else if (Array.isArray(item)) {
      // 超长图切段：逐段送出
      for (const uri of item) pushImageBlock(blocks, uri)
    } else {
      pushImageBlock(blocks, item)
    }
  }
  for (const uri of flatten(msg.files)) {
    const b = documentBlock(uri)
    blocks.push(b || { type: "text", text: "[文件]" })
  }
  for (const uri of flatten(msg.audios)) {
    if (isRealMedia(uri)) throw new AigcError("UNSUPPORTED_MEDIA", "Anthropic 适配器不支持音频输入；请关闭 media.audio")
    blocks.push({ type: "text", text: "[音频]" })
  }
  for (const uri of flatten(msg.videos)) {
    if (isRealMedia(uri)) throw new AigcError("UNSUPPORTED_MEDIA", "Anthropic 适配器不支持视频输入；请关闭 media.video")
    blocks.push({ type: "text", text: "[视频]" })
  }
  return blocks
}

/** 项目内部消息 → Anthropic Messages API 的 messages/system
 *  Anthropic 要求 user/assistant 交替；连续同角色消息在这里合并。
 *  tool_result 必须紧跟在对应的 assistant tool_use 之后。
 */
export function convertMessages(messages) {
  const systemParts = []
  const out = []
  let toolResults = []

  const toBlocks = content => {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
    return Array.isArray(content) ? content : []
  }
  const pushMessage = (role, content) => {
    const blocks = toBlocks(content)
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last?.role === role) last.content = [...toBlocks(last.content), ...blocks]
    else out.push({ role, content: blocks })
  }
  // Anthropic 显式缓存断点：可挂在 text / image / document / tool_use / tool_result 上
  const markLastBlock = () => {
    const last = out[out.length - 1]
    if (!Array.isArray(last?.content)) return
    for (let i = last.content.length - 1; i >= 0; i--) {
      const type = last.content[i]?.type
      if (type === "text" || type === "image" || type === "document" || type === "tool_use" || type === "tool_result") {
        last.content[i].cache_control = { type: "ephemeral" }
        return
      }
    }
  }
  let pendingBreak = false
  const flushToolResults = () => {
    if (!toolResults.length) return
    pushMessage("user", toolResults)
    toolResults = []
    if (pendingBreak) {
      markLastBlock()
      pendingBreak = false
    }
  }

  // 只回放当前轮的 thinking；历史轮 system 已变化，签名可能失效
  // tool-loop 用 turn_start 标记本轮第一条消息；直接调用适配器时退回“最后一条 user”
  // 不能只看最后一条 user：工具执行中的插话 user 会让本轮 assistant 落在它前面
  const turnStartIndex = (messages || []).findIndex(m => m?.turn_start)
  const lastUserIndex = (messages || []).findLastIndex(m => m?.role === "user")
  const historyBoundary = turnStartIndex >= 0 ? turnStartIndex - 1 : lastUserIndex

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]
    if (!msg) continue
    if (msg.role !== "tool") flushToolResults()

    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content)
      continue
    }

    if (msg.role === "user") {
      const content = []
      if (msg.content) content.push({ type: "text", text: textWithContext(msg) })
      content.push(...mediaBlocks(msg))
      if (msg.runtime_context) content.push({ type: "text", text: msg.runtime_context })
      pushMessage("user", content)
      if (msg.cache_break) markLastBlock()
      continue
    }

    if (msg.role === "assistant") {
      const blocks = []
      if (idx > historyBoundary) {
        for (const rp of msg.reasoning_parts || []) {
          if (rp?.redacted) blocks.push({ type: "redacted_thinking", data: rp.redacted })
          // display:"omitted" 时 thinking 文本为空但 signature 有效，必须原样回传
          else if (rp?.signature) blocks.push({ type: "thinking", thinking: rp.text || "", signature: rp.signature })
        }
      }
      if (msg.content) blocks.push({ type: "text", text: msg.content })
      for (const tc of msg.tool_calls || []) {
        let input = {}
        try {
          input = JSON.parse(tc.function?.arguments || "{}")
        } catch {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input })
      }
      pushMessage("assistant", blocks)
      if (msg.cache_break) markLastBlock()
      continue
    }

    if (msg.role === "tool") {
      const content = []
      if (msg.content) content.push({ type: "text", text: msg.content })
      content.push(...mediaBlocks(msg))
      if (msg[STATUS_BAR]) content.push({ type: "text", text: msg[STATUS_BAR] })
      const result = { type: "tool_result", tool_use_id: msg.tool_call_id }
      if (content.length) result.content = content
      if (msg.is_error === true) result.is_error = true
      if (msg.cache_break) pendingBreak = true
      toolResults.push(result)
    }
  }
  flushToolResults()

  // 请求末尾断点：同一轮内多轮工具调用可命中上一轮缓存
  if (out.length) markLastBlock()

  return { messages: out, system: systemParts.filter(Boolean).join("\n\n") || undefined }
}

function mapToolChoice(choice) {
  if (choice === "none") return { type: "none" }
  if (choice === "auto") return { type: "auto" }
  if (choice === "required") return { type: "any" }
  if (choice && typeof choice === "object") {
    const name = choice.function?.name || choice.name
    if (name) return { type: "tool", name }
  }
  return undefined
}

/** 构造 Messages API 请求参数（纯函数，便于测试） */
export function buildMessageParams(messages, options = {}, modelConfig = {}) {
  const model = options.model || modelConfig.model
  if (!model) throw new AigcError("MODEL_REQUIRED", "Anthropic 模型配置缺少 model")

  const maxOutput = options.max_output_tokens ?? modelConfig.max_output_tokens ?? 65536
  const { messages: converted, system } = convertMessages(messages)

  const params = {
    ...(modelConfig.extra_body || {}),
    model,
    max_tokens: maxOutput,
    messages: converted,
    stream: false,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
  }

  if (options.tools?.length) {
    params.tools = options.tools.map(t => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }))
  }
  const toolChoice = mapToolChoice(options.tool_choice)
  if (toolChoice) params.tool_choice = toolChoice

  return { params, channel: options.channel || "default" }
}

/** Messages API 响应 → 项目统一响应格式 */
export function parseMessage(message) {
  const blocks = message?.content || []
  let content = ""
  const tool_calls = []
  const reasoning_parts = []

  for (const b of blocks) {
    if (b.type === "text") content += b.text || ""
    else if (b.type === "tool_use") {
      tool_calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })
    } else if (b.type === "thinking") {
      reasoning_parts.push({ text: b.thinking || "", signature: b.signature || null })
    } else if (b.type === "redacted_thinking") {
      reasoning_parts.push({ text: "", signature: null, redacted: b.data })
    }
  }

  const reasoning_content = reasoning_parts.map(p => p.text).join("") || undefined
  let usage = null
  if (message?.usage) {
    const input = message.usage.input_tokens || 0
    const cacheRead = message.usage.cache_read_input_tokens || 0
    const cacheWrite = message.usage.cache_creation_input_tokens || 0
    const output = message.usage.output_tokens || 0
    const prompt = input + cacheRead + cacheWrite
    usage = {
      prompt_tokens: prompt,
      completion_tokens: output,
      total_tokens: prompt + output,
      cached_tokens: cacheRead,
      reasoning_tokens: message.usage.output_tokens_details?.thinking_tokens ?? 0,
    }
  }

  return {
    content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    reasoning_content,
    reasoning_parts: reasoning_parts.length ? reasoning_parts : undefined,
    blocked: message?.stop_reason === "refusal",
    finishReason: message?.stop_reason,
    usage,
  }
}

async function anthropicChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Anthropic API Key")

  const caps = mediaCapabilities(modelConfig, "anthropic")
  const prepared = await prepareMediaMessages(messages, caps, { signal: options.signal, skipFallback: options.skipMediaFallback })
  const { params, channel } = buildMessageParams(prepared, options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher(modelConfig)
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const apiVersion = options.api_version || modelConfig.api_version || "2023-06-01"
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)

  const { result: message, apiKey } = await runWithRetry({
    label: "Anthropic",
    keys,
    channel,
    attempts,
    timeout,
    signal: options.signal,
    call: async api_key => {
      const t0 = Date.now()
      const client = createAnthropicClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout, apiVersion })
      const message = await client.messages.create(params, { signal: options.signal })
      logger.debug(`Anthropic API 调用完成 ${params.model} ${Date.now() - t0}ms`)
      return message
    },
  })

  const parsed = parseMessage(message)
  logger.info(`[${channel}] ${formatUsage(parsed.usage, { key: maskKey(apiKey) })}`)
  return parsed
}

class AnthropicAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return anthropicChat(messages, options)
  }
}

export { AnthropicAdapter }
