import { readFile } from "node:fs/promises"
import tools from "./registry.js"
import { mediaToFile, sniffMediaKind, imageFileToDataUri, videoFileToDataUri, audioFileToDataUri, fileToDataUri, DOCUMENT_MIMES, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../provider/media.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import log from "../helpers/log.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

// 已知不支持的常见格式 → 无需下载直接拒绝
const UNSUPPORTED_EXTS = /\.(zip|rar|7z|xz|gz|bz2|tar|exe|msi|apk|dll|iso|bin|dat)$/i

tools.register({
  name: "fetch_media",
  description: "多模态识别工具：查看图片/视频/音频/文档文件，类型按文件内容自动识别。url 支持 http/https 链接、本地绝对路径（如 E:/Yunzai/data/aigc/chat/aigc_image_xxx.jpg）、或基于项目目录的相对路径。对话历史中 [图片]/[视频]/[语音]/[文件] 标记里的路径就是本地文件，直接传入即可查看。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "媒体地址：http/https URL、data URI、本地绝对路径或项目相对路径。",
      },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url } = args
    if (!url) return "No URL provided"

    // data URI: 按 mime 直通
    if (url.startsWith("data:")) {
      const mime = url.slice(5, url.indexOf(";"))
      if (mime.startsWith("image/")) return { images: [url], text: "图片获取成功" }
      if (mime.startsWith("video/")) return { videos: [url], text: "视频获取成功" }
      if (mime.startsWith("audio/")) return { audios: [url], text: "音频获取成功" }
      if (DOCUMENT_MIMES.has(mime)) return { files: [url], text: "文件获取成功" }
      return "格式不支持"
    }

    if (UNSUPPORTED_EXTS.test(url)) return "格式不支持"

    const headers = {
      "User-Agent": UA,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "max-age=0",
    }

    const isPixiv = (() => {
      try {
        return new URL(url).hostname === "i.pximg.net"
      } catch {
        return false
      }
    })()
    if (isPixiv) headers.Referer = "https://www.pixiv.net/"
    // else headers.Referer = "https://www.bing.com/"
    const dispatcher = isPixiv ? getDownloadDispatcher() : undefined

    try {
      // 统一按 file 方式下载/定位缓存，再按内容魔数自动分流
      // 下载上限取各类型最大值(视频 80MB)，分类型上限在嗅探后校验
      const { file, mime } = await mediaToFile(url, { kind: "file", headers, dispatcher, maxBytes: MAX_VIDEO_DOWNLOAD, signal: ctx?.signal })

      const buf = await readFile(file)
      const kind = sniffMediaKind(buf, mime)
      if (!kind) return "格式不支持"
      const sizeLimit = kind === "image" ? MAX_IMAGE_BYTES : kind === "audio" ? MAX_AUDIO_DOWNLOAD : kind === "file" ? MAX_FILE_DOWNLOAD : null
      if (sizeLimit && buf.length > sizeLimit) return `文件过大 [${(buf.length / 1024 / 1024).toFixed(1)}MB]`

      if (kind === "image") {
        const dataUri = await imageFileToDataUri(file)
        return { images: [dataUri], image_paths: [file], text: "图片获取成功" }
      }
      if (kind === "video") {
        const dataUri = await videoFileToDataUri(file, false, ctx?.signal)
        return { videos: [dataUri], video_paths: [file], text: "视频获取成功" }
      }
      if (kind === "audio") {
        const dataUri = await audioFileToDataUri(file, ctx?.signal)
        return { audios: [dataUri], audio_paths: [file], text: "音频获取成功" }
      }
      const dataUri = await fileToDataUri(file, mime)
      return { files: [dataUri], file_paths: [file], text: "文件获取成功" }
    } catch (err) {
      log.debug(`fetch_media 失败: ${err.message}`)
      return `获取失败: ${err.message}`
    }
  },
})
