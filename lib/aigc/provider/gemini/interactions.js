import { formatMsgTime } from "../../helpers/time.js"
import log from "../../helpers/log.js"

const MAX_VISION_IMAGES = 20 // 单条消息的源图数上限
const MAX_IMAGE_PARTS = 60 // 单条消息发出的图片部件总数上限
const MAX_VIDEO_INPUTS = 2
const MAX_AUDIO_INPUTS = 5
const MAX_FILE_INPUTS = 10
const API_REVISION = "2026-05-20"

// 各类媒体 → 输入部件的编码配置
const MEDIA_KINDS = [
  { key: "images", placeholder: "[图像异常]", limit: MAX_VISION_IMAGES, encode: mediaDataUriToInput },
  { key: "videos", placeholder: "[视频异常]", limit: MAX_VIDEO_INPUTS, encode: videoDataUriToInput },
  { key: "audios", placeholder: "[音频异常]", limit: MAX_AUDIO_INPUTS, encode: audioDataUriToInput },
  { key: "files", placeholder: "[文件异常]", limit: MAX_FILE_INPUTS, encode: documentDataUriToInput },
]

/** data URI mime → 部件类型 */
function partTypeFromUri(uri) {
  const semi = typeof uri === "string" ? uri.indexOf(";") : -1
  if (semi > 0) {
    const mime = uri.slice(5, semi)
    if (mime.startsWith("video/")) return "video"
    if (mime.startsWith("audio/")) return "audio"
  }
  return "image"
}

/** 将图片 data URI 转为 Interactions API 输入格式；
 *  动画 GIF 视频化产生的 video/audio mime 自适应为对应部件类型 */
function mediaDataUriToInput(uri) {
  const [head, b64] = uri.split(";base64,")
  const mimeType = head.slice(5)
  return { type: partTypeFromUri(uri), data: b64, mime_type: mimeType }
}

/** 图片项归属标签: "图片 2/3 第 1/4 段" / "图片 2/3" / "图片 第 1/4 段"
 *  单图且未切段时返回空串
 *  @param {number} idx 源图序号(从 0 起) @param {number} srcCount 源图总数
 *  @param {number} seg 段序号(从 0 起) @param {number} segCount 段数 */
function mediaLabel(idx, srcCount, seg, segCount) {
  if (srcCount <= 1 && segCount <= 1) return ""
  const who = srcCount > 1 ? `图片 ${idx + 1}/${srcCount}` : "图片"
  const which = segCount > 1 ? `第 ${seg + 1}/${segCount} 段` : ""
  return `[${who}${which ? ` ${which}` : ""}]`
}

/** 将消息中的媒体数组追加为 Interactions 输入部件；
 *  超数量上限截断，异常占位符/编码失败降级为文本提示
 *  图片项为数组时表示超长图切段：逐段前置归属标签，并先发一条 header 说明
 *  「部件数 ≠ 图片数」，否则模型会把同一张图的 N 个切片当成 N 张图
 *  单图单段完全不加标注，保持与改动前一致
 *  注: agent 场景下 N 是整轮所有 user 消息图片的合计
 *  且 goal 文本里没有 [图片] 占位符 —— 此时标签是唯一的归属信息 */
