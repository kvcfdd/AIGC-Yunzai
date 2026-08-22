import log from "../helpers/log.js"
import { DEFAULT_PROTOCOL_VERSION } from "./transport-http.js"

let _reqId = 0

/** 握手失败退避窗口：窗口内直接快速失败，不重复尝试，避免死服务端拖慢工具循环 */
const HANDSHAKE_BACKOFF_MS = 15_000

/** MCP JSON-RPC 客户端：遵循严格的标准 initialization 握手生命周期 */
class McpClient {
  constructor(name, config, transport) {
    this.name = name
    this.transport = transport
    this.preferredVersion = config.protocol_version || DEFAULT_PROTOCOL_VERSION
    this.negotiatedVersion = null
    this.legacyMode = false

    // 初始化状态与锁
    this._initialized = false
    this._handshaking = null
    this._notificationHandlers = new Set()
    // 最近一次握手失败时间戳
    this._lastHandshakeFail = 0

    // 绑定 Transport 的退出事件
    if (this.transport.onExit !== undefined) {
      this.transport.onExit = () => {
        this._initialized = false
      }
    }

    // 绑定 Transport 的通知事件
    if (this.transport.listenNotifications) {
      // HTTP GET SSE 模式
      this.transport.listenNotifications(msg => this._handleNotification(msg))
    } else {
      // STDIO 模式
      this.transport.onNotification = msg => this._handleNotification(msg)
    }
  }

  /** 注册全局通知监听 */
  onNotification(handler) {
    this._notificationHandlers.add(handler)
    return () => this._notificationHandlers.delete(handler)
  }

  _handleNotification(msg) {
    if (!msg || !msg.method) return
    for (const handler of this._notificationHandlers) {
      try {
        handler(msg)
      } catch (err) {
        log.error(`MCP 通知处理异常 [${this.name}]: ${err.message}`)
      }
    }
  }

  /** 确保已握手连接；未握手或崩溃重启后自动补握手 */
  async _ensureConnected() {
    if (this._initialized) return
    if (this._handshaking) return this._handshaking

    // 失败退避：退避窗口内直接快速失败，不重复尝试握手
    if (this._lastHandshakeFail && Date.now() - this._lastHandshakeFail < HANDSHAKE_BACKOFF_MS) {
      throw new Error(`MCP 连接不可用 [${this.name}]，退避中，稍后自动重试`)
    }

    this._handshaking = (async () => {
      try {
        await this._handshake()
        this._initialized = true
        this._lastHandshakeFail = 0
      } catch (err) {
        this._lastHandshakeFail = Date.now()
        throw err
      } finally {
        this._handshaking = null
      }
    })()

    return this._handshaking
  }

  /** 执行标准握手流程 */
  async _handshake() {
    log.debug(`MCP 正在建立握手: ${this.name}`)
    try {
      this.legacyMode = false
      const initMsg = this._buildMessage("initialize", {
        protocolVersion: this.preferredVersion,
        capabilities: {},
        clientInfo: { name: "Yunzai", version: "1.0.0" },
      })

      const response = await this.transport.send(initMsg)
      if (!response || response.error) {
        throw new Error(response?.error?.message || "服务端无响应")
      }

      if (response.result?.protocolVersion) {
        this.negotiatedVersion = response.result.protocolVersion
      }

      await this.transport.notify(this._buildMessage("notifications/initialized", {}))
    } catch (err) {
      log.warn(`MCP 标准握手失败 [${this.name}]: ${err.message}，尝试 Legacy 模式`)
      await this._handshakeLegacy()
    }
  }

  async _handshakeLegacy() {
    this.legacyMode = true
    const initMsg = {
      jsonrpc: "2.0",
      id: ++_reqId,
      method: "initialize",
      params: {
        protocolVersion: this.preferredVersion,
        capabilities: {},
        clientInfo: { name: "Yunzai", version: "1.0.0" },
      },
    }

    const response = await this.transport.send(initMsg)
    if (!response || response.error) {
      throw new Error(`Legacy initialize 失败: ${response?.error?.message || "无响应"}`)
    }

    if (response.result?.protocolVersion) {
      this.negotiatedVersion = response.result.protocolVersion
    }

    await this.transport.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })
  }

  /** 外部统一入口：连接并拉取全部工具 */
  async connect() {
    await this._ensureConnected()
    return this.listTools()
  }

  /** 单独拉取工具列表 */
  async listTools() {
    await this._ensureConnected()
    const listResult = await this._request("tools/list", {})
    return listResult?.tools || []
  }

  async callTool(name, args) {
    await this._ensureConnected()
    const res = await this._request("tools/call", { name, arguments: args })
    const text = this._extractContent(res)
    if (res?.isError) throw new Error(text || "MCP tool error")
    return text
  }

  _buildMessage(method, params = {}) {
    const id = ++_reqId
    const finalParams = { ...params }
    if (!this.legacyMode) {
      finalParams._meta = {
        "io.modelcontextprotocol/protocolVersion": this.negotiatedVersion || this.preferredVersion,
        "io.modelcontextprotocol/clientInfo": { name: "Yunzai", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      }
    }
    return { jsonrpc: "2.0", id, method, params: finalParams }
  }

  async _request(method, params) {
    const msg = this._buildMessage(method, params)
    let response
    try {
      response = await this.transport.send(msg)
    } catch (err) {
      throw new Error(`MCP 传输错误 [${this.name}]: ${err.message}`)
    }

    if (!response) return null

    if (response.error) {
      const code = response.error.code
      const message = response.error.message
      if (code === -32004) {
        const supported = response.error.data?.supported || []
        return this._negotiateVersion(supported, method, params)
      }
      throw new Error(`MCP 错误 [${code}]: ${message}`)
    }

    return response.result
  }

  async _negotiateVersion(supported, method, params) {
    const version = supported.find(v => v === this.preferredVersion) || supported.find(v => /^\d{4}-\d{2}-\d{2}$/.test(v)) || supported[0]
    if (!version) throw new Error(`无兼容协议版本`)
    this.negotiatedVersion = version
    return this._request(method, params)
  }

  _extractContent(res) {
    if (!res) return ""
    const content = Array.isArray(res.content) ? res.content : []
    const parts = []
    for (const c of content) {
      if (!c || typeof c !== "object") continue
      switch (c.type) {
        case "text":
          if (c.text) parts.push(c.text)
          break
        case "image":
          parts.push(`[image ${c.mimeType || "?"}]`)
          break
        case "audio":
          parts.push(`[audio ${c.mimeType || "?"}]`)
          break
        case "resource_link":
          parts.push(`[resource_link ${c.uri || ""}]`)
          break
        case "resource": {
          const r = c.resource || {}
          parts.push(r.text || `[resource ${r.uri || ""}]`)
          break
        }
        default:
          break
      }
    }
    if (parts.length) return parts.join("\n")
    if (res.structuredContent) return JSON.stringify(res.structuredContent)
    return ""
  }

  async close() {
    this._initialized = false
    this._notificationHandlers.clear()
    await this.transport.close()
    this.negotiatedVersion = null
    this.legacyMode = false
  }
}

export default McpClient
