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

    // 记录每个 Server 当前已注册的工具名称集合
    this.registeredTools = new Map()

    // 每个 Server 的工具同步串行队列，避免并发同步交错误删
    this._syncQueues = new Map()
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

  /** 同步单个 Server 的工具列表到 registry */
  async _syncServerTools(client, serverName) {
    const prev = this._syncQueues.get(serverName) || Promise.resolve()
    const task = prev.then(() => this._doSyncServerTools(client, serverName))
    const tracked = task.catch(() => {})
    this._syncQueues.set(serverName, tracked)
    try {
      await task
    } finally {
      if (this._syncQueues.get(serverName) === tracked) this._syncQueues.delete(serverName)
    }
  }

  async _doSyncServerTools(client, serverName) {
    try {
      const mcpTools = await client.listTools()
      if (!mcpTools || !mcpTools.length) {
        log.warn(`${this.label}[${serverName}] 工具列表为空，跳过同步`)
        return
      }
      const oldTools = this.registeredTools.get(serverName) || new Set()
      const currentTools = new Set()

      // 注册/更新最新工具
      for (const t of mcpTools) {
        const toolName = sanitizeName(`${this.toolPrefix}${serverName}_${t.name}`)
        currentTools.add(toolName)

        this.registry.register({
          name: toolName,
          description: t.description || "",
          parameters: t.inputSchema || { type: "object", properties: {} },
          execute: async args => {
            try {
              return await client.callTool(t.name, args)
            } catch (err) {
              return `[MCP 工具调用失败]: ${err.message}`
            }
          },
        })
      }

      // 清理已下线的旧工具
      if (typeof this.registry.unregister === "function") {
        for (const oldToolName of oldTools) {
          if (!currentTools.has(oldToolName)) {
            this.registry.unregister(oldToolName)
            log.info(`${this.label}下线动态工具: ${oldToolName}`)
          }
        }
      }

      this.registeredTools.set(serverName, currentTools)
      log.info(`${this.label}[${serverName}] 工具同步完成 (共 ${mcpTools.length} 个)`)
    } catch (err) {
      log.error(`${this.label}[${serverName}] 工具同步失败: ${err.message}`)
    }
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
      await client.connect()
      this.clients.push(client)

      // 首次加载工具
      await this._syncServerTools(client, serverName)

      // 动态工具变更通知
      client.onNotification(msg => {
        if (msg.method === "notifications/tools/list_changed") {
          log.info(`${this.label}检测到工具变更通知 [${serverName}]，正在重新同步工具...`)
          this._syncServerTools(client, serverName)
        }
      })

      log.info(`${this.label}连接成功: ${serverName}`)
    } catch (err) {
      log.error(`${this.label}连接失败: ${serverName}, ${err.message}`)
    }
  }

  async shutdown() {
    // 等待进行中的工具同步完成，避免关闭后注册表被回填
    for (const q of this._syncQueues.values()) await q.catch(() => {})
    this._syncQueues.clear()

    for (const client of this.clients) {
      if (client.transport?.terminateSession) {
        await client.transport.terminateSession().catch(() => {})
      }
      await client.close().catch(() => {})
    }

    // 注销本管理器注册的全部 MCP 工具，防止残留定义继续对外暴露
    if (typeof this.registry.unregister === "function") {
      for (const toolNames of this.registeredTools.values()) {
        for (const name of toolNames) {
          this.registry.unregister(name)
        }
      }
    }
    this.clients = []
    this.registeredTools.clear()
  }
}

export default new McpManager()
