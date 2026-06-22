import log from "../helpers/log.js"

const DEFAULT_PROTOCOL_VERSION = "2025-11-25"
let _reqId = 0

/** MCP JSON-RPC 客户端：遵循严格的标准 initialization 握手生命周期 */
class McpClient {
  constructor(name, config, transport) {
    this.name = name
    this.transport = transport
    this.preferredVersion = config.protocol_version || DEFAULT_PROTOCOL_VERSION
    this.negotiatedVersion = null
    this.legacyMode = false
  }

  /** 标准连接：先发送并且成功完成 initialize 握手，再进行 tools/list */
  async connect() {
    try {
      log.debug(`MCP 尝试建立标准连接: ${this.name}`)
      this.legacyMode = false

      // 发起标准初始化请求
      const initMsg = this._buildMessage("initialize", {
        protocolVersion: this.preferredVersion,
        capabilities: {},
        clientInfo: { name: "Yunzai", version: "1.0.0" },
      })

      let response = await this.transport.send(initMsg)
      if (!response || response.error) {
        throw new Error(response?.error?.message || "服务端无响应")
      }

      const result = response.result
      if (result?.protocolVersion) {
        this.negotiatedVersion = result.protocolVersion
      }

      // 发送 initialized 通知，确认状态转换
      await this.transport.notify(this._buildMessage("notifications/initialized", {}))

      // 执行工具列表获取
      const listResult = await this._request("tools/list", {})
      return listResult?.tools || []
    } catch (err) {
      log.warn(`MCP 标准连接失败 [${this.name}]: ${err.message}，尝试降级至 Legacy 模式`)
      return this._connectLegacy()
    }
  }

  async callTool(name, args) {
    const res = await this._request("tools/call", { name, arguments: args })
    const text = this._extractContent(res)
    if (res?.isError) throw new Error(text || "MCP tool error")
    return text
  }

  /** 构建 JSON-RPC 消息，_meta 按规范放在 params 内部而非 JSON-RPC 根层级 */
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

      // 版本不匹配 → 选取兼容版本重试一次
      if (code === -32004) {
        const supported = response.error.data?.supported || []
        return this._negotiateVersion(supported, method, params)
      }

      throw new Error(`MCP 错误 [${code}]: ${message}`)
    }

    return response.result
  }

  /** 从服务端支持的版本列表中选取最佳版本 */
  async _negotiateVersion(supported, method, params) {
    const version = supported.find(v => v === this.preferredVersion) || supported.find(v => /^\d{4}-\d{2}-\d{2}$/.test(v)) || supported[0]

    if (!version) throw new Error(`无兼容的 MCP 协议版本。客户端: ${this.preferredVersion}，服务端: ${supported.join(", ")}`)

    this.negotiatedVersion = version
    log.debug(`MCP 协议版本协商: ${this.name} → ${version}`)
    return this._request(method, params)
  }

  /** 旧版回退：initialize → initialized → tools/list */
  async _connectLegacy() {
    log.debug(`MCP 回退旧版握手: ${this.name}`)
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

    let response = await this.transport.send(initMsg)
    if (!response || response.error) {
      throw new Error(`MCP initialize 失败: ${response?.error?.message || "无响应"}`)
    }

    const result = response.result
    if (result?.protocolVersion) {
      this.negotiatedVersion = result.protocolVersion
    }

    // initialized 通知
    await this.transport.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })

    // 获取工具列表
    const toolsMsg = {
      jsonrpc: "2.0",
      id: ++_reqId,
      method: "tools/list",
      params: {},
    }
    response = await this.transport.send(toolsMsg)
    if (response?.error) {
      throw new Error(`MCP tools/list 失败: ${response.error.message}`)
    }

    return response?.result?.tools || []
  }

  /** 将 content[] 规范化为单段文本；非 text 类型转为占位符避免污染对话 */
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
    await this.transport.close()
    this.negotiatedVersion = null
    this.legacyMode = false
  }
}

export default McpClient
