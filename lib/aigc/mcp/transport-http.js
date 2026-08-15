export const DEFAULT_PROTOCOL_VERSION = "2025-11-25"

/** Streamable HTTP 传输：POST 到单一端点，按 Content-Type 解析 JSON 或 SSE 响应。
 *  支持 Mcp-Session-Id 有状态会话、镜像头部 (SEP-2243)、GET + SSE 服务端通知流。 */
export class HttpTransport {
  constructor(config, name) {
    this.url = config.url
    this.apiKey = config.api_key || ""
    this.timeout = config.timeout_ms || 30_000
    this.name = name
    this.sessionId = null // 服务端返回的 Mcp-Session-Id
    this.protocolVersion = config.protocol_version || DEFAULT_PROTOCOL_VERSION
    this._notificationHandlers = [] // GET SSE 通知回调
    this._sseAborter = null // GET SSE 的 AbortController
  }

  /** 构建公共请求头：Content-Type + Auth + Session + 镜像头 */
  _buildHeaders(message) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    // 回传会话 ID
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId
    }

    // MCP 协议版本
    headers["MCP-Protocol-Version"] = this.protocolVersion

    // 镜像头部 (SEP-2243)：方便网关/代理在不解析 JSON body 的情况下路由
    if (message?.method) {
      headers["Mcp-Method"] = message.method
    }
    const targetName = message?.params?.name || message?.params?.uri
    if (targetName) {
      headers["Mcp-Name"] = targetName
    }

    return headers
  }

  /** 解析并持久化响应中的 Mcp-Session-Id */
  _captureSessionId(res) {
    const sid = res.headers.get("Mcp-Session-Id") || res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
  }

  async send(message) {
    const headers = this._buildHeaders(message)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      this._captureSessionId(res)

      if (res.status === 202) return null

      const ctype = (res.headers.get("content-type") || "").toLowerCase()

      if (ctype.includes("text/event-stream")) {
        return await this._readSse(res, message.id)
      }

      if (!res.ok) {
        const text = await this._safeText(res)
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }

      const text = await res.text()
      if (!text) return null
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  async notify(message) {
    try {
      const headers = this._buildHeaders(message)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: controller.signal,
        })
        this._captureSessionId(res)
      } finally {
        clearTimeout(timer)
      }
    } catch {
      /* 通知尽力而为 */
    }
  }

  /** 建立 GET + SSE 长连接，接收服务端主动推送的通知。
   *  返回一个停止函数，调用后关闭 SSE 流。 */
  async listenNotifications(onNotification) {
    if (typeof onNotification !== "function") {
      throw new Error("listenNotifications 需要 onNotification 回调")
    }

    // 注册回调
    this._notificationHandlers.push(onNotification)

    // 如果已有 SSE 流在运行，不重复建立
    if (this._sseAborter) {
      return () => this._unlisten(onNotification)
    }

    this._sseAborter = new AbortController()

    const run = async () => {
      try {
        const headers = { Accept: "text/event-stream" }
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
        if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId

        const res = await fetch(this.url, {
          method: "GET",
          headers,
          signal: this._sseAborter.signal,
        })

        if (!res.ok) {
          const text = await this._safeText(res)
          throw new Error(`GET SSE 失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
        }

        const ctype = (res.headers.get("content-type") || "").toLowerCase()
        if (!ctype.includes("text/event-stream")) {
          throw new Error("GET 响应不是 text/event-stream")
        }

        this._captureSessionId(res)

        const decoder = new TextDecoder()
        let buf = ""
        let dataBuf = ""
        let eventType = ""

        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true })
          let idx
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, "")
            buf = buf.slice(idx + 1)

            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim()
            } else if (line.startsWith("data:")) {
              dataBuf += (dataBuf ? "\n" : "") + line.slice(5).trimStart()
            } else if (line === "") {
              if (dataBuf) {
                try {
                  const msg = JSON.parse(dataBuf)
                  for (const handler of this._notificationHandlers) {
                    try {
                      handler(msg, eventType)
                    } catch {
                      /* 回调异常不中断其他 */
                    }
                  }
                } catch {
                  /* 忽略非 JSON 载荷 */
                }
              }
              dataBuf = ""
              eventType = ""
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          throw err
        }
      }
    }

    // 异步启动，不阻塞调用方
    run().catch(err => {
      for (const handler of this._notificationHandlers) {
        try {
          handler(null, "error", err)
        } catch {
          /* pass */
        }
      }
    })

    return () => this._unlisten(onNotification)
  }

  /** 取消单个回调的监听 */
  _unlisten(handler) {
    const idx = this._notificationHandlers.indexOf(handler)
    if (idx >= 0) this._notificationHandlers.splice(idx, 1)
    // 无回调时关闭 SSE 流
    if (!this._notificationHandlers.length && this._sseAborter) {
      this._sseAborter.abort()
      this._sseAborter = null
    }
  }

  /** 终止会话 (DELETE) */
  async terminateSession() {
    if (!this.sessionId) return
    try {
      const headers = {}
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
      headers["Mcp-Session-Id"] = this.sessionId
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        await fetch(this.url, {
          method: "DELETE",
          headers,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    } catch {
      /* 尽力而为 */
    } finally {
      this.sessionId = null
    }
  }

  /** SSE 流中提取匹配 request id 的 JSON-RPC response。
   *  跳过中间进度通知帧（无 result/error），只返回真正的最终响应。 */
  async _readSse(res, expectId) {
    const decoder = new TextDecoder()
    let buf = ""
    let dataBuf = ""

    const handleEvent = () => {
      if (!dataBuf) return null
      const payload = dataBuf
      dataBuf = ""
      try {
        const msg = JSON.parse(payload)
        if (msg && msg.jsonrpc === "2.0" && msg.id === expectId) {
          // 跳过中间进度通知（带 method 或缺少 result/error），等待最终响应
          if (msg.method || (!("result" in msg) && !("error" in msg))) return null
          return msg
        }
      } catch {
        /* 忽略非 JSON-RPC 事件 */
      }
      return null
    }

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)
        if (line === "") {
          const matched = handleEvent()
          if (matched) return matched
        } else if (line.startsWith("data:")) {
          dataBuf += (dataBuf ? "\n" : "") + line.slice(5).trimStart()
        }
      }
    }
    const matched = handleEvent()
    if (matched) return matched
    throw new Error("SSE stream ended without matching JSON-RPC response")
  }

  async _safeText(res) {
    try {
      return await res.text()
    } catch {
      return ""
    }
  }

  async close() {
    if (this._sseAborter) {
      this._sseAborter.abort()
      this._sseAborter = null
    }
    this._notificationHandlers = []
    this.sessionId = null
  }
}
