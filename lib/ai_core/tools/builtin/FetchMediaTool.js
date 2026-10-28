import { readFile } from "node:fs/promises"
import tools from "../tool-registry.js"
import { mediaToFile, sniffMediaKind, imageFileToDataUris, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../../media/ingest.js"
import { getDownloadProxyDispatcher } from "../../llm/network-proxy.js"
import log from "../../helpers/log.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

// 已知不支持的常见格式 → 无需下载直接拒绝
const UNSUPPORTED_EXTS = /\.(zip|rar|7z|xz|gz|bz2|tar|exe|msi|apk|dll|iso|bin|dat)$/i

// 各类型下载上限（显式 type 时按对应限制下载）
const KIND_MAX = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_DOWNLOAD, audio: MAX_AUDIO_DOWNLOAD, file: MAX_FILE_DOWNLOAD }

/** 按识别出的类型走对应编码管线；mime 已在 mediaToFile 内解析完成，为 null 即无法识别 */
async function encodeByKind(kind, file, mime, signal) {
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
  const dataUri = await fileToDataUri(file, mime)
  return { files: [dataUri], file_paths: [file], text: "File loaded" }
}

tools.register({
  name: "fetch_media",
  description: `Load an image, video, audio, or file into the conversation context for inspection. This does not send media to the user; use send_media for that. Use read for plain text files. Placeholder or error results mean the media could not be read; do not treat them as real content.`,
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "HTTP(S) URL, data URI, or local file path (absolute or relative to the bot working directory).",
      },
      type: {
        type: "string",
        enum: ["image", "video", "audio", "file"],
        description: "Optional explicit media type; inferred from the content when omitted.",
      },
    },
    required: ["source"],
  },
  execute: async (args, ctx) => {
    const { source, type } = args
    if (!source) return "No source provided"
    if (UNSUPPORTED_EXTS.test(source)) return "Unsupported format"

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
    // else headers.Referer = "https://www.bing.com/"
    const dispatcher = isPixiv ? getDownloadProxyDispatcher() : undefined

    try {
      // 显式指定类型: 快车道，按该类型限额下载并直接编码
      if (type && KIND_MAX[type]) {
        const { file, mime } = await mediaToFile(source, { kind: type, headers, dispatcher, maxBytes: KIND_MAX[type], signal: ctx?.signal })
        return await encodeByKind(type, file, mime, ctx?.signal)
      }

      // 自动识别: 统一按 file 方式下载/定位缓存，媒体类再按魔数分流
      // 下载上限取各类型最大值(视频 80MB)，分类型上限在嗅探后校验
      let { file, mime } = await mediaToFile(source, { kind: "file", headers, dispatcher, maxBytes: MAX_VIDEO_DOWNLOAD, signal: ctx?.signal })
      if (!file) return "Unsupported format"

      const buf = await readFile(file)
      let kind = sniffMediaKind(buf, mime)
      if (!kind && mime) kind = "file"
      if (!kind) return "Unsupported format"
      const sizeLimit = kind === "image" ? MAX_IMAGE_BYTES : kind === "audio" ? MAX_AUDIO_DOWNLOAD : kind === "file" ? MAX_FILE_DOWNLOAD : null
      if (sizeLimit && buf.length > sizeLimit) return `File too large [${(buf.length / 1024 / 1024).toFixed(1)}MB]`

      return await encodeByKind(kind, file, mime, ctx?.signal)
    } catch (err) {
      log.debug(`fetch_media failed: ${err.message}`)
      return `Failed to load media: ${err.message}`
    }
  },
})
