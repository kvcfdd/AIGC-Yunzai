/** Agent 专用工具注册中心 — 与主模型工具集完全分离 */
class AgentToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  register(tool) {
    if (!tool.name || !tool.execute) throw new Error("Agent 工具必须包含 name 和 execute")
    this.tools.set(tool.name, tool)
  }

  /** 导出为 Function Calling 格式 */
  getDefinitions(filterNames) {
    const list = []
    for (const [name, tool] of this.tools) {
      if (filterNames && !filterNames.includes(name)) continue
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
    if (!tool) return { error: `Unknown agent tool: ${name}` }
    try {
      const result = await tool.execute(args, ctx)
      return { name, result }
    } catch (err) {
      return { name, error: err.message }
    }
  }

  list() {
    const result = []
    for (const [name, tool] of this.tools) result.push({ name, description: tool.description })
    return result
  }
}

export default new AgentToolRegistry()
