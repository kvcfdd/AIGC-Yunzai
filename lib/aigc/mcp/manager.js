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

/** MCP 连接管理器：配置中 servers[] → 创建传输+客户端 → 连接 → 注册工具
 *  @param opts.getServers 读取 servers 配置的函数
 *  @param opts.toolPrefix  工具名前缀(聊天侧 "mcp_" / Agent "agent_mcp_")
 *  @param opts.label       日志标签(聊天侧 "MCP " / Agent "[Agent-MCP] ")
 *  @param opts.defaultName 无 name 时的回退名
 *  @param opts.registry    注册目标 */
export class McpManager {
  constructor({ getServers, toolPrefix = "mcp_", label = "MCP ", defaultName = "mcp", registry = tools } = {}) {
    this.getServers = getServers || (() => cfg.aigc?.mcp?.servers || [])
    this.toolPrefix = toolPrefix
    this.label = label
    this.defaultName = defaultName
    this.registry = registry
    this.clients = []
  }

  async init() {
    const servers = this.getServers()
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
    const rawName = srv.name || (transportType === "http" ? srv.url : srv.command) || this.defaultName

    if (!transportType) {
      log.warn(`${this.label}缺少 url 或 command，跳过: ${rawName}`)
      return
    }

    const serverName = sanitizeName(rawName)

    if (transportType === "http" && !srv.url) {
      log.warn(`${this.label}HTTP 缺少 url，跳过: ${serverName}`)
      return
    }
    if (transportType === "stdio" && !srv.command) {
      log.warn(`${this.label}stdio 缺少 command，跳过: ${serverName}`)
      return
    }

    try {
      const transport = transportType === "stdio" ? new StdioTransport(srv, serverName) : new HttpTransport(srv, serverName)

      const client = new McpClient(serverName, srv, transport)
      const mcpTools = await client.connect()
      this.clients.push(client)

      for (const t of mcpTools) {
        const toolName = sanitizeName(`${this.toolPrefix}${serverName}_${t.name}`)
        this.registry.register({
          name: toolName,
          description: t.description || "",
          parameters: t.inputSchema || { type: "object", properties: {} },
          execute: async args => client.callTool(t.name, args),
        })
      }

      log.info(`${this.label}连接成功: ${serverName}`)
    } catch (err) {
      log.error(`${this.label}连接失败: ${serverName}, ${err.message}`)
    }
  }

  async shutdown() {
    for (const client of this.clients) {
      // 优雅终止 HTTP 会话
      if (client.transport?.terminateSession) {
        await client.transport.terminateSession().catch(() => {})
      }
      await client.close().catch(() => {})
    }
    this.clients = []
  }
}

export default new McpManager()
