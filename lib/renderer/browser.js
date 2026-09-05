import { chromium } from "playwright"
import { AsyncLocalStorage } from "node:async_hooks"
import cfg from "../config/config.js"

/** 任务执行上下文 */
const taskContext = new AsyncLocalStorage()

class Browser {
  constructor() {
    this.browser = null
    this.initPromise = null
    this.restartPromise = null
    /** 累计任务数 */
    this.taskNum = 0
    /** 重启阈值与空闲回收阈值 */
    this.restartNum = 100
    this.idleTime = 30 * 60 * 1000
    /** 待触发的空闲回收定时器 */
    this.idleTimer = null
    /** 正在运行的任务数 */
    this.running = 0
    /** 等待队列 */
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
    if (!taskContext.getStore()) throw new Error("[Browser] 禁止直连 Chromium")
    if (this.restartPromise) await this.restartPromise
    if (this.browser?.isConnected?.()) return this.browser
    return this.init()
  }

  /**
   * 初始化浏览器
   */
  async init() {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        logger.info("[Browser] 正在启动 Chromium...")
        const browser = await chromium.launch(this.launchOptions)

        browser.on("disconnected", () => {
          logger.mark("[Browser] 浏览器已断开")
          this.browser = null
        })

        this.browser = browser
        logger.info("[Browser] 启动成功")
        return browser
      } catch (err) {
        logger.error("[Browser] 启动失败", err)
        logger.error("[Browser] 请尝试 npx playwright install chromium")
        throw err
      } finally {
        this.initPromise = null
      }
    })()

    return this.initPromise
  }

  /**
   * 重启实例
   */
  restart() {
    if (this.restartPromise) return this.restartPromise
    this.restartPromise = (async () => {
      try {
        if (this.browser) {
          logger.info("[Browser] 正在重启...")
          await this.browser.close().catch(() => {})
        }
      } catch (err) {
        logger.error("[Browser] 关闭旧实例出错", err)
      } finally {
        this.browser = null
        this.taskNum = 0
      }

      await this.init().catch(err => logger.error("[Browser] 重启失败", err))
    })().finally(() => {
      this.restartPromise = null
    })
    return this.restartPromise
  }

  /**
   * 统一任务入口：全局并发控制
   * 任务回调内再次 runTask 直接执行不排队，避免并发占满时自我死锁
   * 任务在途时外部到达的并发调用不受影响，照常入队
   */
  runTask(fn) {
    if (taskContext.getStore()) return Promise.resolve().then(fn)
    return new Promise((resolve, reject) => {
      this.waiters.push({ fn, resolve, reject })
      this._pump()
      if (this.waiters.length > 0) {
        logger.mark(`[Browser] 任务排队中（运行 ${this.running} / 等待 ${this.waiters.length}）`)
      }
    })
  }

  /**
   * 调度队列：有余量则派发任务
   * 重启/回收进行中先等其完成再派发
   */
  async _pump() {
    if (this.restartPromise) await this.restartPromise
    const concurrency = Math.max(1, Number(this._bc("concurrency", 4)) || 4)
    while (this.running < concurrency && this.waiters.length > 0) {
      const { fn, resolve, reject } = this.waiters.shift()
      this.running++
      // 任务到来，取消待触发的空闲回收
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      Promise.resolve()
        .then(() => taskContext.run(true, fn))
        .finally(() => {
          this.running--
          this.taskNum++
          const restartNum = this._bc("restartNum", this.restartNum)
          if (this.taskNum >= restartNum && this.running === 0) this.restart()
          else this.scheduleIdle()
          this._pump()
        })
        .then(resolve, reject)
    }
  }

  /** 读 renderer.yaml 的 browser 段配置，缺键/空值回退默认 */
  _bc(key, def) {
    const v = cfg.renderer?.browser?.[key]
    return v === undefined || v === null ? def : v
  }

  /**
   * 排定空闲回收：任务全部结束后起 idleTime 定时器，到点若仍空闲则回收浏览器
   */
  scheduleIdle() {
    if (this.idleTimer || this.running > 0) return
    const idleMin = Number(this._bc("idleTime", 30))
    if (!(idleMin > 0)) return // 0 或负数：关闭空闲回收
    this.idleTime = idleMin * 60 * 1000
    this.idleTimer = setTimeout(() => this.idleRestart(), this.idleTime)
  }

  /**
   * 空闲回收：关闭浏览器释放内存，但不立即重启
   * 之后由下个任务的 getBrowser 惰性启动
   */
  async idleRestart() {
    this.idleTimer = null
    if (this.running > 0 || this.restartPromise || !this.browser?.isConnected?.()) return

    this.restartPromise = (async () => {
      try {
        logger.mark(`[Browser] 已空闲 ${this.idleTime / 60000} 分钟无调用，回收浏览器释放内存`)
        this.taskNum = 0
        await this.browser.close().catch(() => {})
      } finally {
        this.browser = null
        this.initPromise = null
      }
    })().finally(() => {
      this.restartPromise = null
    })

    await this.restartPromise
  }
}

export default new Browser()
