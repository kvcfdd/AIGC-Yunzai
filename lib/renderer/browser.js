import { chromium } from "playwright"
import cfg from "../config/config.js"

class Browser {
  constructor() {
    this.browser = null
    this.lock = null
    this.taskNum = 0
    /** 重启阈值与空闲回收阈值 */
    this.restartNum = 100
    this.activeTaskCount = 0
    this.idleTime = 30 * 60 * 1000
    /** 待触发的空闲回收定时器 */
    this.idleTimer = null
    /** 正在运行的任务数 */
    this.running = 0
    /** 等待中的任务 */
    this.waiters = []

    this.launchOptions = {
      headless: true,
      args: ["--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-zygote", "--disable-dev-shm-usage", "--disable-extensions", "--font-render-hinting=medium", "--enable-font-antialiasing", "--force-color-profile=srgb"],
    }
  }

  /**
   * 获取浏览器实例
   */
  async getBrowser() {
    if (this.restarting) {
      await new Promise(resolve => setTimeout(resolve, 50))
      return this.getBrowser()
    }
    if (this.browser?.isConnected?.()) return this.browser
    if (this.lock) return this.lock
    return await this.init()
  }

  /**
   * 初始化浏览器
   */
  async init() {
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

  /**
   * 统一任务入口：全局并发控制
   * 排队执行 fn，内部自动 startTask/endTask，计入重启阈值与空闲回收逻辑
   * @param fn 要执行的任务
   */
  runTask(fn) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ fn, resolve, reject })
      this._pump()
      if (this.waiters.length) {
        logger.mark(`[Browser] 并发已满，任务排队中（运行 ${this.running}，等待 ${this.waiters.length}）`)
      }
    })
  }

  /** 并发有余量时取出队首任务执行 */
  _pump() {
    const concurrency = Math.max(1, Number(this._bc("concurrency", 4)) || 4)
    while (this.running < concurrency && this.waiters.length) {
      const { fn, resolve, reject } = this.waiters.shift()
      this.running++
      this.startTask()
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.running--
          this.endTask()
          this._pump()
        })
    }
  }

  /** 读 renderer.yaml 的 browser 段配置，缺键/空值回退默认 */
  _bc(key, def) {
    const v = cfg.renderer?.browser?.[key]
    return v === undefined || v === null ? def : v
  }

  startTask() {
    this.activeTaskCount++
    // 任务到来，取消待触发的空闲回收
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  endTask() {
    this.activeTaskCount--
    this.taskNum++
    if (this.taskNum >= this._bc("restartNum", this.restartNum) && this.activeTaskCount <= 0) {
      this.restart()
    } else {
      this.scheduleIdle()
    }
  }

  /**
   * 排定空闲回收：任务全部结束后起 idleTime 定时器，到点若仍空闲则回收浏览器
   */
  scheduleIdle() {
    if (this.idleTimer || this.activeTaskCount > 0) return
    const idleMin = Number(this._bc("idleTime", 30))
    if (!(idleMin > 0)) return // 0 或负数：关闭空闲回收
    this.idleTime = idleMin * 60 * 1000
    this.idleTimer = setTimeout(() => this.idleRestart(), this.idleTime)
  }

  /**
   * 空闲回收：关闭浏览器释放内存，但不立即重启
   * 下次 getBrowser() 走 init 惰性启动
   */
  async idleRestart() {
    this.idleTimer = null
    if (this.activeTaskCount > 0 || !this.browser?.isConnected?.()) return
    if (this.restarting) return
    this.restarting = true
    try {
      logger.mark(`[Browser] 已空闲 ${this.idleTime / 60000} 分钟无调用，回收浏览器释放内存`)
      this.taskNum = 0
      await this.browser.close().catch(() => {})
    } finally {
      this.browser = null
      this.lock = null
      this.restarting = false
    }
  }
}

export default new Browser()
