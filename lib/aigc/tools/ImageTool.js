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
  description: "Download images and send them to the chat. First search(type='image') to find images, then pass the results here. DO NOT make up URLs. Supports bypassing pixiv anti-hotlink.",
  parameters: {
    type: "object",
    properties: {
      images: {
        type: "array",
        description: "List of images",
        items: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Image URL",
            },
          },
          required: ["url"],
        },
      },
    },
    required: ["images"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "Cannot get context"

    const { images } = args
    if (!Array.isArray(images) || !images.length) return "No valid image info provided"

    const tempDir = path.join(process.cwd(), "data", "aigc", "images")
    await fsp.mkdir(tempDir, { recursive: true }).catch(() => {})

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

    const download = async item => {
      const { url } = item
      if (!url) return null

      const isPixiv = (() => {
        try {
          return new URL(url).hostname === "i.pximg.net"
        } catch {
          return false
        }
      })()

      const headers = {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
      }

      if (isPixiv) headers.Referer = "https://www.pixiv.net/"
      // else headers.Referer = "https://www.bing.com/"

      const dispatcher = isPixiv ? getDownloadDispatcher() : undefined

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers,
          ...(dispatcher ? { dispatcher } : {}),
        })
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

    // 并发下载，每次最多 3 张
    const urls = images.slice(0, 10)
    const results = []
    for (let i = 0; i < urls.length; i += 3) {
      const batch = urls.slice(i, i + 3).map(download)
      results.push(...(await Promise.all(batch)))
    }
    const localPaths = results.filter(Boolean)
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
