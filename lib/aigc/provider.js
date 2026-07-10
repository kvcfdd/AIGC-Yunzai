import { exec } from "node:child_process"
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
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
const MAX_VIDEO_BYTES = 15 * 1024 * 1024 // 最终输出上限 15MB
const MAX_VIDEO_DOWNLOAD = 50 * 1024 * 1024 // 下载上限 50MB
const MAX_VIDEO_PX = 720 // 压缩目标高度

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

/** 下载视频 → 大小校验 → ffmpeg 压缩（如可用）→ data URI
 *  @param {boolean} removeAudio - Gemma 系列去音轨，Gemini 系列保留音轨
 *  @param {AbortSignal} [signal] - 中断信号 */
async function videoToDataUri(url, removeAudio = false, signal) {
  const tmpDir = path.resolve("data/aigc/tmp")
  await mkdir(tmpDir, { recursive: true })

  // 下载
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`下载失败 [${res.status}]`)
  const cl = res.headers.get("content-length")
  if (cl && parseInt(cl, 10) > MAX_VIDEO_DOWNLOAD) {
    throw new Error(`视频过大 [${(parseInt(cl, 10) / 1024 / 1024).toFixed(1)}MB]`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_VIDEO_DOWNLOAD) {
    throw new Error(`视频过大 [${(buf.length / 1024 / 1024).toFixed(1)}MB]`)
  }

  // 推断 mime
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim()
  const isVideo = contentType.startsWith("video/")
  const ext = isVideo ? contentType.split("/")[1] : "mp4"
  const mime = isVideo ? contentType : "video/mp4"

  // 写临时文件
  const inFile = path.join(tmpDir, `aigc_video_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`)
  const outFile = path.join(tmpDir, `aigc_video_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`)
  await writeFile(inFile, buf)

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

  let finalBuf = buf
  let finalMime = mime
  const audioFlag = removeAudio ? " -an" : ""
  let onAbort
  try {
    // 用 ffmpeg 压缩视频
    await new Promise((resolve, reject) => {
      const ff = exec(`ffmpeg -i "${inFile}" -vf "scale='min(1280,iw)':'min(${MAX_VIDEO_PX},ih)':force_original_aspect_ratio=decrease"${audioFlag} -c:v libx264 -crf 28 -preset fast -movflags +faststart -y "${outFile}"`, { timeout: 60000 }, err => (err ? reject(err) : resolve()))
      ff.stderr?.on("data", () => {})
      if (signal) {
        onAbort = () => {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
      }
    })
    const compressed = await readFile(outFile)
    if (compressed.length <= MAX_VIDEO_BYTES && compressed.length > 0) {
      finalBuf = compressed
      finalMime = "video/mp4"
      log.debug(`视频处理: ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${(compressed.length / 1024 / 1024).toFixed(1)}MB`)
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err
    // ffmpeg 不可用，保留原始文件
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }

  // 清理
  await unlink(inFile).catch(() => {})
  await unlink(outFile).catch(() => {})

  if (finalBuf.length > MAX_VIDEO_BYTES) {
    throw new Error(`压缩后仍超 ${MAX_VIDEO_BYTES / 1024 / 1024}MB [${(finalBuf.length / 1024 / 1024).toFixed(1)}MB]`)
  }

  return `data:${finalMime};base64,${finalBuf.toString("base64")}`
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

/** 轮询取 Key：每次请求从不同 Key 开始，失败顺延下一个 */
function _rotateKeys(keys) {
  const retry = Math.min(Math.max(cfg.aigc?.retry_count ?? 0, 0), 10)
  const max = Math.min(keys.length, retry + 1)
  const start = _keyIdx % keys.length
  _keyIdx++
  const result = []
  for (let i = 0; i < max; i++) result.push(keys[(start + i) % keys.length])
  return result
}

// Gemini
function resolveThinkingLevel(model, configuredLevel) {
  const level = (configuredLevel ?? "low").toUpperCase()
  if (/^gemma/i.test(model)) {
    return level === "HIGH" ? "HIGH" : "MINIMAL"
  }
  return level
}

/** Gemini 安全设置：关闭所有内容过滤 */
const GEMINI_DEFAULT_SAFETY = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
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
      maxOutputTokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 4089,
      temperature: options.temperature ?? cfg.aigc?.temperature ?? 1.0,
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
      if (err?.name === "AbortError") throw err
      lastError = err
      if (attempt < rotated.length - 1) {
        log.warn(`Gemini API 尝试 ${attempt + 1}/${rotated.length - 1} 失败: ${err.message}，3秒后重试...`)
        await Bot.sleep(3000)
      }
    }
  }

  throw lastError
}

/** 内部消息格式 → Gemini 原生格式 */
function pushContent(contents, role, parts) {
  const last = contents[contents.length - 1]
  if (last?.role === role) {
    last.parts.push(...parts)
  } else {
    contents.push({ role, parts })
  }
}

async function convertToGemini(messages, toolDefs) {
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

      if (msg.videos?.length) {
        for (const vid of msg.videos) {
          try {
            if (vid === "[视频异常]") {
              parts.push({ text: "[视频异常]" })
              continue
            }
            const [head, b64] = vid.split(";base64,")
            const mimeType = head.slice(5)
            parts.push({ inlineData: { mimeType, data: b64 } })
          } catch (err) {
            log.debug(`视频处理失败: ${err.message}`)
            parts.push({ text: "[视频异常]" })
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

      if (msg.videos?.length) {
        for (const vid of msg.videos) {
          try {
            if (vid === "[视频异常]") {
              parts.push({ text: "[视频异常]" })
              continue
            }
            const [head, b64] = vid.split(";base64,")
            const mimeType = head.slice(5)
            parts.push({ inlineData: { mimeType, data: b64 } })
          } catch (err) {
            log.debug(`视频处理失败: ${err.message}`)
            parts.push({ text: "[视频异常]" })
          }
        }
      }

      pushContent(contents, "user", parts)
      continue
    }
  }

  let tools = null
  if (toolDefs?.length) {
    tools = [
      {
        functionDeclarations: toolDefs.map(t => ({
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

  /** 下载视频 → 大小校验 → ffmpeg 压缩 → data URI */
  async resolveVideo(urls, removeAudio = false, signal) {
    if (!urls?.length) return null
    const resolved = []
    for (const url of urls) {
      try {
        const uri = await videoToDataUri(url, removeAudio, signal)
        resolved.push(uri)
      } catch (err) {
        log.debug(`视频处理失败: ${err.message}`)
        resolved.push("[视频异常]")
      }
    }
    return resolved.length ? resolved : null
  }

  async chat(messages, options = {}) {
    return geminiChat(messages, options)
  }
}

export { AigcError, imageToDataUri, videoToDataUri }
export default new AigcProvider()
