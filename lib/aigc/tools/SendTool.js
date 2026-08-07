import tools from "./registry.js"
import common from "../../common/common.js"
import { getDownloadDispatcher } from "../helpers/proxy.js"
import { getBilibili, isToolInstalled, downloadWithAria2c, downloadWithNativeFetch, mergeVideoAndAudio } from "../helpers/bilibili.js"
import { formatDate } from "../helpers/time.js"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

/** 文件路径白名单 */
const FILE_DIRS = [path.resolve("data/aigc/tmp"), path.resolve("data/aigc/agent"), path.resolve("data/aigc/videos")]

/** 视频文件大小上限 */
const MAX_VIDEO_SIZE = 52428800

/** 语音文件大小上限 */
const MAX_RECORD_SIZE = 20 * 1024 * 1024

async function isAllowedFilePath(filepath) {
  const resolved = path.resolve(filepath)
  let real
  try {
    real = await fsp.realpath(resolved)
  } catch {
    try {
      real = await fsp.realpath(path.dirname(resolved))
    } catch {
      return false
    }
  }
  for (const dir of FILE_DIRS) {
    try {
      const dirReal = await fsp.realpath(dir)
      if (real.startsWith(dirReal + path.sep) || real === dirReal) return true
    } catch {}
  }
  return false
}

/** 判断字符串是 URL 还是本地路径 */
function isURL(str) {
  return /^https?:\/\//i.test(str)
}

/** 从 URL 提取扩展名，无有效扩展名则返回默认值 */
function extFromUrl(url, fallback) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase()
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : fallback
  } catch {
    return fallback
  }
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

/** 下载 URL 到临时目录，返回本地路径
 *  @param timeoutMs 下载超时
 *  @param maxBytes 大小上限，超限中止并抛错；0/缺省不限制 */
async function downloadToTemp(url, ext = ".bin", timeoutMs = 60000, maxBytes = 0) {
  const tempDir = path.resolve("data/aigc/tmp")
  await fsp.mkdir(tempDir, { recursive: true })
  const filePath = path.join(tempDir, `dl_${crypto.randomUUID()}${ext}`)

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const oversizeErr = maxBytes > 0 ? new Error(`文件超过大小上限 (${(maxBytes / 1024 / 1024).toFixed(0)}MB)`) : null

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
      ...(getDownloadDispatcher() ? { dispatcher: getDownloadDispatcher() } : {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // 响应头声明的大小已超限 → 直接拒绝, 不下载
    const declared = Number(res.headers.get("content-length") || 0)
    if (oversizeErr && declared > maxBytes) throw oversizeErr

    // 流式计数: 防无 Content-Length 或谎报大小的响应超限下载
    let received = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length
        if (oversizeErr && received > maxBytes) {
          controller.abort() // 停止底层拉取
          cb(oversizeErr)
          return
        }
        cb(null, chunk)
      },
    })

    await pipeline(res.body, counter, fs.createWriteStream(filePath))
    return filePath
  } finally {
    clearTimeout(timer)
  }
}

/** BVID 下载锁: 并发请求同一视频时串行执行下载合并, 避免写坏共享缓存文件 */
const bvidLocks = new Map() // bvid → Promise 链尾

