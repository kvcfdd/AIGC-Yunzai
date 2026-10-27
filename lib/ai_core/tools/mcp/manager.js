import cfg from "../../../config/config.js"
import { Client } from "@modelcontextprotocol/client"
import tools from "../tool-registry.js"
import log from "../../helpers/log.js"
import { buildVersionNegotiation, createTransport, normalizeTransport } from "./transport.js"
import { normalizeCallToolResult } from "./result.js"

const MAX_TOOL_NAME_LEN = 64
const NAME_PATTERN = /[^a-zA-Z0-9_-]/g

/** MCP 工具名清理：替换非法字符为 _，超出长度则截断加 hash */
export function sanitizeName(raw) {
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

/** MCP 连接管理器：配置中 servers[] → 官方 SDK Client → 注册工具
 *  @param opts.getServers 读取 servers 配置的函数
 *  @param opts.toolPrefix  工具名前缀
 *  @param opts.label       日志标签
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
    this._inited = false

    // 记录每个 Server 当前已注册的工具名称集合
    this.registeredTools = new Map()

    // 每个 Server 的工具同步串行队列，避免并发同步交错误删
    this._syncQueues = new Map()
  }

  async init() {
    if (this._inited) return
    this._inited = true
    const servers = this.getServers()
    if (!servers.length) return
    await Promise.allSettled(servers.map(srv => this._connectOne(srv)))
  }

  async _connectOne(srv) {
    const type = normalizeTransport(srv)
    const rawName = srv.name || (type === "stdio" ? srv.command : srv.url) || this.defaultName
    const serverName = sanitizeName(rawName)

    if (this.clients.some(c => c.serverName === serverName)) {
      log.warn(`${this.label}服务器名重复，跳过: ${serverName}`)
      return
    }

    try {
      const { transport, timeout } = createTransport(srv)

      // stdio 的 stderr 转发到日志
      if (transport.stderr?.on) {
        transport.stderr.on("data", chunk => log.debug(`MCP stdio [${serverName}]: ${chunk.toString().trim()}`))
      }

      const versionNegotiation = buildVersionNegotiation(srv)
      const client = new Client(
        { name: srv.client_name || "Yunzai", version: srv.client_version || "1.0.0" },
        {
          capabilities: {},
          ...(versionNegotiation ? { versionNegotiation } : {}),
          listChanged: {
            tools: {
              autoRefresh: true,
              onChanged: (error, updated) => {
                if (error) {
                  log.error(`${this.label}[${serverName}] 工具列表刷新失败: ${error.message}`)
                  return
                }
                log.info(`${this.label}检测到工具变更通知 [${serverName}]，正在重新同步工具...`)
                if (Array.isArray(updated)) this._applyTools(client, serverName, updated, timeout)
                else this._scheduleSync(client, serverName, timeout)
              },
            },
          },
        },
      )

      await client.connect(transport, { timeout })
      this.clients.push({ serverName, client, transport, timeout, type })

      // 首次加载工具
      await this._scheduleSync(client, serverName, timeout)
      log.info(`${this.label}连接成功: ${serverName} (${type})`)
    } catch (err) {
      log.error(`${this.label}连接失败: ${serverName}, ${err.message}`)
    }
  }

  /** 串行同步单个 Server 的工具列表 */
  _scheduleSync(client, serverName, timeout) {
    const prev = this._syncQueues.get(serverName) || Promise.resolve()
    const task = prev.then(() => this._refreshTools(client, serverName, timeout))
    const tracked = task.catch(() => {})
    this._syncQueues.set(serverName, tracked)
    tracked.finally(() => {
      if (this._syncQueues.get(serverName) === tracked) this._syncQueues.delete(serverName)
    })
    return task
  }

  async _refreshTools(client, serverName, timeout) {
    try {
      const result = await client.listTools(undefined, { timeout })
      this._applyTools(client, serverName, result?.tools || [], timeout)
    } catch (err) {
      log.error(`${this.label}[${serverName}] 工具同步失败: ${err.message}`)
    }
  }

  /** 将 MCP 工具列表注册/更新/下线到 registry */
  _applyTools(client, serverName, mcpTools, timeout) {
    const oldTools = this.registeredTools.get(serverName) || new Set()
    const currentTools = new Set()

    for (const t of mcpTools) {
      if (!t?.name) continue
      const toolName = sanitizeName(`${this.toolPrefix}${t.name}`)
      for (const [other, names] of this.registeredTools) {
        if (other !== serverName && names.has(toolName)) {
          log.warn(`${this.label}工具名冲突: ${toolName} 同时来自 [${other}] 与 [${serverName}]，后者将覆盖前者`)
          break
        }
      }
      currentTools.add(toolName)

      this.registry.register({
        name: toolName,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
        execute: async args => {
          try {
            const result = await client.callTool({ name: t.name, arguments: args || {} }, { timeout })
            return normalizeCallToolResult(result)
          } catch (err) {
            return `[MCP 工具调用失败]: ${err.message}`
          }
        },
      })
    }

    // 清理已下线的旧工具（包括工具列表变为空的情况）
    if (typeof this.registry.unregister === "function") {
      for (const oldToolName of oldTools) {
        if (!currentTools.has(oldToolName)) {
          this.registry.unregister(oldToolName)
          log.info(`${this.label}下线动态工具: ${oldToolName}`)
        }
      }
    }

    this.registeredTools.set(serverName, currentTools)
    if (currentTools.size) log.info(`${this.label}[${serverName}] 工具同步完成 (共 ${currentTools.size} 个)`)
    else log.warn(`${this.label}[${serverName}] 工具列表为空`)
  }

  async shutdown() {
    // 等待进行中的工具同步完成，避免关闭后注册表被回填
    for (const q of this._syncQueues.values()) await q.catch(() => {})
    this._syncQueues.clear()

    for (const { client, transport } of this.clients) {
      await client.close().catch(() => {})
      await transport?.close?.().catch(() => {})
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
    this._inited = false
  }
}

export default new McpManager()
