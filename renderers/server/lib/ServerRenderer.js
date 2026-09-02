import Renderer from "../../../lib/renderer/Renderer.js"
import browser from "../../../lib/renderer/browser.js"
import cfg from "../../../lib/config/config.js"
import { globalStyle } from "../../style.js"
import express from "express"

export default class ServerRenderer extends Renderer {
  constructor() {
    super({
      id: "server",
      type: "image",
      render: "noop",
    })
    this.app = express()
    this.init()
  }

  // 占位符
  noop() {
    return false
  }

  async init() {
    const serverCfg = cfg.renderer?.server || {}
    if (serverCfg.enable === false) return

    this.app.use(express.json({ limit: "50mb" }))
    this.app.use(express.urlencoded({ limit: "50mb", extended: true }))

    // 渲染接口
    this.app.post("/render", async (req, res) => {
      const reqId = Date.now().toString().slice(-6)
      try {
        await browser.runTask(async () => {
          let context = null

          try {
            const start = Date.now()
            const { html, url, selector, viewport, omitBackground, type, quality } = req.body
            if (!html && !url) throw new Error("Missing html or url")

            // 确定图片格式
            const imgType = type === "png" || type === "webp" ? "png" : "jpeg"

            // 获取浏览器实例
            const chromium = await browser.getBrowser()

            // 创建上下文
            context = await chromium.newContext({
              viewport: viewport || { width: 800, height: 600 },
            })

            const page = await context.newPage()

            if (url) {
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 })
            } else {
              await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20000 })
            }

            // 注入全局美颜 CSS
            const style = cfg.renderer?.server?.injectGlobalStyle ?? true
            if (style) {
              await page.addStyleTag({ content: globalStyle })
            }

            // 寻找目标元素
            const targetSelector = selector || ".container"
            let target = page.locator(targetSelector).first()

            try {
              await target.waitFor({ state: "visible", timeout: 2000 })
            } catch (e) {
              target = page.locator("body")
            }

            // 等待字体就绪, 避免截图时字体未加载完
            await page.evaluate(() => document.fonts.ready)
            await page.evaluate(async () => {
              await Promise.all(
                [...document.images].map(async img => {
                  if (img.complete && img.naturalWidth > 0) return
                  try {
                    await Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, 3000))])
                  } catch {}
                }),
              )
            })

            // 智能调整视口
            let size = await target.boundingBox()
            if (size && (!size.width || !size.height)) {
              await page.waitForTimeout(100)
              size = await target.boundingBox()
            }
            if (size && size.width && size.height) {
              await page.setViewportSize({
                width: Math.max(Math.ceil(size.width), viewport?.width || 800),
                height: Math.max(Math.ceil(size.height), 100),
              })
            }

            // 构建截图选项
            const screenshotOptions = {
              type: imgType,
              quality: imgType === "png" ? undefined : quality || 90,
              omitBackground: omitBackground || false,
              animations: "disabled",
            }

            // 截图
            const buff = await target.screenshot(screenshotOptions)

            // 返回对应的 Content-Type
            res.set("Content-Type", `image/${imgType}`)
            res.send(buff)

            logger.mark(`[ServerRenderer][${browser.taskNum + 1}次][${reqId}] 渲染成功 [${imgType.toUpperCase()}] ${Math.round(buff.length / 1024)}KB ${logger.green(`${Date.now() - start}ms`)}`)
          } catch (err) {
            logger.error(`[ServerRenderer][${reqId}] 失败`, err.message)
            res.status(500).json({ error: err.message })
          } finally {
            // 清理
            if (context) await context.close().catch(() => {})
          }
        })
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message })
      }
    })

    const port = serverCfg.port ?? 1134
    const host = serverCfg.host ?? "127.0.0.1"
    this.app
      .listen(port, host, () => {
        logger.info(`[ServerRenderer] 服务启动: ${logger.green(`http://${host}:${port}`)}`)
      })
      .on("error", err => {
        logger.error(`[ServerRenderer] 端口 ${port} 启动失败:`, err.message)
      })
  }
}
