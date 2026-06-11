import cfg from "../../config/config.js"
import tools from "../tools/registry.js"
import McpClient from "./client.js"
import { HttpTransport } from "./transport-http.js"
import { StdioTransport } from "./transport-stdio.js"
import log from "../helpers/log.js"

const MAX_TOOL_NAME_LEN = 64
const NAME_PATTERN = /[^a-zA-Z0-9_-]/g

/** MCP 工具名清理：替换非法字符为 _，超出长度则截断加 hash */
function sanitizeName(raw) {
  let cleaned = String(raw)
    .replace(NAME_PATTERN, "_")
    .replace(/^_+|_+$/g, "")
  if (!cleaned) cleaned = "x"
  if (cleaned.length <= MAX_TOOL_NAME_LEN) return cleaned

  let hash = 0
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0
  const suffix = "_" + Math.abs(hash).toString(36).slice(0, 6)
  return cleaned.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix
}

/** MCP 连接管理器：配置中 servers[] → 创建传输+客户端 → 连接 → 注册工具 */
class McpManager {
  constructor() {
    this.clients = []
  }

  async init() {
    const servers = cfg.aigc?.mcp?.servers || []
    if (!servers.length) return
    await Promise.allSettled(servers.map(srv => this._connectOne(srv)))
  }

  _detectTransport(srv) {
    if (srv.transport === "stdio") return "stdio"
    if (srv.transport === "http") return "http"
    if (srv.command) return "stdio"
    if (srv.url) return "http"
    return null
  }

  async _connectOne(srv) {
    const transportType = this._detectTransport(srv)
    const rawName = srv.name || (transportType === "http" ? srv.url : srv.command) || "mcp"

    if (!transportType) {
      log.warn(`MCP 缺少 url 或 command，跳过: ${rawName}`)
      return
    }

    const serverName = sanitizeName(rawName)

    if (transportType === "http" && !srv.url) {
      log.warn(`MCP HTTP 缺少 url，跳过: ${serverName}`)
      return
    }
    if (transportType === "stdio" && !srv.command) {
      log.warn(`MCP stdio 缺少 command，跳过: ${serverName}`)
      return
    }

    try {
      const transport =
        transportType === "stdio"
          ? new StdioTransport(srv, serverName)
          : new HttpTransport(srv, serverName)

      const client = new McpClient(serverName, srv, transport)
      const mcpTools = await client.connect()
      this.clients.push(client)

      for (const t of mcpTools) {
        const toolName = sanitizeName(`mcp_${serverName}_${t.name}`)
        tools.register({
          name: toolName,
          description: t.description || "",
          parameters: t.inputSchema || { type: "object", properties: {} },
          execute: async args => client.callTool(t.name, args),
        })
      }

      log.info(`MCP 连接成功: ${serverName}`)
    } catch (err) {
      log.error(`MCP 连接失败: ${serverName}, ${err.message}`)
    }
  }

  async shutdown() {
    for (const client of this.clients) {
      await client.close().catch(() => {})
    }
    this.clients = []
  }
}

export default new McpManager()
