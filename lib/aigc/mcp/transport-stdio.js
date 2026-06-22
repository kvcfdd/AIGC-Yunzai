import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import log from "../helpers/log.js"

/** stdio 传输：spawn 子进程，NDJSON 帧协议，按 id 路由并发响应。
 *  使用 StringDecoder 安全处理多字节字符边界。 */
export class StdioTransport {
  constructor(config, name) {
    this.command = config.command
    this.args = config.args || []
    this.env = { ...process.env, ...config.env }
    this.timeout = config.timeout_ms || 30_000
    this.name = name
    this.process = null
    this.pending = new Map() // id → { resolve, reject, timer }
    this.buf = "" // stdout 行缓冲
    this._decoder = new StringDecoder("utf-8") // 安全解码多字节字符
  }

  async _ensureProcess() {
    if (this.process && !this.process.killed) return
    await this._start()
  }

  _start() {
    return new Promise((resolve, reject) => {
      const p = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
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
        for (const [, { reject, timer }] of this.pending) {
          clearTimeout(timer)
          reject(new Error(`MCP 进程已退出 (code=${code}, signal=${signal})`))
        }
        this.pending.clear()
        this.process = null
      })

      this.process = p
      // 下一个事件循环：如果 error 没有触发则说明启动成功
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
        const pending = this.pending.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(msg.id)
          pending.resolve(msg)
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
