import fs from "node:fs/promises"
import path from "node:path"
import tools from "../tool-registry.js"
import common from "../../../common/common.js"
import { mediaToFile, sniffMediaKind, imageFileToDataUris, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../../media/ingest.js"
import { textFileDataUri, textFileKind } from "../../media/text-preview.js"
import { getDownloadProxyDispatcher } from "../../llm/network-proxy.js"
import { isMaster } from "../workspace.js"
import log from "../../helpers/log.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

// 已知不支持的常见格式 → 无需下载直接拒绝
const UNSUPPORTED_EXTS = /\.(zip|rar|7z|xz|gz|bz2|tar|exe|msi|apk|dll|iso|bin|dat)$/i

// 各类型下载上限
const KIND_MAX = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_DOWNLOAD, audio: MAX_AUDIO_DOWNLOAD, file: MAX_FILE_DOWNLOAD }

const MEDIA_KEYS = ["images", "image_paths", "videos", "video_paths", "audios", "audio_paths", "files", "file_paths"]
const LOAD_TYPES = new Set(["image", "video", "audio", "file"])
const SEND_TYPES = new Set(["image", "file", "audio", "video"])
/** 单次最多处理的来源数 */
const MAX_SOURCES = 10

/** 非 bot 管理员只能使用这些目录下的本地文件 */
export const ALLOWED_MEDIA_DIRS = ["data/aigc/chat", "data/aigc/tmp", "temp"]

/** 来源统一为数组；兼容模型传单个字符串 */
function normalizeSources(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  return list.map(value => String(value).trim()).filter(Boolean)
}

/** 最终路径是否在允许目录内 */
function isUnderAllowedDir(abs) {
  for (const dir of ALLOWED_MEDIA_DIRS) {
    const rel = path.relative(path.resolve(dir), abs)
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true
  }
  return false
}

/** URL 与 data URI 不受本地路径限制 */
function isRemoteSource(source) {
  return /^(?:https?:\/\/|data:)/i.test(source)
}

/** 入口先校验本地路径，避免非管理员触发无谓的下载/复制 */
function validateLocalSources(sources, ctx) {
  if (isMaster(ctx)) return null
  for (const source of sources) {
    if (isRemoteSource(source)) continue
    if (!isUnderAllowedDir(path.resolve(source))) return `用户权限不足：非 bot owner (master) 仅允许使用 ${ALLOWED_MEDIA_DIRS.join("、")} 下的本地路径: ${source}`
  }
  return null
}

/** 所有来源统一走这里：下载/解码/复制到本地缓存，返回 { file, mime }
 *  raw=true 时只拿到本地文件路径，不做格式识别/转码 */
async function materialize(source, kind, ctx, maxBytes = KIND_MAX[kind] ?? MAX_VIDEO_DOWNLOAD, raw = false) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "max-age=0",
  }

  const isPixiv = (() => {
    try {
      return new URL(source).hostname === "i.pximg.net"
    } catch {
      return false
    }
  })()
  if (isPixiv) headers.Referer = "https://www.pixiv.net/"
  const dispatcher = isPixiv ? getDownloadProxyDispatcher() : undefined

  return mediaToFile(source, { kind, headers, dispatcher, maxBytes, signal: ctx?.signal, raw })
}

/** 按识别出的类型走对应编码管线；mime 已在 mediaToFile 内解析完成，为 null 即无法识别 */
async function encodeByKind(kind, file, mime, signal, name = "") {
  if (kind === "image") {
    const dataUris = await imageFileToDataUris(file, signal)
    return { images: [dataUris], image_paths: [file], text: "Image loaded" }
  }
  if (kind === "video") {
    const dataUri = await videoFileToDataUri(file, signal)
    return { videos: [dataUri], video_paths: [file], text: "Video loaded" }
  }
  if (kind === "audio") {
    const dataUri = await audioFileToDataUri(file, signal)
    return { audios: [dataUri], audio_paths: [file], text: "Audio loaded" }
  }
  if (!mime) return "Unsupported format"
  // 文本类先截断再内联：原样 base64 会把整份文件塞进上下文，稍大即超限
  const textUri = await textFileDataUri(file, mime, name)
  if (textUri) return { files: [textUri], file_paths: [file], text: "File loaded" }
  const dataUri = await fileToDataUri(file, mime)
  return { files: [dataUri], file_paths: [file], text: "File loaded" }
}

