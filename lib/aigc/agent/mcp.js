/**
 * Agent MCP 管理器 — 与聊天侧 MCP 完全独立
 *
 * 配置: cfg.agent.mcp.servers[]
 * 工具注册到 agentTools 注册中心，不污染聊天侧工具集
 */

import cfg from "../../config/config.js"
import agentTools from "./registry.js"
import { McpManager } from "../mcp/manager.js"

export default new McpManager({
  getServers: () => cfg.agent?.mcp?.servers || [],
  toolPrefix: "agent_mcp_",
  label: "[Agent-MCP] ",
  defaultName: "agent-mcp",
  registry: agentTools,
})
