import tools from "./registry.js"
import common from "../../common/common.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pipeline } from "node:stream/promises"

tools.register({
  name: "send_image",
  description: "Download images and send them to the chat. First search(type='image') to find images, then pass the results here. DO NOT make up URLs.",
  parameters: {
    type: "object",
    properties: {
      images: {
        type: "array",
        description: "List of images",
        items: {
          type: "object",
          properties: {
            url: { type: "string", description: "Image URL from search results — DO NOT make up" },
            referer: { type: "string", description: "Referer from search results, required for most image sources" },
          },
          required: ["url"],
        },
      },
      useProxy: { type: "boolean", description: "Whether to use proxy for downloading. Default: false (direct connection)" },
    },
    required: ["images"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "Cannot get context"

    const { images, useProxy = false } = args
    if (!Array.isArray(images) || !images.length) return "No valid image info provided"

    const tempDir = path.join(process.cwd(), "data", "aigc", "images")
    await fsp.mkdir(tempDir, { recursive: true }).catch(() => { })

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0"

    const download = async (item) => {
      const { url, referer } = item
      if (!url) return null

      const headers = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Cache-Control": "max-age=0",
        Priority: "u=0, i",
        "Sec-Ch-Ua": '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      }

      if (referer) {
        try {
          new URL(referer.startsWith("http") ? referer : `https://${referer}`)
          headers.Referer = referer
        } catch { }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const dispatcher = useProxy ? getDownloadDispatcher() : undefined
        const res = await fetch(url, { signal: controller.signal, headers, dispatcher })
        if (!res.ok) return null
        const filePath = path.join(tempDir, `img_${crypto.randomUUID()}.png`)
        await pipeline(res.body, fs.createWriteStream(filePath))
        return filePath
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    const localPaths = (await Promise.all(images.slice(0, 10).map(download))).filter(Boolean)
    if (!localPaths.length) return "All images failed to download — reply in text instead of retrying"

    try {
      if (localPaths.length === 1) {
        await e.reply(segment.image(localPaths[0]))
      } else {
        const msgs = localPaths.map(fp => segment.image(fp))
        await e.reply(await common.makeForwardMsg(e, msgs))
      }
      return `Sent ${localPaths.length} image(s)`
    } catch (err) {
      return `Send image failed: ${err.message}`
    }
  },
})
