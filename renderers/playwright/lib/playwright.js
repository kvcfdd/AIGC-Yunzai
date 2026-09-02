import Renderer from "../../../lib/renderer/Renderer.js"
import { globalStyle } from "../../style.js"
import browser from "../../../lib/renderer/browser.js"
import cfg from "../../../lib/config/config.js"
import path from "node:path"
import { pathToFileURL } from "node:url"

const _path = process.cwd()

export default class Playwright extends Renderer {
  constructor() {
    super({
      id: "playwright",
      type: "image",
      render: "screenshot",
    })
  }

  /**
   * 截图入口：经 browser 统一并发队列执行
   */
  async screenshot(name, data = {}) {
    return browser.runTask(() => this.doScreenshot(name, data))
  }

  /**
   * 核心截图方法
   * @param {string} name 模板名称
   * @param {object} data 模板数据
   */
  async doScreenshot(name, data = {}) {
    const pcfg = cfg.renderer?.playwright || {}
    const scale = pcfg.scale ?? 1.5
    const style = pcfg.injectGlobalStyle ?? true
    let context = null
    let page = null
    const start = Date.now()

    try {
      const chromium = await browser.getBrowser()
      const savePath = this.dealTpl(name, data)
      if (!savePath) return false

      // 创建浏览器上下文
      context = await chromium.newContext({
        deviceScaleFactor: scale,
        viewport: { width: data.width || 800, height: 600 }, // 初始视口
      })

      // 创建页面
      page = await context.newPage()

      // 超时
      page.setDefaultTimeout(data.timeout || 40000)

      // 加载页面
      const fileUrl = pathToFileURL(path.join(_path, savePath)).href
      await page.goto(fileUrl, { waitUntil: "domcontentloaded" })
      // 注入全局样式
      if (style) {
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

      let box = await target.boundingBox()
      if (!box) throw new Error("无法获取元素尺寸")
      if (!box.width || !box.height) {
        await page.waitForTimeout(100)
        box = await target.boundingBox()
        if (!box.width || !box.height) throw new Error("无法获取元素有效尺寸")
      }

      // 设置视口尺寸
      const viewWidth = Math.max(Math.ceil(box.width), 1)
      const viewHeight = data.multiPage ? (data.pageHeight || 5000) + 100 : Math.max(Math.ceil(box.height), 1)

      await page.setViewportSize({ width: viewWidth, height: viewHeight })

      // 截图
      let buff = null
      const isPng = data.imgType === "png" || data.imgType === "webp"
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
          // 滚到目标条带顶端触发懒加载
          await page.evaluate(scrollTop => window.scrollTo(0, scrollTop), box.y + y)
          // 等待渲染稳定
          await page.waitForTimeout(i === 0 ? 100 : 300)

          const scrolled = await page.evaluate(() => window.scrollY)
          const clipY = Math.max(0, box.y + y - scrolled)
          const currentSliceHeight = Math.min(pageHeight, totalHeight - y)

          const slice = await page.screenshot({
            ...screenshotOpts,
            clip: {
              x: box.x,
              y: clipY,
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
      const sizeStr = Array.isArray(buff) ? `${(buff.reduce((a, b) => a + b.length, 0) / 1024).toFixed(2)}KB (${buff.length}页)` : `${(buff.length / 1024).toFixed(2)}KB`

      logger.mark(`[图片生成][${browser.taskNum + 1}次][${name}] ${sizeStr} ${logger.green(`${Date.now() - start}ms`)}`)

      return buff
    } catch (error) {
      logger.error(`[图片生成失败][${name}]`, error)
      return false
    } finally {
      // 资源清理
      if (context) await context.close().catch(() => {})
    }
  }
}
