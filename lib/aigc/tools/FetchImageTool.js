import tools from "./registry.js"
import { imageToDataUri, videoToDataUri } from "../provider.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import log from "../helpers/log.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

tools.register({
  name: "fetch_media",
  description: "Download and view an image or video from a URL. Use when you need to see a media file — for example, a user's avatar, a photo they mention, or any image/video URL you encounter.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Media URL to fetch and view. Supports http/https URLs and data URIs.",
      },
      type: {
        type: "string",
        enum: ["image", "video"],
        description: "Media type. Defaults to 'image' if not specified.",
      },
      referer: {
        type: "string",
        description: "Referer from the search result. REQUIRED for pixiv (i.pximg.net) — without it the image will fail to load.",
      },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url, type = "image", referer } = args
    if (!url) return "No URL provided"

    // 已经是 data URI，直接返回
    if (url.startsWith("data:image/")) {
      return { images: [url], text: "图片获取成功" }
    }
    if (url.startsWith("data:video/")) {
      return { videos: [url], text: "视频获取成功" }
    }

    const headers = {
      "User-Agent": UA,
      Accept: type === "video" ? "video/*, */*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "max-age=0",
    }

    if (referer) {
      try {
        const u = new URL(referer.startsWith("http") ? referer : `https://${referer}`)
        headers.Referer = u.href
      } catch {
        /* pass */
      }
    }

    const isPixiv = /\bi\.pximg\.net\b/i.test(url)
    const dispatcher = isPixiv ? getDownloadDispatcher() : undefined

    try {
      if (type === "video") {
        const dataUri = await videoToDataUri(url)
        return { videos: [dataUri], text: "视频获取成功" }
      }
      const dataUri = await imageToDataUri(url, headers, dispatcher)
      return { images: [dataUri], text: "图片获取成功" }
    } catch (err) {
      log.debug(`fetch_media 失败: ${err.message}`)
      return `获取失败: ${err.message}${referer ? "" : "（系统提示：可尝试传入 Referer 参数重试）"}`
    }
  },
})
