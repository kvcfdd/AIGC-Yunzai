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
const API_REVISION = "2026-05-20"

/** 下载图片 → sharp 压缩 → 返回 data URI
 *  @param {import("undici").Dispatcher} [dispatcher] - 可选的 undici Dispatcher，用于走代理 */
async function imageToDataUri(url, headers = {}, dispatcher) {
  const res = await fetch(url, { headers, ...(dispatcher ? { dispatcher } : {}) })
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
 *  @param {boolean} removeAudio - 是否移除音轨（部分模型不支持音频输入）
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
function _rotateKeys(keys, retryOverride) {
  const retry = Math.min(Math.max(retryOverride ?? cfg.aigc?.retry_count ?? 0, 0), 10)
  const max = Math.min(keys.length, retry + 1)
  const start = _keyIdx % keys.length
  _keyIdx++
  const result = []
  for (let i = 0; i < max; i++) result.push(keys[(start + i) % keys.length])
  return result
}

/** Gemini 模型通过 generation_config 传思考参数；Gemma 通过 <|think|> token 激活，无需 API 参数 */
function isGeminiModel(model) {
  return /^gemini/i.test(model)
}

/** 将图片 data URI 转为 Interactions API 输入格式 */
function imageDataUriToInput(uri) {
  const [head, b64] = uri.split(";base64,")
  const mimeType = head.slice(5) // "data:image/webp" → "image/webp"
  return { type: "image", data: b64, mime_type: mimeType }
}

/** 将视频 data URI 转为 Interactions API 输入格式 */
function videoDataUriToInput(uri) {
  const [head, b64] = uri.split(";base64,")
  const mimeType = head.slice(5)
  return { type: "video", data: b64, mime_type: mimeType }
}

/** 内部消息格式 → Interactions API 格式
 *  @returns {{ input: Array, system_instruction: string|null, tools: Array|null }} */
function convertToInteractions(messages, toolDefs) {
  const input = []
  let systemInstruction = null
  const tcMap = new Map() // tool_call_id → function name

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content
      continue
    }

    if (msg.role === "user") {
      const content = []
      if (msg.content) {
        let ctx = ""
        if (msg.time && msg.chat_type) {
          ctx = msg.chat_type === "群聊" && msg.group_name ? ` ${msg.chat_type} ${msg.group_name}` : ` ${msg.chat_type}`
        }
        const text = msg.time ? `[${formatMsgTime(msg.time)}${ctx}] ${msg.content}` : String(msg.content)
        content.push({ type: "text", text })
      }

      if (msg.images?.length) {
        const limit = Math.min(msg.images.length, MAX_VISION_IMAGES)
        for (let i = 0; i < limit; i++) {
          const img = msg.images[i]
          if (img === "[图像异常]") {
            content.push({ type: "text", text: "[图像异常]" })
            continue
          }
          try {
            content.push(imageDataUriToInput(img))
          } catch (err) {
            log.debug(`图片处理失败: ${err.message}`)
            content.push({ type: "text", text: "[图像异常]" })
          }
        }
      }

      if (msg.videos?.length) {
        for (const vid of msg.videos) {
          if (vid === "[视频异常]") {
            content.push({ type: "text", text: "[视频异常]" })
            continue
          }
          try {
            content.push(videoDataUriToInput(vid))
          } catch (err) {
            log.debug(`视频处理失败: ${err.message}`)
            content.push({ type: "text", text: "[视频异常]" })
          }
        }
      }

      input.push({
        type: "user_input",
        content: content.length ? content : [{ type: "text", text: "" }],
      })
      continue
    }

    if (msg.role === "assistant") {
      // 无状态模式：回传带签名的思考步骤，避免签名缺失错误
      if (msg.reasoning_parts?.length) {
        for (const rp of msg.reasoning_parts) {
          const step = {
            type: "thought",
          }
          if (rp.text) {
            step.summary = [{ type: "text", text: rp.text }]
          }
          if (rp.signature) {
            step.signature = rp.signature
          }
          input.push(step)
        }
      }

      // 文本内容作为一个 model_output 回合
      if (msg.content) {
        input.push({
          type: "model_output",
          content: [{ type: "text", text: msg.content }],
        })
      }

      // 工具调用作为独立的 function_call 回合
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args = {}
          try {
            args = JSON.parse(tc.function.arguments)
          } catch {
            /* pass */
          }
          tcMap.set(tc.id, tc.function.name)
          const fcStep = {
            type: "function_call",
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          }
          if (tc.signature) {
            fcStep.signature = tc.signature
          }
          input.push(fcStep)
        }
      }

      // 如果既无 content 也无 tool_calls，至少推一个空回合
      if (!msg.content && !msg.tool_calls) {
        input.push({
          type: "model_output",
          content: [{ type: "text", text: "" }],
        })
      }
      continue
    }

    if (msg.role === "tool") {
      const content = []
      if (msg.content) {
        content.push({ type: "text", text: msg.content })
      }

      if (msg.images?.length) {
        const limit = Math.min(msg.images.length, MAX_VISION_IMAGES)
        for (let i = 0; i < limit; i++) {
          const img = msg.images[i]
          if (img === "[图像异常]") {
            content.push({ type: "text", text: "[图像异常]" })
            continue
          }
          try {
            content.push(imageDataUriToInput(img))
          } catch (err) {
            log.debug(`图片处理失败: ${err.message}`)
            content.push({ type: "text", text: "[图像异常]" })
          }
        }
      }

      if (msg.videos?.length) {
        for (const vid of msg.videos) {
          if (vid === "[视频异常]") {
            content.push({ type: "text", text: "[视频异常]" })
            continue
          }
          try {
            content.push(videoDataUriToInput(vid))
          } catch (err) {
            log.debug(`视频处理失败: ${err.message}`)
            content.push({ type: "text", text: "[视频异常]" })
          }
        }
      }

      const frStep = {
        type: "function_result",
        call_id: msg.tool_call_id,
        name: msg.name || tcMap.get(msg.tool_call_id) || "unknown",
        result: content.length ? content : [{ type: "text", text: "" }],
      }
      if (msg.signature) {
        frStep.signature = msg.signature
      }
      input.push(frStep)
      continue
    }
  }

  let tools = null
  if (toolDefs?.length) {
    tools = toolDefs.map(t => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }))
  }

  return { input, system_instruction: systemInstruction, tools }
}

