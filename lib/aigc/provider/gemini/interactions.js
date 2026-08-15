import { formatMsgTime } from "../../helpers/time.js"
import log from "../../helpers/log.js"

const MAX_VISION_IMAGES = 4
const MAX_VIDEO_INPUTS = 4
const MAX_AUDIO_INPUTS = 4
const MAX_FILE_INPUTS = 4
const API_REVISION = "2026-05-20"

// 各类媒体 → 输入部件的编码配置
const MEDIA_KINDS = [
  { key: "images", placeholder: "[图像异常]", limit: MAX_VISION_IMAGES, encode: imageDataUriToInput },
  { key: "videos", placeholder: "[视频异常]", limit: MAX_VIDEO_INPUTS, encode: videoDataUriToInput },
  { key: "audios", placeholder: "[音频异常]", limit: MAX_AUDIO_INPUTS, encode: audioDataUriToInput },
  { key: "files", placeholder: "[文件异常]", limit: MAX_FILE_INPUTS, encode: documentDataUriToInput },
]

/** 将消息中的媒体数组追加为 Interactions 输入部件；
 *  超数量上限截断，异常占位符/编码失败降级为文本提示 */
function appendMediaParts(content, msg) {
  for (const { key, placeholder, limit, encode } of MEDIA_KINDS) {
    const list = msg[key]
    if (!list?.length) continue
    const count = Math.min(list.length, limit)
    for (let i = 0; i < count; i++) {
      const item = list[i]
      if (item === placeholder) {
        content.push({ type: "text", text: placeholder })
        continue
      }
      try {
        content.push(encode(item))
      } catch (err) {
        log.debug(`${key}处理失败: ${err.message}`)
        content.push({ type: "text", text: placeholder })
      }
    }
  }
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

      appendMediaParts(content, msg)

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

      appendMediaParts(content, msg)

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

export { API_REVISION, isGeminiModel, convertToInteractions, parseInteractionSteps }
