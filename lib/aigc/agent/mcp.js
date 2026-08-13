/**
 * Agent MCP 管理器 — 与主模型 MCP 完全独立
 *
 * 配置: cfg.aigc.agent.mcp.servers[]
 * 工具注册到 agentTools 注册中心，不污染主模型工具集
 */

import cfg from "../../config/config.js"
import agentTools from "./registry.js"
import { McpManager } from "../mcp/manager.js"

export default new McpManager({
  getServers: () => cfg.aigc?.agent?.mcp?.servers || [],
  toolPrefix: "agent_mcp_",
  label: "[Agent-MCP] ",
  defaultName: "agent-mcp",
  registry: agentTools,
})
