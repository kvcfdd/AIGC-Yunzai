import cfg from "../config.js"
import { MASTER_ONLY_TOOLS, NON_MASTER_MSG, isMaster } from "./workspace.js"

/** 默认直接挂载的高频工具；其余工具通过 tool_view / tool_exec 渐进式调用 */
export const DEFAULT_NATIVE_TOOLS = Object.freeze(["read", "write", "edit", "glob", "grep", "pwsh", "bash", "skill", "media", "tool_view", "tool_exec"])

/** 渐进式加载的元工具，任何配置下都直接挂载 */
const ALWAYS_NATIVE_TOOLS = new Set(["tool_view", "tool_exec"])

/** 工具是否启用；enabled 抛错时按未启用处理 */
export function isToolEnabled(tool) {
  if (typeof tool.enabled !== "function") return true
  try {
    return !!tool.enabled()
  } catch {
    return false
  }
}

/** 工具注册中心
 *  @param opts.toolNotFound 未命中工具时的错误消息生成函数
 *  @param opts.config 配置对象，用于读取 aigc.tool_loading.native */
export class ToolRegistry {
  constructor({ toolNotFound = name => `Unknown tool: ${name}`, config = cfg } = {}) {
    this.tools = new Map()
    this.toolNotFound = toolNotFound
    this.config = config
  }

  /** 注册单个工具: { name, description, parameters, execute(args, ctx) }
   *  @param opts.enabled 可选动态开关函数，返回 false 时工具不对外暴露且拒绝执行
   *  @param opts.source 工具来源，写入 catalog 与 tool_view 结果 */
  register(tool, { enabled, source } = {}) {
    if (!tool.name || !tool.execute) throw new Error("Tool 必须包含 name 和 execute")
    tool.enabled = enabled || null
    tool.source = source || tool.source || "builtin"
    this.tools.set(tool.name, tool)
  }

  unregister(name) {
    this.tools.delete(name)
  }

  /** 当前直接挂载的工具名集合；配置优先，缺省用内置列表 */
  nativeNames() {
    const configured = this.config?.aigc?.tool_loading?.native
    const list = Array.isArray(configured) ? configured : typeof configured === "string" ? configured.split(/[,\s]+/).filter(Boolean) : DEFAULT_NATIVE_TOOLS
    const names = new Set(list.map(String))
    for (const name of ALWAYS_NATIVE_TOOLS) names.add(name)
    return names
  }

  /** 工具是否直接挂载 */
  isNative(name) {
    return this.nativeNames().has(name)
  }

  /** 导出为 Function Calling 格式 — 只包含直接挂载的工具 */
  getDefinitions(filterNames) {
    const native = this.nativeNames()
    const list = []
    for (const [name, tool] of this.tools) {
      if (filterNames && !filterNames.includes(name)) continue
      if (!native.has(name)) continue
      if (!isToolEnabled(tool)) continue
      list.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} },
        },
      })
    }
    return list
  }

  /** 渐进式工具目录 — 未直接挂载且当前启用的工具，按名称排序 */
  catalog() {
    const native = this.nativeNames()
    const list = []
    for (const [name, tool] of this.tools) {
      if (native.has(name)) continue
      if (!isToolEnabled(tool)) continue
      list.push({
        name,
        description: tool.description || "",
        permission: MASTER_ONLY_TOOLS.has(name) ? "master" : "all",
        source: tool.source || "builtin",
      })
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  async execute(name, args, ctx) {
    const tool = this.tools.get(name)
    if (!tool) return { error: this.toolNotFound(name) }
    if (!isToolEnabled(tool)) return { error: `Tool ${name} 未开启` }
    if (MASTER_ONLY_TOOLS.has(name) && !isMaster(ctx)) return { name, error: NON_MASTER_MSG }
    if (ctx?.signal?.aborted) return { name, error: "Aborted" }
    try {
      const result = await tool.execute(args, ctx)
      return { name, result }
    } catch (err) {
      return { name, error: err.message }
    }
  }
}

export default new ToolRegistry()
