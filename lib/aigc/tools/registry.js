/** Agent 工具注册中心 */
class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  /** 注册单个工具: { name, description, parameters, execute(args, ctx) }
   *  @param opts.enabled 可选动态开关函数，返回 false 时工具不对外暴露且拒绝执行 */
  register(tool, { enabled } = {}) {
    if (!tool.name || !tool.execute) throw new Error("Tool 必须包含 name 和 execute")
    tool.enabled = enabled || null
    this.tools.set(tool.name, tool)
  }

  unregister(name) {
    this.tools.delete(name)
  }

  /** 导出为 Function Calling 格式 */
  getDefinitions(filterNames) {
    const list = []
    for (const [name, tool] of this.tools) {
      if (filterNames && !filterNames.includes(name)) continue
      if (typeof tool.enabled === "function" && !tool.enabled()) continue
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

  async execute(name, args, ctx) {
    const tool = this.tools.get(name)
    if (!tool) return { error: `Unknown tool: ${name}` }
    if (typeof tool.enabled === "function" && !tool.enabled()) return { error: `Tool ${name} 未开启` }
    try {
      const result = await tool.execute(args, ctx)
      return { name, result }
    } catch (err) {
      return { name, error: err.message }
    }
  }

  async executeAll(toolCalls, ctx) {
    const tasks = toolCalls.map(async call => {
      const name = call?.function?.name
      if (!name) return { name: "unknown", error: "tool_calls missing function.name" }
      let args = {}
      try {
        args = JSON.parse(call.function?.arguments || "{}")
      } catch {
        /* pass */
      }
      return this.execute(name, args, ctx)
    })
    return Promise.all(tasks)
  }

  list() {
    const result = []
    for (const [name, tool] of this.tools) {
      if (typeof tool.enabled === "function" && !tool.enabled()) continue
      result.push({ name, description: tool.description })
    }
    return result
  }
}

export default new ToolRegistry()