function appendMediaParts(content, msg) {
  let imageParts = 0 // 已发出的图片部件数(含切段)，用于总量兜底
  let imageSkipped = false // 是否真发生过截断

  for (const { key, placeholder, limit, encode } of MEDIA_KINDS) {
    const list = msg[key]
    if (!list?.length) continue
    const count = Math.min(list.length, limit)
    // 标签分母用实际发出的源图数而非 list.length —— 超上限截断时
    // 用 list.length 会标注出根本不存在的图
    const srcCount = key === "images" ? count : 0

    // 多图或存在切段时先说明一次，避免模型把切片数误当成图片数
    if (srcCount) {
      const segTotal = list.slice(0, count).reduce((n, it) => n + (Array.isArray(it) ? it.length : 1), 0)
      const sliced = segTotal > srcCount
      if (srcCount > 1 || sliced) {
        const bits = [`共 ${srcCount} 张图片`]
        if (sliced) bits.push("超长图已纵向切成多段，相邻段之间有重叠，各段自上而下按顺序排列")
        content.push({ type: "text", text: `[${bits.join("；")}]` })
      }
    }

    for (let i = 0; i < count; i++) {
      if (key === "images" && imageParts >= MAX_IMAGE_PARTS) {
        imageSkipped = true
        break
      }
      const item = list[i]

      // 超长图切段
      if (Array.isArray(item)) {
        for (let j = 0; j < item.length; j++) {
          if (key === "images" && imageParts >= MAX_IMAGE_PARTS) {
            imageSkipped = true
            break
          }
          const label = mediaLabel(i, srcCount, j, item.length)
          if (label) content.push({ type: "text", text: label })
          try {
            content.push(encode(item[j]))
            if (key === "images") imageParts++
          } catch (err) {
            log.debug(`${key}切段处理失败: ${err.message}`)
            content.push({ type: "text", text: placeholder })
          }
        }
        continue
      }

      if (item === placeholder) {
        content.push({ type: "text", text: placeholder })
        continue
      }
      // 非 data URI 项（如 [文件格式不支持查看]）→ 直接文本占位，避免编码出坏部件
      if (typeof item !== "string" || !item.startsWith("data:")) {
        content.push({ type: "text", text: String(item) })
        continue
      }
      try {
        content.push(encode(item))
        if (key === "images") imageParts++
      } catch (err) {
        log.debug(`${key}处理失败: ${err.message}`)
        content.push({ type: "text", text: placeholder })
      }
    }

    // 真被截断时说明一次
    if (imageSkipped) {
      content.push({ type: "text", text: "[图片过多，其余已省略]" })
      log.warn(`图片部件数超上限 ${MAX_IMAGE_PARTS}，本轮剩余图片已省略`)
      imageSkipped = false
    }
  }
}

/** 拆分工具消息媒体: function_result.result 仅支持 text/image 部件，
 *  video/audio/document 部件改由独立 user_input 消息携带，
 *  返回 { resultParts, extraParts } */
function splitToolMedia(msg) {
  const resultParts = []
  const extraParts = []
  if (msg.content) resultParts.push({ type: "text", text: msg.content })
  for (const { key, placeholder, limit, encode } of MEDIA_KINDS) {
    const list = msg[key]
    if (!list?.length) continue
    const count = Math.min(list.length, limit)
    for (let i = 0; i < count; i++) {
      // 工具图与用户图走同一套编码，故 item 可能是切段后的 data URI 数组；
      // 若按标量处理会被 String() 成逗号拼接的整段 base64 文本，不报错却把 context 撑爆
      const items = Array.isArray(list[i]) ? list[i] : [list[i]]
      for (let j = 0; j < items.length; j++) {
        const one = items[j]
        let part
        if (one === placeholder) {
          part = { type: "text", text: placeholder }
        } else if (typeof one !== "string" || !one.startsWith("data:")) {
          part = { type: "text", text: String(one) }
        } else {
          try {
            part = encode(one)
          } catch (err) {
            log.debug(`${key}处理失败: ${err.message}`)
            part = { type: "text", text: placeholder }
          }
        }
        const bucket = key === "images" && partTypeFromUri(one) === "image" ? resultParts : extraParts
        // 标签与其部件同桶，避免切段后归属信息与部件分离；
        // 单图单段时 mediaLabel 返回空串，多图/多段才加标注
        const label = mediaLabel(i, count, j, items.length)
        if (label) bucket.push({ type: "text", text: label })
        bucket.push(part)
      }
    }
  }
  return { resultParts, extraParts }
}

/** 是否为 Gemini 系列模型 —— 思考参数经 generation_config 下发，非 Gemini 系列不带 */
function isGeminiModel(model) {
  return /^gemini/i.test(model)
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

  // function_result.result 只接受 text/image 部件，视频/音频/文档由 user_input 携带
  // 先累积，待这一轮工具全部返回，再合并成一条发出
  let pendingMedia = []
  const flushMedia = () => {
    if (!pendingMedia.length) return
    input.push({ type: "user_input", content: pendingMedia })
    pendingMedia = []
  }

  for (const msg of messages) {
    if (msg.role !== "tool") flushMedia()

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
      const { resultParts, extraParts } = splitToolMedia(msg)
      const callId = msg.tool_call_id || "unknown"
      const name = msg.name || tcMap.get(callId) || "unknown"
      const frStep = {
        type: "function_result",
        call_id: callId,
        name,
        result: resultParts.length ? resultParts : [{ type: "text", text: "" }],
      }
      if (msg.signature) {
        frStep.signature = msg.signature
      }
      input.push(frStep)
      if (extraParts.length) {
        // 同一工具可能被并行调用多次，标签带上 call_id 才能区分归属
        pendingMedia.push({ type: "text", text: `[工具 ${name} (call_id: ${callId}) 返回的媒体]` }, ...extraParts)
      }
      continue
    }
  }
  flushMedia()

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
