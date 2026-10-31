import { createHash } from "node:crypto"
import { flacDataUriToMp3 } from "./audio-convert.js"
import { getAigc } from "../config.js"
import log from "../helpers/log.js"
import { resolveModelConfig } from "./model-config.js"

/** 各接口默认多模态能力。模型配置里的 media 可逐项覆盖。 */
const DEFAULT_MEDIA = {
  gemini: { image: true, audio: true, video: true, file: true },
  openai: { image: true, audio: true, video: false, file: true },
  anthropic: { image: true, audio: false, video: false, file: true },
  responses: { image: true, audio: false, video: false, file: true },
}

export function mediaCapabilities(modelConfig = {}, api = modelConfig.api || "gemini") {
  return { ...(DEFAULT_MEDIA[api] || DEFAULT_MEDIA.gemini), ...(modelConfig.media || {}) }
}

const KINDS = [
  ["images", "image", "图片", "image_paths"],
  ["audios", "audio", "音频", "audio_paths"],
  ["videos", "video", "视频", "video_paths"],
  ["files", "file", "文件", "file_paths"],
]

/** 关闭的能力从消息里移除，并追加文本占位；返回新消息数组，不改原历史 */
export function applyMediaCapabilities(messages, caps = {}) {
  return (messages || []).map(msg => {
    if (!msg) return msg
    const out = { ...msg }
    const notes = []
    for (const [key, flag, label, pathsKey] of KINDS) {
      if (caps[flag] === false && out[key]?.length) {
        notes.push(`[${label}]`)
        delete out[key]
        delete out[pathsKey]
      }
    }
    if (notes.length) out.content = `${out.content || ""}${out.content ? "\n" : ""}${notes.join("")}`
    return out
  })
}

/** 识别结果缓存：同一媒体在同一识别模型下只调用一次 */
const RECOGNITION_CACHE_MAX = 200
const recognitionCache = new Map()

const RECOGNITION_PROMPTS = {
  image: "请识别图片内容，输出客观、完整的纯文本描述，供文本模型理解。",
  audio: "请转写或概述音频内容，输出纯文本。",
  video: "请描述视频内容，输出纯文本。",
  file: "请提取并总结文件内容，输出纯文本。",
}

function recognitionKey(mmConfig, kind, media) {
  const hash = createHash("sha256")
  hash.update(`${mmConfig.name || ""}\0${mmConfig.api || ""}\0${mmConfig.model || ""}\0${kind}\0`)
  hash.update(JSON.stringify(media))
  return hash.digest("hex")
}

/** 读取 aigc.multimodal 配置；未配置或配置无效返回 null */
function resolveMultimodalConfig() {
  const aigc = getAigc()
  const selection = aigc?.multimodal || {}
  if (!selection.model_config) return null
  try {
    return resolveModelConfig({ model_config: selection.model_config, api: selection.api }, aigc)
  } catch (err) {
    log.warn(`多模态识别模型配置无效: ${err.message}`)
    return null
  }
}

/** 调用多模态模型识别一类媒体，返回纯文本；不支持或空响应返回空串 */
async function describeMedia(mmConfig, kind, media, paths, signal) {
  const [key, flag, label, pathsKey] = kind
  const caps = mediaCapabilities(mmConfig, mmConfig.api)
  if (caps[flag] === false) {
    log.warn(`多模态识别模型 ${mmConfig.name || mmConfig.model || ""} 未开启${label}能力，保留文本占位`)
    return ""
  }

  const cacheKey = recognitionKey(mmConfig, flag, media)
  if (recognitionCache.has(cacheKey)) return recognitionCache.get(cacheKey)

  const message = { role: "user", content: RECOGNITION_PROMPTS[flag] }
  message[key] = media
  if (paths?.length) message[pathsKey] = paths

  const { getProvider } = await import("./index.js")
  const res = await getProvider(mmConfig.api).chat([message], { modelConfig: mmConfig, channel: "multimodal", signal, skipMediaFallback: true })
  const text = String(res?.content || "").trim()
  if (!text) return ""

  if (recognitionCache.size >= RECOGNITION_CACHE_MAX) recognitionCache.delete(recognitionCache.keys().next().value)
  recognitionCache.set(cacheKey, text)
  return text
}

/**
 * 多模态能力预处理：开启的能力保持原样；关闭的能力在配置了 aigc.multimodal 时
 * 交由识别模型转为文本，否则保留 [图片] 等文本占位。返回新消息数组，不改原历史。
 */
export async function prepareMediaMessages(messages, caps = {}, { signal, skipFallback = false, recognize } = {}) {
  const mmConfig = skipFallback ? null : resolveMultimodalConfig()
  const recognizer = skipFallback ? null : recognize || (mmConfig ? (kind, media, paths) => describeMedia(mmConfig, kind, media, paths, signal) : null)

  const out = []
  for (const msg of messages || []) {
    if (!msg) {
      out.push(msg)
      continue
    }
    const copy = { ...msg }
    const notes = []
    for (const kind of KINDS) {
      const [key, flag, label, pathsKey] = kind
      if (caps[flag] !== false || !copy[key]?.length) continue

      const media = copy[key]
      const paths = copy[pathsKey]
      delete copy[key]
      delete copy[pathsKey]

      let description = ""
      if (recognizer) {
        try {
          description = String((await recognizer(kind, media, paths)) || "").trim()
        } catch (err) {
          if (err?.name === "AbortError") throw err
          log.warn(`多模态识别失败（${label}）: ${err.message}`)
        }
      }
      notes.push(description ? `[${label}识别]\n${description}` : `[${label}]`)
    }
    if (notes.length) copy.content = `${copy.content || ""}${copy.content ? "\n" : ""}${notes.join("\n\n")}`
    out.push(copy)
  }
  return out
}

/** 能力过滤 + 多模态识别 + 目标格式转换（OpenAI 需要 FLAC→MP3） */
export async function prepareMessagesForApi(messages, caps, { signal, convertFlac = flacDataUriToMp3, skipFallback = false } = {}) {
  const out = await prepareMediaMessages(messages, caps, { signal, skipFallback })
  for (const msg of out) {
    if (!msg?.audios?.length) continue
    const audios = []
    for (const item of msg.audios) {
      if (Array.isArray(item)) {
        const arr = []
        for (const one of item) arr.push(await convertFlac(one, signal))
        audios.push(arr)
      } else {
        audios.push(await convertFlac(item, signal))
      }
    }
    msg.audios = audios
  }
  return out
}
