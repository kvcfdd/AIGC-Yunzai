import browser from "../../renderer/browser.js"
import { getPlaywrightProxy } from "./proxy.js"
import { isHostnameSafe } from "./ssrf.js"
import log from "./log.js"
import path from "node:path"

const MAX_CONTENT_LENGTH = 100000
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
const READABILITY_PATH = path.resolve("node_modules/@mozilla/readability/Readability.js")
const TURNDOWN_PATH = path.resolve("node_modules/turndown/dist/turndown.js")

/**
 * 抓取网页并提取正文
 * 与聊天侧 browse 共用同一实现，避免 Agent 与聊天侧各自维护一套抓取逻辑
 *
 * @param {string} url 要抓取的 URL
 * @param {{ useProxy?: boolean, maxContentLength?: number }} opts
 * @returns {Promise<string>} 抓取结果文本；失败时返回描述性错误字符串
 */
export async function fetchWebDocument(url, { useProxy = false, maxContentLength = MAX_CONTENT_LENGTH } = {}) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "Invalid URL format"

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return "Invalid URL format"
  }
  if (!(await isHostnameSafe(parsed.hostname))) {
    log.warn(`拦截内网地址: ${parsed.hostname}`)
    return "Access to internal/private network addresses denied"
  }

  // 校验通过后进入浏览器任务
  return browser.runTask(async () => {
    let browserContext, page
    try {
      const brow = await browser.getBrowser()
      if (!brow) return "Browser initialization failed"

      const contextOpts = {
        userAgent: UA,
        viewport: { width: 1280, height: 800 },
        locale: "zh-CN",
        ignoreHTTPSErrors: true,
      }
      const proxy = getPlaywrightProxy(useProxy)
      if (proxy) contextOpts.proxy = proxy

      browserContext = await brow.newContext(contextOpts)
      page = await browserContext.newPage()

      // 拦截媒体资源减少带宽
      await page.route("**/*", route => {
        const type = route.request().resourceType()
        if (["image", "media", "font", "stylesheet"].includes(type)) {
          route.abort()
        } else {
          route.continue()
        }
      })

      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: 30000,
      })
      if (!response || response.status() >= 400) {
        return `Fetch failed: HTTP ${response?.status() || "unknown"}`
      }

      // 非 HTML 响应: 不走正文提取，直接返回原始内容
      const contentType = (response.headers()["content-type"] || "").toLowerCase()
      const isHtml = !contentType || /text\/html|application\/xhtml\+xml/.test(contentType)
      if (!isHtml) {
        let raw = ""
        try {
          raw = (await response.text()).trim()
        } catch {
          raw = ""
        }
        if (raw.length > maxContentLength) {
          raw = raw.slice(0, maxContentLength) + "\n\n...[Content truncated]"
        }
        if (!raw) return "Extracted content is empty"
        log.debug(`浏览网页成功`)
        return `<raw_content>\nSource: ${url}\nContent-Type: ${contentType || "unknown"}\n\n${raw}\n</raw_content>`
      }

      await page.waitForTimeout(1500)

      // 清理 DOM：移除脚本/样式/媒体元素，图片替换为 alt 文本
      await page.evaluate(() => {
        document.querySelectorAll("script, style, noscript, iframe, svg, canvas, video, audio").forEach(el => el.remove())
        document.querySelectorAll("img, picture").forEach(img => {
          if (img.alt?.trim()) {
            img.parentNode.replaceChild(document.createTextNode(` [img:${img.alt}] `), img)
          } else {
            img.remove()
          }
        })
        document.querySelectorAll("a").forEach(a => {
          if (!a.innerText.trim()) a.remove()
        })
      })

      // 注入正文提取库到页面内, 在 Chromium 中直接解析并转 Markdown
      await page.addScriptTag({ path: READABILITY_PATH })
      await page.addScriptTag({ path: TURNDOWN_PATH })

      const result = await page.evaluate(() => {
        const reader = new Readability(document)
        const article = reader.parse()
        const turndown = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        })
        turndown.remove(["head", "footer", "nav", "aside", "form", "button"])
        return {
          title: article?.title || document.title || "Untitled",
          markdown: turndown.turndown(article?.content || document.body.innerHTML),
        }
      })

      let finalContent = result.markdown
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\[\s*\]/g, "")
        .trim()

      if (finalContent.length > maxContentLength) {
        finalContent = finalContent.slice(0, maxContentLength) + "\n\n...[Content truncated]"
      }

      if (!finalContent) return "Extracted content is empty"

      log.debug(`浏览网页成功`)
      return `<web_content>\nTitle: ${result.title}\nSource: ${url}\n\n${finalContent}\n</web_content>`
    } catch (err) {
      let msg = err.message || "Unknown error"
      if (msg.includes("Timeout")) msg = "Navigation timeout"
      log.error(`浏览网页失败: ${msg}`)
      return `Web fetch failed: ${msg}`
    } finally {
      if (browserContext) await browserContext.close().catch(() => {})
    }
  })
}