/** 单个来源读入上下文 */
async function loadOne(source, kind, ctx) {
  if (UNSUPPORTED_EXTS.test(source)) return "Unsupported format"

  // 显式指定类型: 快车道，按该类型限额下载并直接编码
  if (kind) {
    const { file, mime } = await materialize(source, kind, ctx)
    if (!file) return "Unsupported format"
    return await encodeByKind(kind, file, mime, ctx?.signal, sourceName(source, file))
  }

  // 自动识别: 统一按 file 方式下载/定位缓存，媒体类再按魔数分流
  // 下载上限取各类型最大值(视频 80MB)，分类型上限在嗅探后校验
  const { file, mime } = await materialize(source, "file", ctx, MAX_VIDEO_DOWNLOAD)
  if (!file) return "Unsupported format"

  const buf = await fs.readFile(file)
  let detected = sniffMediaKind(buf, mime)
  if (!detected && mime) detected = "file"
  if (!detected) return "Unsupported format"
  const name = sourceName(source, file)
  // 文本类不设硬上限：超限由 textFileDataUri 截断并标注路径，模型可自行分段续读
  if (detected === "file" && textFileKind(mime, name)) return await encodeByKind(detected, file, mime, ctx?.signal, name)

  const sizeLimit = detected === "image" ? MAX_IMAGE_BYTES : detected === "audio" ? MAX_AUDIO_DOWNLOAD : detected === "file" ? MAX_FILE_DOWNLOAD : null
  if (sizeLimit && buf.length > sizeLimit) return `File too large [${(buf.length / 1024 / 1024).toFixed(1)}MB]`

  return await encodeByKind(detected, file, mime, ctx?.signal, name)
}

/** action=load：把来源读入上下文，返回给模型 */
async function loadMedia(args, ctx) {
  const sources = normalizeSources(args?.source)
  const rawType = String(args?.type || "").toLowerCase()
  // 多来源只支持图片；未指定类型时按图片处理
  const kind = rawType || (sources.length > 1 ? "image" : "")
  if (!sources.length) return "No source provided"
  if (kind && !LOAD_TYPES.has(kind)) return `Unknown media type: ${rawType}`
  if (sources.length > 1 && kind !== "image") return "Multiple sources are only supported for images"

  try {
    const media = { images: [], image_paths: [], videos: [], video_paths: [], audios: [], audio_paths: [], files: [], file_paths: [] }
    for (const source of sources) {
      const one = await loadOne(source, kind, ctx)
      if (typeof one === "string") return one
      for (const key of MEDIA_KEYS) if (one[key]?.length) media[key].push(...one[key])
      if (one.text) media.text = one.text
    }
    return media
  } catch (err) {
    log.debug(`media load failed: ${err.message}`)
    return `Failed to load media: ${err.message}`
  }
}

/** 发送时保留来源文件名；URL 取路径末段，data URI 用缓存名 */
function sourceName(source, local) {
  try {
    if (/^data:/i.test(source)) return path.basename(local)
    if (/^https?:\/\//i.test(source)) return decodeURIComponent(new URL(source).pathname.split("/").pop() || "") || path.basename(local)
    return String(source).split(/[\\/]/).pop() || path.basename(local)
  } catch {
    return path.basename(local)
  }
}

/** action=send：来源只解析成本地文件路径，不识别、不转码 */
async function sendMedia(args, ctx) {
  const e = ctx?.event
  const sources = normalizeSources(args?.source)
  const kind = String(args?.type || "").toLowerCase()
  if (!e?.reply) return "Cannot send: missing conversation context."
  if (!kind) return "Missing media type (type)."
  if (!SEND_TYPES.has(kind)) return `Unknown media type: ${kind}`
  if (!sources.length) return "No source provided"
  if (sources.length > 1 && kind !== "image") return "Multiple sources are only supported for images"

  try {
    const files = []
    for (const source of sources) {
      const { file } = await materialize(source, kind, ctx, undefined, true)
      files.push(file)
    }

    if (kind === "image") {
      if (files.length === 1) await e.reply(segment.image(files[0]))
      else
        await e.reply(
          await common.makeForwardMsg(
            e,
            files.map(file => segment.image(file)),
          ),
        )
      return `Sent ${files.length} image(s).`
    }

    const local = files[0]
    if (kind === "file") {
      const filename = sourceName(sources[0], local)
      await e.reply(segment.file(local, filename))
      const size = ((await fs.stat(local)).size / 1024).toFixed(1)
      return `Sent file "${filename}" (${size}KB)`
    }
    if (kind === "audio") {
      await e.reply(segment.record(local))
      return "Voice message sent."
    }
    if (kind === "video") {
      await e.reply({ type: "video", data: { file: local } })
      return "Video sent."
    }
  } catch (err) {
    return `Failed to send media: ${err.message}`
  }

  return `Unknown media type: ${kind}`
}

tools.register({
  name: "media",
  description: "Load media into the conversation context for inspection, or send media to the current chat. Use read for plain text files. Multiple sources only support images (up to 10). Error results mean the media could not be read; do not treat them as real content.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["load", "send"], description: "load = return media to the model; send = send media to the current chat." },
      source: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_SOURCES, description: "One or more media sources: HTTP(S) URL, data URI, or local file path. Relative paths resolve from the project root." },
      type: { type: "string", enum: ["image", "video", "audio", "file"], description: "Media type. Required for send; optional for load (inferred from content)." },
    },
    required: ["action", "source"],
  },
  execute: async (args, ctx) => {
    const action = String(args?.action || "").toLowerCase()
    if (action !== "load" && action !== "send") return `Unknown action: ${args?.action || "(missing)"}. Use "load" or "send".`
    const sources = normalizeSources(args?.source)
    if (sources.length > MAX_SOURCES) return `Too many sources: ${sources.length} (max ${MAX_SOURCES})`
    const pathError = validateLocalSources(sources, ctx)
    if (pathError) return pathError
    return action === "load" ? loadMedia(args, ctx) : sendMedia(args, ctx)
  },
})
