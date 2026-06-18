import sharp from "sharp"
import cfg from "../config/config.js"
import { getLLMDispatcher } from "./helpers/proxy.js"
import { formatMsgTime } from "./helpers/time.js"
import log from "./helpers/log.js"

class AigcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = "AigcError"
  }
}

const MAX_VISION_IMAGES = 4
const MAX_IMAGE_PX = 1568
const WEBP_QUALITY = 80
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

/** 下载图片 → sharp 压缩 → 返回 data URI  */
async function imageToDataUri(url, headers = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`下载失败 [${res.status}]`)

  // 防御：原始图像超过 10MB 直接忽略
  const cl = res.headers.get("content-length")
  if (cl) {
    const size = parseInt(cl, 10)
    if (size > MAX_IMAGE_BYTES) throw new Error(`图片过大 [${(size / 1024 / 1024).toFixed(1)}MB]`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片过大 [${(buffer.length / 1024 / 1024).toFixed(1)}MB]`)
  const origMime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim()
  const origFmt = origMime.split("/")[1] || "jpeg"

  const encode = (fmt, buf) => `data:image/${fmt};base64,${buf.toString("base64")}`

  const compress = async fmt => {
    const image = sharp(buffer, { animated: true }).resize(MAX_IMAGE_PX, MAX_IMAGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    if (fmt === "webp") return image.webp({ quality: WEBP_QUALITY }).toBuffer()
    if (fmt === "jpeg") return image.jpeg({ quality: WEBP_QUALITY }).toBuffer()
  }

  try {
    return encode("webp", await compress("webp"))
  } catch (err) {
    log.debug(`WebP 压缩失败，尝试 JPEG: ${err.message}`)
  }

  try {
    return encode("jpeg", await compress("jpeg"))
  } catch (err) {
    log.debug(`JPEG 压缩失败，使用原图: ${err.message}`)
  }

  return encode(origFmt, buffer)
}

// OpenAI 消息构建

/** 将内部消息格式转为 OpenAI API 格式，user 消息中的图片转为多模态 content 数组 */
async function buildOpenAIMessages(messages) {
  const maxImg = MAX_VISION_IMAGES
  const stripReasoning = cfg.aigc?.strip_reasoning
  const result = []
  const deferredToolImages = [] // 工具图片统一延后收集，避免插入在 tool 消息之间导致顺序违规

  // 定位末尾连续 tool 块：只有当前轮次的 tool 图片需要延后，历史中的已被 LLM 消费过
  let trailStart = messages.length
  while (trailStart > 0 && messages[trailStart - 1].role === "tool") {
    trailStart--
  }

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]
    const apiMsg = { role: msg.role }
    if (msg.tool_calls) apiMsg.tool_calls = msg.tool_calls
    if (msg.tool_call_id) apiMsg.tool_call_id = msg.tool_call_id
    if (!stripReasoning) {
      if (msg.reasoning_content) {
        apiMsg.reasoning_content = msg.reasoning_content
      } else if (msg.reasoning_parts) {
        apiMsg.reasoning_content = msg.reasoning_parts.map(p => p.text).join("")
      }
    }

    let text = msg.content || ""
    if (msg.time && msg.role === "user") {
      const ctx = msg.chat_type ? (msg.chat_type === "群聊" && msg.group_name ? ` ${msg.chat_type} ${msg.group_name}` : ` ${msg.chat_type}`) : ""
      text = `[${formatMsgTime(msg.time)}${ctx}] ${text}`
    }

    if (msg.role === "tool" && msg.images?.length && idx >= trailStart) {
      // OpenAI tool 消息不支持 images → 先推 tool(text)，图片统一延后到末尾
      apiMsg.content = text
      result.push(apiMsg)
      const limit = Math.min(msg.images.length, maxImg)
      for (let i = 0; i < limit; i++) {
        try {
          const img = msg.images[i]
          if (img === "[图像异常]") {
            deferredToolImages.push({ type: "text", text: "[图像异常]" })
            continue
          }
          const url = img.startsWith("data:") ? img : await imageToDataUri(img)
          deferredToolImages.push({ type: "image_url", image_url: { url } })
        } catch (err) {
          log.debug(`图片处理失败: ${err.message}`)
          deferredToolImages.push({ type: "text", text: "[图像异常]" })
        }
      }
      continue
    }
    if (msg.role === "user" && msg.images?.length) {
      const parts = [{ type: "text", text }]
      const limit = Math.min(msg.images.length, maxImg)
      for (let i = 0; i < limit; i++) {
        try {
          const img = msg.images[i]
          if (img === "[图像异常]") {
            parts.push({ type: "text", text: "[图像异常]" })
            continue
          }
          const url = img.startsWith("data:") ? img : await imageToDataUri(img)
          parts.push({ type: "image_url", image_url: { url } })
        } catch (err) {
          log.debug(`图片处理失败: ${err.message}`)
          parts.push({ type: "text", text: "[图像异常]" })
        }
      }
      apiMsg.content = parts
    } else if (msg.role === "assistant" && msg.tool_calls && !msg.content) {
      apiMsg.content = null
    } else {
      apiMsg.content = text
    }

    result.push(apiMsg)
  }
  // 所有 tool 消息已按序写入 → 统一追加图片 user 消息，避免 400 Bad Request
  if (deferredToolImages.length) {
    const limit = Math.min(deferredToolImages.length, maxImg)
    const parts = [{ type: "text", text: "[工具获取的图片]" }, ...deferredToolImages.slice(0, limit)]
    result.push({ role: "user", content: parts })
  }
  return result
}

// API Key 管理

function _collectKeys(config, options) {
  const raw = options.api_key || config.api_key || ""
  return raw
    .split(",")
    .map(k => k.trim())
    .filter(Boolean)
}

let _keyIdx = 0

/** 轮询取 Key：每次请求从不同 Key 开始，失败顺延下一个，最多 3 次 */
function _rotateKeys(keys) {
  const max = Math.min(keys.length, 3)
  const start = _keyIdx % keys.length
  _keyIdx++
  const result = []
  for (let i = 0; i < max; i++) result.push(keys[(start + i) % keys.length])
  return result
}

// OpenAI

async function openaiChat(messages, options = {}) {
  const config = cfg.aigc?.openai || {}
  const endpoint = options.endpoint || config.endpoint

  if (!endpoint) throw new AigcError("NO_ENDPOINT", "未配置 OpenAI endpoint")

  const keys = _collectKeys(config, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 OpenAI API Key")

  const apiMessages = await buildOpenAIMessages(messages)

  const body = {
    messages: apiMessages,
    max_tokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 2048,
    temperature: options.temperature ?? cfg.aigc?.temperature ?? 0.7,
  }

  if (config.thinking_effort) body.reasoning_effort = config.thinking_effort

  if (options.tools?.length) body.tools = options.tools
  if (options.tool_choice) body.tool_choice = options.tool_choice

  const rotated = _rotateKeys(keys)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const model = options.model || config.model || "gpt-4o-mini"
    body.model = model
    const api_key = rotated[attempt]
    const t0 = Date.now()
    try {
      const res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
        dispatcher: getLLMDispatcher(),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new AigcError(res.status, `API 错误 [${res.status}]: ${text}`)
      }

      const data = await res.json()
      const choice = data.choices?.[0]
      log.debug(`OpenAI API 调用完成 ${model} ${Date.now() - t0}ms`)

      const content = choice?.message?.content || ""
      const reasoning_content = choice?.message?.reasoning_content || undefined

      return {
        content,
        tool_calls: choice?.message?.tool_calls,
        reasoning_content,
        usage: data.usage,
      }
    } catch (err) {
      lastError = err
      if (attempt < rotated.length - 1) {
        log.warn(`OpenAI API 尝试 ${attempt + 1}/${rotated.length} 失败: ${err.message}`)
      }
    }
  }

  throw lastError
}

// Gemini

function resolveThinkingLevel(model, configuredLevel) {
  const level = configuredLevel ?? "low"
  if (/^gemma/i.test(model)) {
    return level === "high" ? "high" : "minimal"
  }
  return level
}

/** Gemini 安全设置：关闭所有内容过滤 */
const GEMINI_DEFAULT_SAFETY = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
]

async function geminiChat(messages, options = {}) {
  const config = cfg.aigc?.gemini || {}
  const endpoint = options.endpoint || config.endpoint || "https://generativelanguage.googleapis.com"

  const keys = _collectKeys(config, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Gemini API Key")

  const model = options.model || config.model || "gemini-3.5-flash"
  const { contents, systemInstruction, tools } = await convertToGemini(messages, options.tools)

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 2048,
      temperature: options.temperature ?? cfg.aigc?.temperature ?? 0.7,
      thinkingConfig: {
        thinkingLevel: resolveThinkingLevel(model, config.thinking_level),
        includeThoughts: true,
      },
    },
    safetySettings: GEMINI_DEFAULT_SAFETY,
  }

  if (options.tool_choice === "none") {
    body.toolConfig = { functionCallingConfig: { mode: "NONE" } }
  }

  if (systemInstruction) body.systemInstruction = systemInstruction
  if (tools?.length) body.tools = tools

  const rotated = _rotateKeys(keys)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const api_key = rotated[attempt]
    const t0 = Date.now()
    try {
      const res = await fetch(`${endpoint}/v1beta/models/${model}:generateContent?key=${api_key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
        dispatcher: getLLMDispatcher(),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new AigcError(res.status, `API 错误 [${res.status}]: ${text}`)
      }

      const data = await res.json()
      const candidate = data.candidates?.[0]
      log.debug(`Gemini API 调用完成 ${model} ${Date.now() - t0}ms`)

      if (!candidate?.content) {
        if (candidate?.finishReason) {
          log.warn(`Gemini 内容安全拦截: ${candidate.finishReason}`)
        }
        return {
          content: "",
          tool_calls: undefined,
          usage: null,
          blocked: true,
          finishReason: candidate?.finishReason,
        }
      }

      const parts = candidate.content.parts || []
      const rawTextParts = parts.filter(p => p.text && !p.thought)
      const thoughtParts = parts.filter(p => p.text && p.thought)
      const fcParts = parts.filter(p => p.functionCall)

      // 保留文本 Part 的签名与位置上下文，避免 Gemini 3 思维链泄漏/复读思考
      const content_parts = rawTextParts.map(p => ({
        text: p.text,
        ...(p.thoughtSignature || p.thought_signature ? { signature: p.thoughtSignature || p.thought_signature } : {}),
      }))

      let content = rawTextParts.map(p => p.text).join("") || ""
      const reasoning_parts = thoughtParts.length
        ? thoughtParts.map(p => ({
            text: p.text,
            signature: p.thoughtSignature || p.thought_signature || null,
          }))
        : undefined
      let reasoning_content = undefined
      if (reasoning_parts) {
        reasoning_content = reasoning_parts.map(p => p.text).join("")
        if (!reasoning_content) reasoning_content = undefined
      }

      return {
        content,
        tool_calls: fcParts.length
          ? fcParts.map((fc, i) => {
              const ts = fc.thoughtSignature || fc.thought_signature
              return {
                id: fc.functionCall.id || `call_${Date.now()}_${i}`,
                type: "function",
                function: {
                  name: fc.functionCall.name,
                  arguments: JSON.stringify(fc.functionCall.args || {}),
                },
                ...(ts && { thought_signature: ts }),
              }
            })
          : undefined,
        reasoning_content,
        reasoning_parts,
        content_parts: content_parts.length ? content_parts : undefined,
        usage: data.usageMetadata
          ? {
              prompt_tokens: data.usageMetadata.promptTokenCount,
              completion_tokens: data.usageMetadata.candidatesTokenCount,
              total_tokens: data.usageMetadata.totalTokenCount,
            }
          : null,
      }
    } catch (err) {
      lastError = err
      if (attempt < rotated.length - 1) {
        log.warn(`Gemini API 尝试 ${attempt + 1}/${rotated.length} 失败: ${err.message}`)
      }
    }
  }

  throw lastError
}

