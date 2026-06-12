import { chromium } from "playwright"

class Browser {
  constructor() {
    this.browser = null
    this.lock = null
    this.taskNum = 0
    this.restartNum = 100
    this.activeTaskCount = 0

    this.launchOptions = {
      headless: true,
      args: ["--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-zygote", "--disable-dev-shm-usage", "--disable-extensions", "--font-render-hinting=medium", "--enable-font-antialiasing", "--force-color-profile=srgb"],
    }
  }

  /**
   * 获取浏览器实例
   * @param config 配置
   */
  async getBrowser(config = {}) {
    if (this.restarting) {
      await new Promise(resolve => setTimeout(resolve, 50))
      return this.getBrowser(config)
    }
    if (this.browser?.isConnected?.()) return this.browser
    if (this.lock) return this.lock
    return await this.init(config)
  }

  /**
   * 初始化浏览器
   */
  async init(config = {}) {
    this.lock = (async () => {
      try {
        logger.info("[Browser] 正在启动 Chromium...")

        const browser = await chromium.launch(this.launchOptions)

        browser.on("disconnected", () => {
          logger.mark("[Browser] 浏览器已断开")
          this.browser = null
          this.lock = null
        })

        this.browser = browser
        logger.info("[Browser] 启动成功")
        return browser
      } catch (err) {
        this.lock = null
        logger.error("[Browser] 启动失败", err)
        logger.error("[Browser] 请尝试 npx playwright install chromium")
        throw err
      }
    })()

    return this.lock
  }

  async restart() {
    if (this.restarting) return
    this.restarting = true
    try {
      if (this.browser) {
        logger.info("[Browser] 正在重启...")
        await this.browser.close().catch(() => {})
      }
    } catch (err) {
      logger.error("[Browser] 关闭旧实例出错", err)
    } finally {
      this.browser = null
      this.lock = null
      this.taskNum = 0
      this.init()
        .then(() => {
          this.restarting = false
        })
        .catch(err => {
          logger.error("[Browser] 重启失败", err)
          this.restarting = false
        })
    }
  }

  startTask() {
    this.activeTaskCount++
  }

  endTask() {
    this.activeTaskCount--
    this.taskNum++
    if (this.taskNum >= this.restartNum && this.activeTaskCount <= 0) {
      this.restart()
    }
  }
}

export default new Browser()
