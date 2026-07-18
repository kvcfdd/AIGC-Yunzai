import tools from "./registry.js"
import browser from "../../renderer/browser.js"
import log from "../helpers/log.js"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { marked } from "marked"

const TPL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    overflow: hidden;
  }
  #capture {
    display: inline-block;
    max-width: 100%;
    min-width: 240px;
    background: #ffffff;
    padding: 24px 32px;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.7;
    color: #1f2937;
    font-size: 15px;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  h1{font-size:1.5em;margin:1.2em 0 .5em;border-bottom:2px solid #e5e7eb;padding-bottom:.3em}
  h2{font-size:1.25em;margin:1em 0 .4em}h3{font-size:1.1em;margin:.8em 0 .3em}
  pre{background:#f3f4f6;padding:16px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;font-size:13px;line-height:1.5}
  code{background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:.9em}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #d1d5db;padding:8px 12px;text-align:left}th{background:#f9fafb}
  blockquote{border-left:3px solid #d1d5db;margin:0 0 1em;padding:4px 16px;color:#6b7280}
  ul,ol{padding-left:24px}li{margin:4px 0}
  a{color:#2563eb}img{max-width:100%}p{margin:0 0 .8em}
  hr{border:none;border-top:1px solid #e5e7eb;margin:1.5em 0}
</style></head><body><div id="capture">__CONTENT__</div></body></html>`

tools.register({
  name: "render",
  description: "Render Markdown/HTML as an image or video and send to the chat. Use when your reply has tables, code blocks, or complex formatting that benefits from visual presentation. format='video' for animations or video content.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Markdown or HTML content to render" },
      width: { type: "integer", description: "Viewport width in pixels. Default: 780" },
      format: {
        type: "string",
        enum: ["image", "video"],
        description: "Output format. 'image' for static screenshot (default), 'video' for animated HTML or embedded video.",
      },
      duration: {
        type: "number",
        description: "Recording duration in seconds for video format. Default: 3",
      },
    },
    required: ["content"],
  },
  execute: async (args, ctx) => {
    const realEvent = ctx?.event
    if (!realEvent) return "Cannot get user context"

    const fmt = args.format || "image"
    const width = args.width || 780

    let html = args.content
    if (!/^\s*</.test(html)) {
      try {
        html = marked.parse(html, { breaks: true })
      } catch (err) {
        log.error(`Markdown 解析失败: ${err.message}`)
        return `Markdown parsing failed: ${err.message}`
      }
    }

    // video 模式下自动注入全屏视频播放器
    if (fmt === "video") {
      html = html.replace(/<video\b/g, "<video autoplay muted loop playsinline")
      const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{margin:0;padding:0}body{background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh}
        video{max-width:100%;max-height:100vh}
      </style></head><body>${html}</body></html>`
      html = fullHtml
    } else {
      html = TPL.split("__CONTENT__").join(html)
    }

    browser.startTask()
    let context = null
    try {
      const chromium = await browser.getBrowser()
      const contextOpts = { viewport: { width, height: 600 } }

      // 视频模式：录制屏幕
      if (fmt === "video") {
        const dir = path.join(process.cwd(), "data", "aigc", "videos")
        await fs.mkdir(dir, { recursive: true }).catch(() => {})
        contextOpts.recordVideo = { dir, size: { width, height: 600 } }
      }

      context = await chromium.newContext(contextOpts)
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: "networkidle" })

      if (fmt === "video") {
        const vp = await page.video()?.path()
        const duration = (args.duration || 3) * 1000
        await page.waitForTimeout(duration)
        await context.close()
        context = null // 防止 finally 重复 close

        if (!vp) {
          return "Video recording failed"
        }

        // WebM → MP4，优先 ffmpeg 转换，否则直接改后缀
        const mp4 = vp.replace(/\.webm$/i, ".mp4")
        try {
          await new Promise((resolve, reject) => {
            execFile("ffmpeg", ["-y", "-i", vp, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-b:a", "128k", mp4], err => {
              if (err) reject(err)
              else resolve()
            })
          })
        } catch {
          await fs.rename(vp, mp4).catch(() => {})
        }
        const file = mp4

        await realEvent.reply({ type: "video", data: { file } })
        return "Video sent"
      }

      // 静态截图
      const element = page.locator("#capture")
      const box = await element.boundingBox()
      if (box) {
        await page.setViewportSize({
          width: Math.max(Math.ceil(box.width), 1),
          height: Math.max(Math.ceil(box.height), 1),
        })
      }

      const imgBuf = await (box ? element : page).screenshot({ type: "jpeg", quality: 90 })
      realEvent.reply(segment.image(imgBuf))
      return "[Rendered and sent to user — reply in text if needed]"
    } catch (err) {
      log.error(`render 失败: ${err.message}`)
      return `Render failed: ${err.message}`
    } finally {
      if (context) await context.close().catch(() => {})
      browser.endTask()
    }
  },
})