/** OpenAI 消息格式 → Gemini 原生格式 */
function pushContent(contents, role, parts) {
  const last = contents[contents.length - 1]
  if (last?.role === role) {
    last.parts.push(...parts)
  } else {
    contents.push({ role, parts })
  }
}

async function convertToGemini(messages, openaiTools) {
  const contents = []
  let systemInstruction = null
  let pendingTC = null
  const maxImg = MAX_VISION_IMAGES

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] }
      continue
    }

    if (msg.role === "user") {
      const parts = []
      if (msg.content) {
        let ctx = ""
        if (msg.time && msg.chat_type) {
          ctx = msg.chat_type === "群聊" && msg.group_name ? ` ${msg.chat_type} ${msg.group_name}` : ` ${msg.chat_type}`
        }
        const text = msg.time ? `[${formatMsgTime(msg.time)}${ctx}] ${msg.content}` : String(msg.content)
        parts.push({ text })
      }

      if (msg.images?.length) {
        const limit = Math.min(msg.images.length, maxImg)
        for (let i = 0; i < limit; i++) {
          try {
            const img = msg.images[i]
            if (img === "[图像异常]") {
              parts.push({ text: "[图像异常]" })
              continue
            }
            const uri = img.startsWith("data:") ? img : await imageToDataUri(img)
            const [head, b64] = uri.split(";base64,")
            const mimeType = head.slice(5)
            parts.push({ inlineData: { mimeType, data: b64 } })
          } catch (err) {
            log.debug(`图片处理失败: ${err.message}`)
            parts.push({ text: "[图像异常]" })
          }
        }
      }

      pushContent(contents, "user", parts.length ? parts : [{ text: "" }])
      pendingTC = null
      continue
    }

    if (msg.role === "assistant") {
      const parts = []
      if (msg.reasoning_parts?.length) {
        for (const rp of msg.reasoning_parts) {
          const tp = { text: rp.text, thought: true }
          if (rp.signature) {
            tp.thoughtSignature = rp.signature
            tp.thought_signature = rp.signature
          }
          parts.push(tp)
        }
      } else if (msg.reasoning_content) {
        parts.push({ text: msg.reasoning_content, thought: true })
      }
      // 优先使用 content_parts 还原带签名的原始 Part 序列，保留位置上下文
      if (msg.content_parts?.length) {
        for (const cp of msg.content_parts) {
          const pt = { text: cp.text }
          if (cp.signature) {
            pt.thoughtSignature = cp.signature
            pt.thought_signature = cp.signature
          }
          parts.push(pt)
        }
      } else if (msg.content) {
        parts.push({ text: msg.content })
      }
      if (msg.tool_calls) {
        pendingTC = msg.tool_calls
        for (const tc of msg.tool_calls) {
          let args = {}
          try {
            args = JSON.parse(tc.function.arguments)
          } catch {
            /* pass */
          }
          const fcPart = { functionCall: { name: tc.function.name, args } }

          if (tc.id) fcPart.functionCall.id = tc.id

          if (tc.thought_signature) {
            fcPart.thoughtSignature = tc.thought_signature
            fcPart.thought_signature = tc.thought_signature
          }

          parts.push(fcPart)
        }
      } else {
        pendingTC = null
      }
      pushContent(contents, "model", parts.length ? parts : [{ text: "" }])
      continue
    }

    if (msg.role === "tool") {
      let fnName = "unknown"
      if (pendingTC && msg.tool_call_id) {
        const match = pendingTC.find(tc => tc.id === msg.tool_call_id)
        if (match) {
          fnName = match.function.name
        }
      }

      const functionResponse = {
        name: fnName,
        response: { content: msg.content },
      }
      if (msg.tool_call_id) functionResponse.id = msg.tool_call_id

      const parts = [{ functionResponse }]

      if (msg.images?.length) {
        const limit = Math.min(msg.images.length, maxImg)
        for (let i = 0; i < limit; i++) {
          try {
            const img = msg.images[i]
            if (img === "[图像异常]") {
              parts.push({ text: "[图像异常]" })
              continue
            }
            const uri = img.startsWith("data:") ? img : await imageToDataUri(img)
            const [head, b64] = uri.split(";base64,")
            const mimeType = head.slice(5)
            parts.push({ inlineData: { mimeType, data: b64 } })
          } catch (err) {
            log.debug(`图片处理失败: ${err.message}`)
            parts.push({ text: "[图像异常]" })
          }
        }
      }

      pushContent(contents, "user", parts)
      continue
    }
  }

  let tools = null
  if (openaiTools?.length) {
    tools = [
      {
        functionDeclarations: openaiTools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ]
  }

  return { contents, systemInstruction, tools }
}

// 统一入口

class AigcProvider {
  /** 将图片 URL 数组预转为 data URI，失败的返回 "[图像异常]" 占位 */
  async resolveImages(urls) {
    if (!urls?.length) return null
    const resolved = await Promise.all(
      urls.map(async u => {
        if (u.startsWith("data:")) return u
        if (u === "[图像异常]") return u
        try {
          return await imageToDataUri(u)
        } catch (err) {
          log.debug(`图片处理失败: ${err.message}`)
          return "[图像异常]"
        }
      }),
    )
    return resolved
  }

  async chat(messages, options = {}) {
    const provider = options.provider || cfg.aigc?.provider || "openai"

    if (provider === "openai") return openaiChat(messages, options)
    if (provider === "gemini") return geminiChat(messages, options)

    throw new AigcError("UNKNOWN_PROVIDER", `未知的 AIGC Provider: ${provider}`)
  }
}

export { AigcError, imageToDataUri }
export default new AigcProvider()
