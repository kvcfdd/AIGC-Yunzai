import { flacDataUriToMp3 } from "./audio-convert.js"

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

/** 能力过滤后做目标格式转换（OpenAI 需要 FLAC→MP3） */
export async function prepareMessagesForApi(messages, caps, { signal, convertFlac = flacDataUriToMp3 } = {}) {
  const out = applyMediaCapabilities(messages, caps)
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
