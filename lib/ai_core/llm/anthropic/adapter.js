import Anthropic from "@anthropic-ai/sdk"
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

function imageBlock(uri) {
  if (typeof uri !== "string") return null
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(uri)
  if (m) return { type: "image", source: { type: "base64", media_type: `image/${m[1].toLowerCase().replace("jpg", "jpeg")}`, data: m[2] } }
  if (/^https?:\/\//i.test(uri)) return { type: "image", source: { type: "url", url: uri } }
  return null
}

function documentBlock(uri) {
  if (typeof uri !== "string" || !uri.startsWith("data:")) return null
  const m = /^data:([^;]+);base64,(.+)$/i.exec(uri)
  if (!m) return null
  const mime = m[1].toLowerCase()
  if (mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: m[2] } }
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(m[2], "base64").toString("utf8") } }
  }
  return null
}

function mediaBlocks(msg) {
  const blocks = []
  for (const uri of flatten(msg.images)) {
    const b = imageBlock(uri)
    blocks.push(b || { type: "text", text: "[图片]" })
  }
  for (const uri of flatten(msg.files)) {
    const b = documentBlock(uri)
    blocks.push(b || { type: "text", text: "[文件]" })
  }
  for (const _ of flatten(msg.audios)) blocks.push({ type: "text", text: "[音频]" })
  for (const _ of flatten(msg.videos)) blocks.push({ type: "text", text: "[视频]" })
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
  const flushToolResults = () => {
    if (!toolResults.length) return
    pushMessage("user", toolResults)
    toolResults = []
  }

  // 只回放当前轮(最后一条 user 之后)的 thinking；历史轮 system 已变化，签名可能失效
  const lastUserIndex = (messages || []).findLastIndex?.(m => m?.role === "user") ?? -1

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
      pushMessage("user", content)
      continue
    }

    if (msg.role === "assistant") {
      const blocks = []
      if (idx > lastUserIndex) {
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
      continue
    }

    if (msg.role === "tool") {
      const content = []
      if (msg.content) content.push({ type: "text", text: msg.content })
      content.push(...mediaBlocks(msg))
      const result = { type: "tool_result", tool_use_id: msg.tool_call_id }
      if (content.length) result.content = content
      if (msg.is_error === true) result.is_error = true
      toolResults.push(result)
    }
  }
  flushToolResults()

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
    ...(system ? { system } : {}),
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
  const usage = message?.usage
    ? {
        prompt_tokens: message.usage.input_tokens,
        completion_tokens: message.usage.output_tokens,
        total_tokens: (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0),
      }
    : null

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

export function createSdkClient({ apiKey, baseURL, headers, dispatcher, timeout = REQUEST_TIMEOUT_MS, apiVersion = "2023-06-01" }) {
  const fetchImpl = dispatcher
    ? (input, init) =>
        fetch(input, {
          ...(init || {}),
          dispatcher,
        })
    : undefined

  const defaultHeaders = { ...headers, "anthropic-version": apiVersion }
  // SDK 1.x 默认用 Authorization: Bearer；同时补 x-api-key，兼容 Anthropic 及第三方兼容端点
  if (!Object.keys(defaultHeaders).some(k => k.toLowerCase() === "x-api-key")) defaultHeaders["x-api-key"] = apiKey

  return new Anthropic({
    apiKey,
    baseURL,
    defaultHeaders,
    timeout,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

async function anthropicChat(messages, options = {}) {
  const modelConfig = options.modelConfig || resolveModelConfig()
  const keys = collectApiKeys(modelConfig, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Anthropic API Key")

  const caps = mediaCapabilities(modelConfig, "anthropic")
  const { params, channel } = buildMessageParams(applyMediaCapabilities(messages, caps), options, modelConfig)
  const baseURL = (options.base_url || modelConfig.base_url || "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "")
  const headers = { ...(modelConfig.headers || {}) }
  const dispatcher = getLLMProxyDispatcher()
  const timeout = options.timeout_ms || modelConfig.timeout_ms || REQUEST_TIMEOUT_MS
  const apiVersion = options.api_version || modelConfig.api_version || "2023-06-01"
  const attempts = retryAttempts(options.retry_count ?? modelConfig.retry_count)
  let lastError

  for (let attempt = 0; attempt < attempts; attempt++) {
    const api_key = nextApiKey(keys, channel)
    const t0 = Date.now()
    try {
      const client = createSdkClient({ apiKey: api_key, baseURL, headers, dispatcher, timeout, apiVersion })
      const message = await client.messages.create(params, { signal: options.signal, timeout, maxRetries: 0 })
      log.debug(`Anthropic API 调用完成 ${params.model} ${Date.now() - t0}ms`)

      const u = message.usage || {}
      const inT = u.input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheWrite = u.cache_creation_input_tokens ?? 0
      const totalIn = inT + cacheRead + cacheWrite
      const cachePct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0
      log.info(`[${channel}] Token: 输入${inT} | 输出${u.output_tokens ?? 0} | 缓存读${cacheRead}(${cachePct}%) | 缓存写${cacheWrite} | key: ${maskKey(api_key)}`)

      return parseMessage(message)
    } catch (err) {
      if (options.signal?.aborted || isUserAbortError(err)) throw new DOMException("Aborted", "AbortError")
      if (isTimeoutError(err)) err = new AigcError("TIMEOUT", `请求超时[${timeout / 1000}秒]`)
      if (!isRetryableError(err)) throw err

      lastError = err
      if (attempt < attempts - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`Anthropic API 调用失败 (key ${maskKey(api_key)}): ${err.message}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, options.signal)
      }
    }
  }

  throw lastError
}

class AnthropicAdapter extends LlmProvider {
  async chat(messages, options = {}) {
    return anthropicChat(messages, options)
  }
}

export { AnthropicAdapter }
