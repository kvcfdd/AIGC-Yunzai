import tools from "../tool-registry.js"
import common from "../../../common/common.js"
import fs from "node:fs/promises"
import path from "node:path"

/** 判断字符串是否 URL，用于给出明确拒绝提示 */
function isURL(str) {
  return /^https?:\/\//i.test(str)
}

/** 仅接受已存在的本地文件；path.resolve 同时支持绝对路径与相对当前工作目录的路径 */
async function resolveLocalFile(input) {
  if (isURL(input)) throw new Error("send_media accepts local file paths only; download the URL first (fetch_media can return a local path).")
  const abs = path.resolve(input)
  const st = await fs.stat(abs).catch(() => null)
  if (!st?.isFile()) throw new Error(`File not found or unreadable: ${input}`)
  return abs
}

tools.register({
  name: "send_media",
  description: `Send an existing local file to the current chat. Accepts absolute paths or paths relative to the bot working directory. To send media from a URL, download it first and pass the local path (fetch_media can download and return one). For images, separate multiple paths with commas (up to 10).`,
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["image", "file", "record", "video"],
        description: "Media type.",
      },
      payload: {
        type: "string",
        description: "Existing local file path (absolute or relative to the bot working directory); comma-separated for multiple images.",
      },
    },
    required: ["type", "payload"],
  },

  execute: async (args, ctx) => {
    const e = ctx?.event
    const { type, payload } = args
    const raw = String(payload || "").trim()

    if (!e?.reply) return "Cannot send: missing conversation context."
    if (!type) return "Missing media type (type)."
    if (!raw) return "No local file path provided."

    if (type === "image") {
      const items = raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 10)
      if (!items.length) return "No image paths provided."

      const paths = []
      for (const item of items) {
        try {
          paths.push(await resolveLocalFile(item))
        } catch (err) {
          return `Failed to send image: ${err.message}`
        }
      }

      try {
        if (paths.length === 1) {
          await e.reply(segment.image(paths[0]))
        } else {
          await e.reply(
            await common.makeForwardMsg(
              e,
              paths.map(p => segment.image(p)),
            ),
          )
        }
        return `Sent ${paths.length} image(s).`
      } catch (err) {
        return `Failed to send image: ${err.message}`
      }
    }

    let local
    try {
      local = await resolveLocalFile(raw)
    } catch (err) {
      return err.message
    }

    if (type === "file") {
      try {
        const filename = path.basename(local)
        await e.reply(segment.file(local, filename))
        const size = ((await fs.stat(local)).size / 1024).toFixed(1)
        return `Sent file "${filename}" (${size}KB).`
      } catch (err) {
        return `Failed to send file: ${err.message}`
      }
    }

    if (type === "record") {
      try {
        await e.reply(segment.record(local))
        return "Voice message sent."
      } catch (err) {
        return `Failed to send voice message: ${err.message}`
      }
    }

    if (type === "video") {
      try {
        await e.reply({ type: "video", data: { file: local } })
        return "Video sent."
      } catch (err) {
        return `Failed to send video: ${err.message}`
      }
    }

    return `Unknown media type: ${type}`
  },
})