/** 串行化同一 BVID 的下载流程, 前一个任务无论成败都等待其结束后再执行 */
async function withBvidLock(bvid, fn) {
  const prev = bvidLocks.get(bvid) || Promise.resolve()
  const cur = prev.then(fn, fn)
  const chain = cur.finally(() => {
    if (bvidLocks.get(bvid) === chain) bvidLocks.delete(bvid)
  })
  chain.catch(() => {})
  bvidLocks.set(bvid, chain)
  return cur
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
  description: `统一发送工具 — 发送图片、文件、语音、音乐卡片或视频到当前对话。

提示: 图片/视频/音乐的 URL 或 ID 可先通过 search 工具获取 (type: "image" | "video" | "music")。

参数:
- type: image | file | record | music | video
- payload: 图片/文件/语音/视频传 URL 或本地路径；音乐传网易云 ID (纯数字)；视频也可传 BVID (BV开头)

示例:
- 多图: send({ type: "image", payload: "url1,url2" })
- 文件: send({ type: "file", payload: "data/aigc/agent/task_xxx/report.md" })
- 语音: send({ type: "record", payload: "https://example.com/audio.mp3" })
- 音乐: send({ type: "music", payload: "56760528" })
- 视频: send({ type: "video", payload: "BV1xx411c7mD" })`,

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["image", "file", "record", "music", "video"],
        description: "发送类型: image=图片, file=文件, record=语音, music=音乐卡片, video=视频",
      },
      payload: {
        type: "string",
        description: `内容:
- image: URL 或本地路径，多图用英文逗号分隔，如 "url1,url2,url3"，最多 10 张；pixiv 图片 (i.pximg.net) 会自动添加 Referer + 走代理绕过防盗链
- file: URL、本地路径 (data/aigc/tmp/ 或 data/aigc/agent/ 下)、或文本内容
- record: URL 或本地路径，支持 mp3/amr/silk 等格式
- music: 网易云歌曲 ID (纯数字)，先用 search({ type:"music" }) 搜索获取
- video: BVID、B站链接、视频 URL、或本地路径 (data/aigc/ 下)`,
      },
    },
    required: ["type", "payload"],
  },

  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e?.reply) return "无法发送: 缺少对话上下文"

    const { type, payload } = args

    if (type === "image") {
      const items = String(payload)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 10)
      if (!items.length) return "未提供图片 URL/路径"

      const paths = []
      for (let i = 0; i < items.length; i += 3) {
        const batch = items.slice(i, i + 3).map(async item => {
          if (typeof item !== "string" || !item.trim()) return null
          if (isURL(item)) return downloadImage(item)
          if (await isAllowedFilePath(item)) return item
          return null
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
      } else if (await isAllowedFilePath(payload)) {
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

    if (type === "record") {
      const raw = String(payload)
      if (!raw.trim()) return "未提供语音 URL/路径"
      if (isURL(raw)) {
        try {
          const local = await downloadToTemp(raw, extFromUrl(raw, ".mp3"), 60000, MAX_RECORD_SIZE)
          await e.reply(segment.record(local))
          return "语音已发送"
        } catch (err) {
          return `下载语音失败: ${err.message}`
        }
      }

      // 本地路径 → 白名单校验后发送
      if (await isAllowedFilePath(raw)) {
        const resolved = path.resolve(raw)
        try {
          await fsp.access(resolved)
          await e.reply(segment.record(resolved))
          return "语音已发送"
        } catch {
          return `文件不存在或无法读取: ${raw}`
        }
      }

      return `无法识别语音: "${raw}"。请提供 URL 或本地路径 (data/aigc/ 下)，支持 mp3/amr/silk 等格式。`
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
      const raw = String(payload)
      const bvid = extractBVID(raw)
      if (bvid) {
        const tempDir = path.resolve("data/aigc/videos/temp", bvid)
        const videoPath = path.join(tempDir, "video.m4s")
        const audioPath = path.join(tempDir, "audio.m4s")
        const outputPath = path.resolve(`data/aigc/videos/${bvid}.mp4`)

        // 已下载过 → 直接发送缓存
        if (fs.existsSync(outputPath)) {
          try {
            await e.reply({ type: "video", data: { file: outputPath } })
            return "视频已发送"
          } catch (err) {
            return `发送视频失败: ${err.message}`
          }
        }

        try {
          return await withBvidLock(bvid, async () => {
            // 排队等待期间可能已被其他请求下载完成
            if (fs.existsSync(outputPath)) {
              await e.reply({ type: "video", data: { file: outputPath } })
              return "视频已发送"
            }

            fs.mkdirSync(tempDir, { recursive: true })
            const meta = await getBilibili(bvid)
            if (!meta) return `无法获取视频信息: ${bvid}`

            const { arcurl, title, pic, videoUrl, audioUrl, headers, author, play, pubdate, like, totalSize } = meta

            if (!videoUrl || !audioUrl) {
              return `无法获取视频流: ${bvid}。可能是会员专属、付费内容或无音轨。`
            }

            const isOversize = totalSize > MAX_VIDEO_SIZE

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
          })
        } catch (err) {
          return `发送视频失败: ${err.message}`
        }
      }

      // URL 直链 → 下载到临时目录后发送
      if (isURL(raw)) {
        try {
          const local = await downloadToTemp(raw, extFromUrl(raw, ".mp4"), 300000, MAX_VIDEO_SIZE)
          await e.reply({ type: "video", data: { file: local } })
          return "视频已发送"
        } catch (err) {
          return `下载视频失败: ${err.message}`
        }
      }

      // 本地路径 → 白名单校验后发送
      if (await isAllowedFilePath(raw)) {
        const vidPath = path.resolve(raw)
        try {
          await fsp.access(vidPath)
          await e.reply({ type: "video", data: { file: vidPath } })
          return "视频已发送"
        } catch {
          return `视频文件不存在或无法读取: ${raw}`
        }
      }

      return `无法识别视频: "${raw}"。请提供 BVID、B站链接、视频 URL 或本地路径 (data/aigc/ 下)。`
    }

    return `未知发送类型: ${type}`
  },
})
