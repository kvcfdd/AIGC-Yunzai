import tools from "./registry.js"
import common from "../../common/common.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import { getBilibili, isToolInstalled, downloadWithAria2c, downloadWithNativeFetch, mergeVideoAndAudio } from "../helpers/bilibili.js"
import { formatDate } from "../helpers/time.js"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pipeline } from "node:stream/promises"

/** 文件路径白名单 */
const FILE_DIRS = [path.resolve("data/aigc/tmp"), path.resolve("data/aigc/agent")]

function isAllowedFilePath(filepath) {
  const resolved = path.resolve(filepath)
  for (const dir of FILE_DIRS) {
    if (resolved.startsWith(dir + path.sep) || resolved === dir) return true
  }
  return false
}

/** 判断字符串是 URL 还是本地路径 */
function isURL(str) {
  return /^https?:\/\//i.test(str)
}

/** 从 Bilibili URL 提取 BVID */
function extractBVID(input) {
  if (!input) return null
  // 已经是纯 BVID
  if (/^BV[\w]{8,12}$/i.test(input)) return input
  // 从 URL 提取
  const m = input.match(/bilibili\.com\/video\/(BV[\w]{8,12})/i)
  return m ? m[1] : null
}

/** 从网易云 URL 提取歌曲 ID */
function extractMusicID(input) {
  if (!input) return null
  // 纯数字
  if (/^\d+$/.test(input)) return input
  // 从 URL 提取
  const m = input.match(/music\.163\.com.*[?&]id=(\d+)/i)
  return m ? m[1] : null
}