/** 解析 Interactions API steps[] → 统一返回格式 */
function parseInteractionSteps(steps, usage) {
  let content = ""
  const tool_calls = []
  const reasoningParts = []

  for (const step of steps) {
    if (step.type === "thought") {
      const thoughtContent = step.summary || step.content || []
      const thoughtText = thoughtContent
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("")
      reasoningParts.push({ text: thoughtText || "", signature: step.signature || null })
    }

    if (step.type === "model_output") {
      if (step.content) {
        for (const c of step.content) {
          if (c.type === "text" && c.text) {
            content += c.text
          }
        }
      }
    }

    if (step.type === "function_call") {
      tool_calls.push({
        id: step.id || `call_${Date.now()}`,
        type: "function",
        function: {
          name: step.name,
          arguments: JSON.stringify(step.arguments || {}),
        },
        signature: step.signature || null,
      })
    }
  }

  const reasoning_content = reasoningParts.length ? reasoningParts.map(p => p.text).join("") : undefined

  return {
    content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    reasoning_content,
    reasoning_parts: reasoningParts.length ? reasoningParts : undefined,
    usage: usage
      ? {
          prompt_tokens: usage.total_input_tokens,
          completion_tokens: usage.total_output_tokens,
          total_tokens: usage.total_tokens,
        }
      : null,
  }
}

async function geminiChat(messages, options = {}) {
  const config = cfg.aigc?.gemini || {}
  const endpoint = options.endpoint || config.endpoint || "https://generativelanguage.googleapis.com"
  const stateful = options.stateful ?? config.stateful ?? true

  const keys = _collectKeys(config, options)
  if (!keys.length) throw new AigcError("NO_API_KEY", "未配置 Gemini API Key")

  const model = options.model || config.model || "gemini-3.5-flash"
  const { input, system_instruction, tools } = convertToInteractions(messages, options.tools)

  const body = {
    model,
    input,
    generation_config: {
      max_output_tokens: options.max_tokens ?? cfg.aigc?.max_tokens ?? 4089,
      temperature: options.temperature ?? cfg.aigc?.temperature ?? 1.0,
    },
  }

  // 仅 Gemini 系列通过 API 参数开启思考；Gemma 系列通过 <|think|> token 激活
  if (isGeminiModel(model)) {
    body.generation_config.thinking_level = options.thinking_level ?? config.thinking_level ?? "low"
    // body.generation_config.thinking_summaries = "auto"
    body.generation_config.thinking_summaries = "none"
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

  // 有状态：同 key 重试；无状态：不同 key 轮询
  const retryCnt = stateful ? Math.min(Math.max(options.retry_count ?? cfg.aigc?.retry_count ?? 0, 0), 10) : undefined
  const rotated = stateful ? Array(retryCnt + 1).fill(keys[0]) : _rotateKeys(keys, options.retry_count)
  let lastError

  for (let attempt = 0; attempt < rotated.length; attempt++) {
    const api_key = rotated[attempt]
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
        // 有状态模式下 interaction_id 过期 → 抛出特定错误码，由 _replyLoop 捕获后带完整历史重试
        if ((res.status === 400 || res.status === 404) && stateful && body.previous_interaction_id) {
          throw new AigcError("SESSION_EXPIRED", `Session expired or invalid [${res.status}]`)
        }
        throw new AigcError(res.status, `API 错误 [${res.status}]: ${text}`)
      }

      const data = await res.json()
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

      // 检查是否有 function_call
      if (data.status === "requires_action" && !result.tool_calls?.length) {
        for (const step of steps) {
          if (step.type === "function_call") {
            result.tool_calls = result.tool_calls || []
            result.tool_calls.push({
              id: step.id || `call_${Date.now()}`,
              type: "function",
              function: {
                name: step.name,
                arguments: JSON.stringify(step.arguments || {}),
              },
              signature: step.signature || null,
            })
          }
        }
      }

      // 有状态模式：返回新的 interaction_id 供下次使用
      if (stateful && data.id) {
        result.interaction_id = data.id
      }

      return result
    } catch (err) {
      if (err?.name === "AbortError" || err?.code === "SESSION_EXPIRED") throw err
      lastError = err
      if (attempt < rotated.length - 1) {
        log.warn(`Interactions API 尝试 ${attempt + 1}/${rotated.length - 1} 失败: ${err.message}，3秒后重试...`)
        await Bot.sleep(3000)
      }
    }
  }

  throw lastError
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
