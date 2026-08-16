import Renderer from "../../../lib/renderer/Renderer.js"
import browser from "../../../lib/renderer/browser.js"
import { globalStyle } from "../../style.js"
import express from "express"

export default class ServerRenderer extends Renderer {
  constructor(config) {
    super({
      id: "server",
      type: "image",
      render: "noop",
    })
    this.config = config
    this.app = express()

    // 并发控制配置
    this.queue = []
    this.activeCount = 0
    this.maxConcurrency = config.maxConcurrency || 2 // 最大并发数
    this.style = config.injectGlobalStyle !== undefined ? config.injectGlobalStyle : true // 默认注入全局样式

    this.init()
  }

  // 占位符
  noop() {
    return false
  }

  async init() {
    this.app.use(express.json({ limit: "50mb" }))
    this.app.use(express.urlencoded({ limit: "50mb", extended: true }))

    // 渲染接口
    this.app.post("/render", async (req, res) => {
      // 将请求加入队列处理
      await this.runInQueue(async () => {
        const reqId = Date.now().toString().slice(-6)
        let context = null

        try {
          const { html, url, selector, viewport, omitBackground, type, quality } = req.body
          if (!html && !url) throw new Error("Missing html or url")

          // 确定图片格式
          const imgType = type === "png" || type === "webp" ? "png" : "jpeg"

          // 开始任务
          browser.startTask()

          // 获取浏览器实例
          const chromium = await browser.getBrowser()

          // 创建上下文
          context = await chromium.newContext({
            viewport: viewport || { width: 800, height: 600 },
          })

          const page = await context.newPage()

          if (url) {
            await page.goto(url, { waitUntil: "networkidle", timeout: 20000 })
          } else {
            await page.setContent(html, { waitUntil: "networkidle", timeout: 20000 })
          }

          // 注入全局美颜 CSS
          if (this.style) {
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

          // 智能调整视口
          const size = await target.boundingBox()
          if (size) {
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

          logger.mark(`[ServerRenderer][${browser.taskNum + 1}次][${reqId}] 渲染成功 [${imgType.toUpperCase()}] ${Math.round(buff.length / 1024)}KB`)
        } catch (err) {
          logger.error(`[ServerRenderer][${reqId}] 失败`, err.message)
          res.status(500).json({ error: err.message })
        } finally {
          // 清理
          if (context) await context.close().catch(() => {})
          browser.endTask()
        }
      })
    })

    const port = this.config.port || 1134
    this.app
      .listen(port, () => {
        logger.info(`[ServerRenderer] 服务启动: http://localhost:${port}`)
      })
      .on("error", err => {
        logger.error(`[ServerRenderer] 端口 ${port} 启动失败:`, err.message)
      })
  }

  /**
   * 并发队列处理器
   * @param {Function} task
   */
  async runInQueue(task) {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++
      try {
        await task()
      } finally {
        this.activeCount--
        this.next()
      }
    } else {
      return new Promise(resolve => {
        this.queue.push(async () => {
          this.activeCount++
          try {
            await task()
          } finally {
            this.activeCount--
            this.next()
            resolve()
          }
        })
      })
    }
  }

  next() {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const nextTask = this.queue.shift()
      nextTask()
    }
  }
}
