/** Streamable HTTP 传输：POST 到单一端点，按 Content-Type 解析 JSON 或 SSE 响应 */
export class HttpTransport {
  constructor(config, name) {
    this.url = config.url
    this.apiKey = config.api_key || ""
    this.timeout = config.timeout_ms || 30_000
    this.name = name
  }

  async send(message) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })

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
      const headers = { "Content-Type": "application/json" }
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    } catch {
      /* 通知尽力而为 */
    }
  }

  /** SSE 流中提取匹配 request id 的 JSON-RPC response */
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
        if (msg && msg.jsonrpc === "2.0" && msg.id === expectId) return msg
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
    // stateless — nothing to close
  }
}
