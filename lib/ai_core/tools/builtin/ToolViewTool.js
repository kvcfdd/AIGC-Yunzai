import tools, { isToolEnabled } from "../tool-registry.js"
import { MASTER_ONLY_TOOLS, isMaster } from "../workspace.js"

const MAX_TOOLS = 10
const MAX_DESC_CHARS = 600

/** 单个工具的可查看定义 */
function describe(tool, name) {
  return {
    name,
    description: String(tool.description || "").slice(0, MAX_DESC_CHARS),
    parameters: tool.parameters || { type: "object", properties: {} },
    permission: MASTER_ONLY_TOOLS.has(name) ? "master" : "all",
    source: tool.source || "builtin",
  }
}

tools.register({
  name: "tool_view",
  description: "Return full JSON Schemas for deferred tools listed in <available_tools>. Call this before tool_exec when the parameter structure is unknown. Native tools do not need viewing.",
  parameters: {
    type: "object",
    properties: {
      tool_names: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_TOOLS,
        description: "Deferred tool names from <available_tools>.",
      },
    },
    required: ["tool_names"],
  },
  execute: async (args, ctx) => {
    const raw = Array.isArray(args?.tool_names) ? args.tool_names : []
    const names = [...new Set(raw.map(name => String(name ?? "").trim()).filter(Boolean))].slice(0, MAX_TOOLS)
    if (!names.length) throw new Error("tool_names 不能为空")

    const out = { tools: [], errors: [] }
    for (const name of names) {
      const tool = tools.tools.get(name)
      if (!tool) {
        out.errors.push({ name, error: "工具不存在" })
        continue
      }
      if (tools.isNative(name)) {
        out.errors.push({ name, error: "原生工具无需查看，请直接调用" })
        continue
      }
      if (!isToolEnabled(tool)) {
        out.errors.push({ name, error: "工具未开启" })
        continue
      }
      if (MASTER_ONLY_TOOLS.has(name) && !isMaster(ctx)) {
        out.errors.push({ name, error: "仅 master 可用" })
        continue
      }
      out.tools.push(describe(tool, name))
    }

    return JSON.stringify(out)
  },
})
