import { readFile } from "node:fs/promises"
import tools from "./registry.js"
import { mediaToFile, sniffMediaKind, encodeImageFile, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../provider/media.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import log from "../helpers/log.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

// 已知不支持的常见格式 → 无需下载直接拒绝
const UNSUPPORTED_EXTS = /\.(zip|rar|7z|xz|gz|bz2|tar|exe|msi|apk|dll|iso|bin|dat)$/i

// 各类型下载上限（显式 type 时按对应限制下载）
const KIND_MAX = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_DOWNLOAD, audio: MAX_AUDIO_DOWNLOAD, file: MAX_FILE_DOWNLOAD }

/** 按识别出的类型走对应编码管线；mime 已在 mediaToFile 内解析完成，为 null 即无法识别 */
async function encodeByKind(kind, file, mime, signal) {
  if (kind === "image") {
    const dataUri = await encodeImageFile(file, signal)
    return { images: [dataUri], image_paths: [file], text: "图片获取成功" }
  }
  if (kind === "video") {
    const dataUri = await videoFileToDataUri(file, false, signal)
    return { videos: [dataUri], video_paths: [file], text: "视频获取成功" }
  }
  if (kind === "audio") {
    const dataUri = await audioFileToDataUri(file, signal)
    return { audios: [dataUri], audio_paths: [file], text: "音频获取成功" }
  }
  if (!mime) return "格式不支持"
  const dataUri = await fileToDataUri(file, mime)
  return { files: [dataUri], file_paths: [file], text: "文件获取成功" }
}

tools.register({
  name: "fetch_media",
  description: `多模态识别工具：可获取图片/视频/音频/常规文件(如xx.js)的内联编码供你查看对应内容，支持从 http/https URL、data URI、本地文件的绝对路径或基于bot项目当前目录的相对路径获取。

  提示: 图片文件 https URL 来自pixiv时会自动处理防盗链`,
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "来源：http/https URL、data URI、本地绝对路径或基于bot项目当前目录的相对路径。",
      },
      type: {
        type: "string",
        enum: ["image", "video", "audio", "file"],
        description: "可选：显式指定文件类型，指定后按该类型编码，不指定则按文件内容自动识别。",
      },
    },
    required: ["source"],
  },
  execute: async (args, ctx) => {
    const { source, type } = args
    if (!source) return "No source provided"
    if (UNSUPPORTED_EXTS.test(source)) return "格式不支持"

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
    const dispatcher = isPixiv ? getDownloadDispatcher() : undefined

    try {
      // 显式指定类型: 快车道，按该类型限额下载并直接编码
      if (type && KIND_MAX[type]) {
        const { file, mime } = await mediaToFile(source, { kind: type, headers, dispatcher, maxBytes: KIND_MAX[type], signal: ctx?.signal })
        return await encodeByKind(type, file, mime, ctx?.signal)
      }

      // 自动识别: 统一按 file 方式下载/定位缓存，媒体类再按魔数分流
      // 下载上限取各类型最大值(视频 80MB)，分类型上限在嗅探后校验
      let { file, mime } = await mediaToFile(source, { kind: "file", headers, dispatcher, maxBytes: MAX_VIDEO_DOWNLOAD, signal: ctx?.signal })
      if (!file) return "格式不支持"

      const buf = await readFile(file)
      let kind = sniffMediaKind(buf, mime)
      if (!kind && mime) kind = "file"
      if (!kind) return "格式不支持"
      const sizeLimit = kind === "image" ? MAX_IMAGE_BYTES : kind === "audio" ? MAX_AUDIO_DOWNLOAD : kind === "file" ? MAX_FILE_DOWNLOAD : null
      if (sizeLimit && buf.length > sizeLimit) return `文件过大 [${(buf.length / 1024 / 1024).toFixed(1)}MB]`

      return await encodeByKind(kind, file, mime, ctx?.signal)
    } catch (err) {
      log.debug(`fetch_media 失败: ${err.message}`)
      return `获取失败: ${err.message}`
    }
  },
})
