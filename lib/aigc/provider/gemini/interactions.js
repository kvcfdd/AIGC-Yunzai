import { formatMsgTime } from "../../helpers/time.js"
import log from "../../helpers/log.js"

const MAX_VISION_IMAGES = 4
const MAX_AUDIO_INPUTS = 4
const MAX_FILE_INPUTS = 4
const API_REVISION = "2026-05-20"

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

/** 将音频 data URI 转为 Interactions API 输入格式 */
function audioDataUriToInput(uri) {
  const [head, b64] = uri.split(";base64,")
  const mimeType = head.slice(5)
  return { type: "audio", data: b64, mime_type: mimeType }
}

/** 将文件 data URI 转为 Interactions API 输入格式（document 部件，Gemini 原生支持） */
function documentDataUriToInput(uri) {
  const [head, b64] = uri.split(";base64,")
  const mimeType = head.slice(5)
  return { type: "document", data: b64, mime_type: mimeType }
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

      if (msg.audios?.length) {
        const limit = Math.min(msg.audios.length, MAX_AUDIO_INPUTS)
        for (let i = 0; i < limit; i++) {
          const aud = msg.audios[i]
          if (aud === "[音频异常]") {
            content.push({ type: "text", text: "[音频异常]" })
            continue
          }
          try {
            content.push(audioDataUriToInput(aud))
          } catch (err) {
            log.debug(`音频处理失败: ${err.message}`)
            content.push({ type: "text", text: "[音频异常]" })
          }
        }
      }

      if (msg.files?.length) {
        const limit = Math.min(msg.files.length, MAX_FILE_INPUTS)
        for (let i = 0; i < limit; i++) {
          const f = msg.files[i]
          if (f === "[文件异常]") {
            content.push({ type: "text", text: "[文件异常]" })
            continue
          }
          try {
            content.push(documentDataUriToInput(f))
          } catch (err) {
            log.debug(`文件处理失败: ${err.message}`)
            content.push({ type: "text", text: "[文件异常]" })
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

      if (msg.audios?.length) {
        const limit = Math.min(msg.audios.length, MAX_AUDIO_INPUTS)
        for (let i = 0; i < limit; i++) {
          const aud = msg.audios[i]
          if (aud === "[音频异常]") {
            content.push({ type: "text", text: "[音频异常]" })
            continue
          }
          try {
            content.push(audioDataUriToInput(aud))
          } catch (err) {
            log.debug(`音频处理失败: ${err.message}`)
            content.push({ type: "text", text: "[音频异常]" })
          }
        }
      }

      if (msg.files?.length) {
        const limit = Math.min(msg.files.length, MAX_FILE_INPUTS)
        for (let i = 0; i < limit; i++) {
          const f = msg.files[i]
          if (f === "[文件异常]") {
            content.push({ type: "text", text: "[文件异常]" })
            continue
          }
          try {
            content.push(documentDataUriToInput(f))
          } catch (err) {
            log.debug(`文件处理失败: ${err.message}`)
            content.push({ type: "text", text: "[文件异常]" })
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
      reasoningParts.push({
        text: thoughtText || "",
        signature: step.signature || null,
      })
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

export { API_REVISION, MAX_VISION_IMAGES, MAX_AUDIO_INPUTS, MAX_FILE_INPUTS, isGeminiModel, imageDataUriToInput, videoDataUriToInput, audioDataUriToInput, documentDataUriToInput, convertToInteractions, parseInteractionSteps }
