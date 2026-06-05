import fs from "node:fs"
import crypto from "node:crypto"
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

// 图片下载与缓存

const IMG_DIR = "data/aigc/img"
const IMG_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"]

/** 异步根据 URL hash 查找已缓存的图片文件，避免阻塞主进程 */
async function _imgCachePath(hash) {
  for (const ext of IMG_EXTS) {
    const p = `${IMG_DIR}/${hash}.${ext}`
    try {
      await fs.promises.access(p)
      return { path: p, mime: `image/${ext === "jpg" ? "jpeg" : ext}` }
    } catch {
      // 忽略文件不存在或不可访问的错误
    }
  }
  return null
}

/** 异步下载图片并存入本地缓存，非标准 MIME 类型统一存为 jpg */
async function downloadImage(url) {
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 12)
  const cached = await _imgCachePath(hash)
  if (cached) {
    const buf = await fs.promises.readFile(cached.path)
    return { mimeType: cached.mime, data: buf.toString("base64") }
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 [${res.status}]`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get("content-type") || "image/jpeg"
  const ext = IMG_EXTS.includes(mime.split("/")[1]) ? mime.split("/")[1] : "jpg"

  await fs.promises.mkdir(IMG_DIR, { recursive: true }).catch(() => { })
  await fs.promises.writeFile(`${IMG_DIR}/${hash}.${ext}`, buffer)

  return { mimeType: mime, data: buffer.toString("base64") }
}

// OpenAI 消息构建

/** 将内部消息格式转为 OpenAI API 格式，user 消息中的图片转为多模态 content 数组 */
async function buildOpenAIMessages(messages) {
  const maxImg = MAX_VISION_IMAGES
  const result = []
  for (const msg of messages) {
    const apiMsg = { role: msg.role }
    if (msg.tool_calls) apiMsg.tool_calls = msg.tool_calls
    if (msg.tool_call_id) apiMsg.tool_call_id = msg.tool_call_id
    if (msg.reasoning_content) {
      apiMsg.reasoning_content = msg.reasoning_content
    } else if (msg.reasoning_parts) {
      apiMsg.reasoning_content = msg.reasoning_parts.map(p => p.text).join("")
    }

    let text = msg.content || ""
    if (msg.time && msg.role === "user")
      text = `[${formatMsgTime(msg.time)}] ${text}`

    if (msg.role === "user" && msg.images?.length) {
      const parts = [{ type: "text", text }]
      const limit = Math.min(msg.images.length, maxImg)
      for (let i = 0; i < limit; i++) {
        try {
          const img = await downloadImage(msg.images[i])
          parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
        } catch (err) {
          log.debug(`图片下载失败: ${err.message}`)
        }
      }
      apiMsg.content = parts
    } else {
      apiMsg.content = text
    }

    result.push(apiMsg)
  }
  return result
}

// API Key 管理

function _collectKeys(config, options) {
  const raw = options.api_key || config.api_key || ""
  return raw.split(",").map(k => k.trim()).filter(Boolean)
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

// 模型管理

let _modelIdx = 0

/** 从逗号分隔的模型列表中轮询选取 */
function _pickModel(config, options) {
  const raw = options.model || config.model || ""
  const models = String(raw).split(",").map(m => m.trim()).filter(Boolean)
  if (models.length === 0) return null
  if (models.length === 1) return models[0]
  const idx = _modelIdx % models.length
  _modelIdx++
  return models[idx]
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

  if (config.thinking_effort)
    body.reasoning_effort = config.thinking_effort

  if (options.tools?.length) body.tools = options.tools
  if (options.tool_choice) body.tool_choice = options.tool_choice

  const rotated = _rotateKeys(keys)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const model = _pickModel(config, options) || "gpt-4o-mini"
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

  const { contents, systemInstruction, tools } = await convertToGemini(messages, options.tools)

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 2048,
      temperature: options.temperature ?? cfg.aigc?.temperature ?? 0.7,
      thinkingConfig: {
        thinkingLevel: config.thinking_level ?? "low",
        includeThoughts: true,
      }
    },
    safetySettings: GEMINI_DEFAULT_SAFETY,
  }

  if (systemInstruction) body.systemInstruction = systemInstruction
  if (tools?.length) body.tools = tools

  const rotated = _rotateKeys(keys)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const model = _pickModel(config, options) || "gemini-3.5-flash"
    const api_key = rotated[attempt]
    const t0 = Date.now()
    try {
      const res = await fetch(
        `${endpoint}/v1beta/models/${model}:generateContent?key=${api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: options.signal,
          dispatcher: getLLMDispatcher(),
        },
      )

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
        return { content: "", tool_calls: undefined, usage: null, blocked: true, finishReason: candidate?.finishReason }
      }

      const parts = candidate.content.parts || []
      const textParts = parts.filter(p => p.text && !p.thought).map(p => p.text)
      const thoughtParts = parts.filter(p => p.text && p.thought)
      const fcParts = parts.filter(p => p.functionCall)

      let content = textParts.join("") || ""
      const reasoning_parts = thoughtParts.length
        ? thoughtParts.map(p => ({ text: p.text, signature: p.thoughtSignature || p.thought_signature || null }))
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
        usage: data.usageMetadata
          ? { prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount, total_tokens: data.usageMetadata.totalTokenCount }
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
        const text = msg.time ? `[${formatMsgTime(msg.time)}] ${msg.content}` : String(msg.content)
        parts.push({ text })
      }

      if (msg.images?.length) {
        const limit = Math.min(msg.images.length, maxImg)
        for (let i = 0; i < limit; i++) {
          try {
            const img = await downloadImage(msg.images[i])
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } })
          } catch (err) {
            log.debug(`图片下载失败: ${err.message}`)
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
      if (msg.content) {
        parts.push({ text: msg.content })
      }
      if (msg.tool_calls) {
        pendingTC = msg.tool_calls
        for (const tc of msg.tool_calls) {
          let args = {}
          try { args = JSON.parse(tc.function.arguments) } catch { /* pass */ }
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

      const functionResponse = { name: fnName, response: { content: msg.content } }
      if (msg.tool_call_id) functionResponse.id = msg.tool_call_id

      pushContent(contents, "user", [{ functionResponse }])
      continue
    }
  }

  let tools = null
  if (openaiTools?.length) {
    tools = [{
      functionDeclarations: openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }]
  }

  return { contents, systemInstruction, tools }
}

// 统一入口

class AigcProvider {
  async chat(messages, options = {}) {
    const provider = options.provider || cfg.aigc?.provider || "openai"

    if (provider === "openai") return openaiChat(messages, options)
    if (provider === "gemini") return geminiChat(messages, options)

    throw new AigcError("UNKNOWN_PROVIDER", `未知的 AIGC Provider: ${provider}`)
  }
}

export { AigcError }
export default new AigcProvider()