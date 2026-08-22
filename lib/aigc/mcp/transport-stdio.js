import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import log from "../helpers/log.js"

export class StdioTransport {
  constructor(config, name) {
    this.command = config.command
    this.args = config.args || []
    this.env = { ...process.env, ...config.env }
    this.timeout = config.timeout_ms || 30_000
    this.name = name
    this.process = null
    this.pending = new Map()
    this.buf = ""
    this._decoder = new StringDecoder("utf-8")

    // 通知与生命周期事件回调
    this.onNotification = null
    this.onExit = null
  }

  async _ensureProcess() {
    if (this.process && !this.process.killed) return
    await this._start()
  }

  _start() {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === "win32"
      const p = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: isWin,
        windowsHide: true,
      })

      let settled = false
      p.on("error", err => {
        if (!settled) {
          settled = true
          reject(new Error(`无法启动进程 ${this.command}: ${err.message}`))
        }
      })

      p.stdout.on("data", chunk => this._onStdout(chunk))
      p.stderr.on("data", chunk => log.debug(`MCP stdio [${this.name}]: ${chunk.toString().trim()}`))

      p.on("exit", (code, signal) => {
        log.warn(`MCP stdio 进程退出 [${this.name}] (code=${code}, signal=${signal})`)
        for (const [, { reject, timer }] of this.pending) {
          clearTimeout(timer)
          reject(new Error(`MCP 进程已退出 (code=${code}, signal=${signal})`))
        }
        this.pending.clear()
        this.process = null

        // 触发退出回调，通知 Client 重置初始化状态
        if (typeof this.onExit === "function") {
          this.onExit(code, signal)
        }
      })

      this.process = p
      setImmediate(() => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
    })
  }

  _onStdout(chunk) {
    this.buf += this._decoder.write(chunk)
    let idx
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)

        // 响应消息
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)
          clearTimeout(pending.timer)
          this.pending.delete(msg.id)
          pending.resolve(msg)
        }
        // 服务端主动推送的通知
        else if (msg.method && typeof this.onNotification === "function") {
          this.onNotification(msg)
        }
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }

  async send(message) {
    await this._ensureProcess()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`MCP 请求超时: ${message.method}`))
      }, this.timeout)

      this.pending.set(message.id, { resolve, reject, timer })

      try {
        this.process.stdin.write(JSON.stringify(message) + "\n")
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(message.id)
        reject(new Error(`写入 stdin 失败: ${err.message}`))
      }
    })
  }

  async notify(message) {
    await this._ensureProcess()
    try {
      this.process.stdin.write(JSON.stringify(message) + "\n")
    } catch {
      /* 通知尽力而为 */
    }
  }

  async close() {
    if (!this.process) return
    this.process.stdin.end()
    await new Promise(resolve => {
      const t = setTimeout(() => {
        this.process?.kill()
        resolve()
      }, 5000)
      this.process.on("exit", () => {
        clearTimeout(t)
        resolve()
      })
    })
    this.process = null
  }
}
