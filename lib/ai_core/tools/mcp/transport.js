import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

/** 规范化传输类型，按主流配置的 type 字段选择传输 */
export function normalizeTransport(config = {}) {
  const type = config.type
  if (type === "stdio" || (!type && config.command)) return "stdio"
  if (type === "sse") return "sse"
  if (type === "http" || type === "streamable-http" || type === "streamableHttp" || (!type && config.url)) return "http"
  return null
}

/** 合并 headers 与 bearer_token（bearer_token 等价于 Authorization: Bearer） */
export function buildHeaders(config = {}) {
  const headers = { ...(config.headers || {}) }
  const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === "authorization")
  if (config.bearer_token && !hasAuth) headers.Authorization = `Bearer ${config.bearer_token}`
  return headers
}

/** 协议协商：默认 legacy（与现有服务端兼容）；auto 探测 2026-07-28；显式 protocol_version 可 pin */
export function buildVersionNegotiation(config = {}) {
  const mode = config.protocol_mode
  if (mode === "auto") return { mode: "auto" }
  if (mode === "legacy") return { mode: "legacy" }
  if (config.protocol_version === "2026-07-28") return { mode: { pin: "2026-07-28" } }
  return undefined
}

/** 环境变量：保留当前进程环境以兼容旧行为，并过滤 undefined */
function buildEnv(extra = {}) {
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, v]) => typeof v === "string"))
}

/**
 * 配置 → 官方 SDK transport。
 * @returns {{ type: "http"|"sse"|"stdio", transport: import("@modelcontextprotocol/client").Transport, timeout: number }}
 */
export function createTransport(config = {}) {
  const type = normalizeTransport(config)
  if (!type) throw new Error("缺少 type，或无法从 command/url 推断传输类型")

  const timeout = config.timeout_ms || 30_000

  if (type === "stdio") {
    if (!config.command) throw new Error("stdio 缺少 command")
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: buildEnv(config.env),
      cwd: config.cwd || process.cwd(),
      stderr: "pipe",
    })
    return { type, transport, timeout }
  }

  if (!config.url) throw new Error(`${type} 缺少 url`)
  const url = new URL(config.url)
  const headers = buildHeaders(config)
  const options = Object.keys(headers).length ? { requestInit: { headers } } : undefined
  const transport = type === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
  return { type, transport, timeout }
}