/** 下载 URL 到临时目录，返回本地路径 */
async function downloadToTemp(url, ext = ".bin") {
  const tempDir = path.resolve("data/aigc/tmp")
  await fsp.mkdir(tempDir, { recursive: true })
  const filePath = path.join(tempDir, `dl_${crypto.randomUUID()}${ext}`)

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
      ...(getDownloadDispatcher() ? { dispatcher: getDownloadDispatcher() } : {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await pipeline(res.body, fs.createWriteStream(filePath))
    return filePath
  } finally {
    clearTimeout(timer)
  }
}

/** 下载图片到本地 */
async function downloadImage(url) {
  const isPixiv = (() => {
    try {
      return new URL(url).hostname === "i.pximg.net"
    } catch {
      return false
    }
  })()

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    Accept: "*/*",
    ...(isPixiv ? { Referer: "https://www.pixiv.net/" } : {}),
  }
  const dispatcher = isPixiv ? getDownloadDispatcher() : undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)

  try {
    const res = await fetch(url, { signal: controller.signal, headers, ...(dispatcher ? { dispatcher } : {}) })
    if (!res.ok) return null
    const tempDir = path.resolve("data/aigc/images")
    await fsp.mkdir(tempDir, { recursive: true })
    const filePath = path.join(tempDir, `img_${crypto.randomUUID()}.png`)
    await pipeline(res.body, fs.createWriteStream(filePath))
    return filePath
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

tools.register({
  name: "send",
  description: `统一发送工具 — 发送图片、文件、音乐卡片或视频到当前对话。

提示: 图片/视频/音乐的 URL 或 ID 可先通过 search 工具获取 (type: "image" | "video" | "music")。

参数:
- type: image | file | music | video
- payload: 图片/文件传 URL 或本地路径；音乐传网易云 ID (纯数字)；视频传 BVID (BV开头)

示例:
- 搜图后发图: search({ q:"猫", type:"image" }) → 取结果的 URL → send({ type:"image", payload:"https://..." })
- 多图: send({ type: "image", payload: "url1,url2" })
- 文件: send({ type: "file", payload: "data/aigc/agent/task_xxx/report.md" })
- 音乐: send({ type: "music", payload: "56760528" })
- 视频: send({ type: "video", payload: "BV1xx411c7mD" })`,

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["image", "file", "music", "video"],
        description: "发送类型: image=图片, file=文件, music=音乐卡片, video=视频",
      },
      payload: {
        type: "string",
        description: `内容:
- image: URL 或本地路径，多图用英文逗号分隔，如 "url1,url2,url3"
- file: URL、本地路径 (data/aigc/tmp/ 或 data/aigc/agent/ 下)、或文本内容
- music: 网易云歌曲 ID (纯数字)，先用 search({ type:"music" }) 搜索获取
- video: BVID (BV开头)，先用 search({ type:"video" }) 搜索获取`,
      },
    },
    required: ["type", "payload"],
  },

  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e?.reply) return "无法发送: 缺少对话上下文"

    const { type, payload } = args

    if (type === "image") {
      const items = String(payload).split(",").map(s => s.trim()).filter(Boolean).slice(0, 10)
      if (!items.length) return "未提供图片 URL/路径"

      const paths = []
      for (let i = 0; i < items.length; i += 3) {
        const batch = items.slice(i, i + 3).map(async item => {
          if (typeof item !== "string" || !item.trim()) return null
          if (isURL(item)) return downloadImage(item)
          return item
        })
        const results = await Promise.all(batch)
        for (const r of results) if (r) paths.push(r)
      }
      if (!paths.length) return "所有图片下载失败"

      try {
        if (paths.length === 1) {
          await e.reply(segment.image(paths[0]))
        } else {
          const msgs = paths.map(fp => segment.image(fp))
          await e.reply(await common.makeForwardMsg(e, msgs))
        }
        return `已发送 ${paths.length} 张图片`
      } catch (err) {
        return `发送图片失败: ${err.message}`
      }
    }

    if (type === "file") {
      if (typeof payload !== "string" || !payload.trim()) return "未提供文件内容/路径/URL"

      let buf, filename

      if (isURL(payload)) {
        try {
          const local = await downloadToTemp(payload)
          buf = await fsp.readFile(local)
          filename = path.basename(new URL(payload).pathname) || "download"
          fsp.unlink(local).catch(() => {})
        } catch (err) {
          return `下载文件失败: ${err.message}`
        }
      } else if (isAllowedFilePath(payload)) {
        const resolved = path.resolve(payload)
        try {
          await fsp.access(resolved)
          buf = await fsp.readFile(resolved)
          filename = path.basename(payload)
        } catch {
          return `文件不存在或无法读取: ${payload}`
        }
      } else {
        buf = Buffer.from(payload, "utf-8")
        filename = "file.txt"
      }

      try {
        const url = await Bot.fileToUrl({ buffer: buf, name: filename })
        await e.reply(segment.file(url, filename))
        const size = (buf.length / 1024).toFixed(1)
        return `文件 "${filename}" (${size}KB) 已发送`
      } catch (err) {
        return `发送文件失败: ${err.message}`
      }
    }

    if (type === "music") {
      const musicId = extractMusicID(String(payload))
      if (!musicId) return `无法解析音乐 ID: "${payload}"。请提供网易云歌曲 ID (纯数字) 或 music.163.com 链接。`

      try {
        await e.reply({ type: "music", data: { type: "163", id: String(musicId) } })
        return `音乐卡片已发送 (网易云 ID: ${musicId})`
      } catch (err) {
        return `发送音乐失败: ${err.message}`
      }
    }

    if (type === "video") {
      if (!isURL(String(payload)) && !extractBVID(String(payload))) {
        const vidPath = path.resolve(String(payload))
        try {
          await fsp.access(vidPath)
          await e.reply({ type: "video", data: { file: vidPath } })
          return "视频已发送"
        } catch {
          return `无法识别视频: "${payload}"。请提供 BVID、B站链接或本地 mp4 路径。`
        }
      }

      const bvid = extractBVID(String(payload))
      if (!bvid) return `无法解析 BVID: "${payload}"。请提供 BVID (BV开头) 或 bilibili.com/video/ 链接。`

      const tempDir = path.resolve("data/aigc/videos/temp", bvid)
      fs.mkdirSync(tempDir, { recursive: true })
      const videoPath = path.join(tempDir, "video.m4s")
      const audioPath = path.join(tempDir, "audio.m4s")
      const outputPath = path.resolve(`data/aigc/videos/${bvid}.mp4`)

      try {
        const meta = await getBilibili(bvid)
        if (!meta) return `无法获取视频信息: ${bvid}`

        const { arcurl, title, pic, videoUrl, audioUrl, headers, author, play, pubdate, like, totalSize } = meta

        if (!videoUrl || !audioUrl) {
          return `无法获取视频流: ${bvid}。可能是会员专属、付费内容或无音轨。`
        }

        const isOversize = totalSize > 52428800

        await e.reply([{ type: "text", data: { text: `标题：${title.replace(/<[^>]+>/g, "")}\n` } }, { type: "text", data: { text: `UP主：${author}\n发布：${formatDate(new Date(pubdate * 1000), "compact")}\n播放：${play}  点赞：${like}\n` } }, { type: "text", data: { text: `链接：${arcurl}` } }, segment.image(pic), { type: "text", data: { text: isOversize ? "\n视频过大，请点击链接前往观看" : "\n正在准备视频，请稍候..." } }])

        if (isOversize) return "视频信息已发送，文件过大跳过下载"

        if (await isToolInstalled("aria2c")) {
          await downloadWithAria2c(videoUrl, audioUrl, videoPath, audioPath, headers)
        } else {
          await downloadWithNativeFetch(videoUrl, audioUrl, videoPath, audioPath, headers)
        }

        await mergeVideoAndAudio(videoPath, audioPath, outputPath)
        await e.reply({ type: "video", data: { file: outputPath } })
        return "视频已发送"
      } catch (err) {
        return `发送视频失败: ${err.message}`
      }
    }

    return `未知发送类型: ${type}`
  },
})
