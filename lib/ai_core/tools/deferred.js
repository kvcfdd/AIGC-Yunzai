import { MASTER_ONLY_TOOLS } from "./workspace.js"

const MAX_TOOLS = 40
const MAX_CHARS = 3000
const DESC_MAX = 120

/** 按需工具列表 → 系统提示词块；无按需工具返回空串 */
export function deferredToolsBlock(registry, { isMaster = false } = {}) {
  const list = registry?.listDeferred ? registry.listDeferred(tool => isMaster || !MASTER_ONLY_TOOLS.has(tool.name)) : []
  if (!list.length) return ""

  const lines = ["<on_demand_tools>", "以下工具按需加载，需要时先调用 tool_search 加载："]
  let budget = lines.join("\n").length
  let omitted = false

  for (let i = 0; i < list.length; i++) {
    const tool = list[i]
    const desc = String(tool.description || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DESC_MAX)
    const line = `- ${tool.name}${desc ? `: ${desc}` : ""}`
    if (i >= MAX_TOOLS || budget + line.length + 1 > MAX_CHARS) {
      omitted = true
      break
    }
    lines.push(line)
    budget += line.length + 1
  }

  if (omitted) lines.push(`…(共 ${list.length} 个按需工具，其余已省略，可用 tool_search 搜索)`)
  lines.push("</on_demand_tools>")
  return lines.join("\n")
}
