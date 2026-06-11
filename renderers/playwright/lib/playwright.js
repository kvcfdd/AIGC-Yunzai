import Renderer from "../../../lib/renderer/Renderer.js"
import { globalStyle } from "../../style.js"
import browser from "../../../lib/renderer/browser.js"
import path from "node:path"
import { pathToFileURL } from "node:url"

const _path = process.cwd()

export default class Playwright extends Renderer {
  constructor(config = {}) {
    super({
      id: "playwright",
      type: "image",
      render: "screenshot",
    })

    this.config = config
    this.activeTaskCount = 0 // 活跃任务数
    this.scale = config.scale || 1.5 // 缩放比例

    // 并发控制
    this.queue = []
    this.maxConcurrency = config.maxConcurrency || 2
  }

  /**
   * 截图入口，包含并发控制
   */
  async screenshot(name, data = {}) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const res = await this.doScreenshot(name, data)
          resolve(res)
        } catch (err) {
          reject(err)
        } finally {
          this.checkQueue()
        }
      }

      if (this.activeTaskCount < this.maxConcurrency) {
        task()
      } else {
        logger.mark(
          `[Playwright] 正在排队... 当前任务: ${this.activeTaskCount}, 队列: ${this.queue.length + 1}`,
        )
        this.queue.push(task)
      }
    })
  }

  checkQueue() {
    if (this.queue.length > 0 && this.activeTaskCount < this.maxConcurrency) {
      const nextTask = this.queue.shift()
      nextTask()
    }
  }

  /**
   * 核心截图方法
   * @param {string} name 模板名称
   * @param {object} data 模板数据
   */
  async doScreenshot(name, data = {}) {
    this.activeTaskCount++
    browser.startTask()
    let context = null
    let page = null
    const start = Date.now()

    try {
      const chromium = await browser.getBrowser(this.config)
      const savePath = this.dealTpl(name, data)
      if (!savePath) return false

      // 创建浏览器上下文
      context = await chromium.newContext({
        deviceScaleFactor: data.deviceScaleFactor || data.viewport?.deviceScaleFactor || this.scale,
        viewport: { width: data.width || 800, height: 600 }, // 初始视口
      })

      // 创建页面
      page = await context.newPage()

      // 超时
      page.setDefaultTimeout(data.timeout || 40000)

      // 加载页面
      const fileUrl = pathToFileURL(path.join(_path, savePath)).href
      await page.goto(fileUrl, { waitUntil: "networkidle" })
      // 注入全局样式
      if (this.config.injectGlobalStyle) {
        await page.addStyleTag({ content: globalStyle })
      }
      // 定位元素
      const selector = data.selector || "#container"
      const locator = page.locator(selector).first()

      // 等待元素可见，如果找不到 #container 降级找 body
      try {
        await locator.waitFor({ state: "visible", timeout: 2000 })
      } catch {
        // logger.warn(`[Playwright] 未找到 ${selector}，降级为 body`)
      }
      const target = (await locator.count()) > 0 ? locator : page.locator("body")

      const box = await target.boundingBox()
      if (!box) throw new Error("无法获取元素尺寸")

      // 设置视口尺寸
      const viewWidth = Math.max(Math.ceil(box.width), 1)
      const viewHeight = data.multiPage
        ? (data.pageHeight || 5000) + 100
        : Math.max(Math.ceil(box.height), 1)

      await page.setViewportSize({ width: viewWidth, height: viewHeight })

      // 截图
      let buff = null
      const isPng = data.imgType === "png"
      const screenshotOpts = {
        type: isPng ? "png" : "jpeg",
        quality: isPng ? undefined : data.quality || 90,
        omitBackground: isPng ? !!data.omitBackground : false,
        animations: "disabled",
      }

      if (data.multiPage) {
        // 长图切片
        buff = []
        const pageHeight = data.pageHeight || 5000
        const totalHeight = box.height
        const num = Math.ceil(totalHeight / pageHeight)

        await page.setViewportSize({
          width: Math.ceil(box.width),
          height: pageHeight + 100,
        })

        for (let i = 0; i < num; i++) {
          const y = i * pageHeight
          // 滚动页面触发懒加载
          await page.evaluate(scrollTop => window.scrollTo(0, scrollTop), y)
          // 等待渲染稳定
          await page.waitForTimeout(i === 0 ? 100 : 300)

          const currentSliceHeight = Math.min(pageHeight, totalHeight - y)

          // 使用 locator.screenshot，clip 坐标相对元素，数学直观
          const slice = await target.screenshot({
            ...screenshotOpts,
            clip: {
              x: 0,
              y: y,
              width: box.width,
              height: currentSliceHeight,
            },
          })
          buff.push(slice)
        }
      } else {
        // 单图
        buff = await target.screenshot(screenshotOpts)
      }

      // 统计日志
      const sizeStr = Array.isArray(buff)
        ? `${(buff.reduce((a, b) => a + b.length, 0) / 1024).toFixed(2)}KB (${buff.length}页)`
        : `${(buff.length / 1024).toFixed(2)}KB`

      logger.mark(
        `[图片生成][${browser.taskNum + 1}次][${name}] ${sizeStr} ${Date.now() - start}ms`,
      )

      return buff
    } catch (error) {
      logger.error(`[图片生成失败][${name}]`, error)
      return false
    } finally {
      // 资源清理
      if (context) await context.close().catch(() => {})
      this.activeTaskCount--
      browser.endTask()
    }
  }
}
