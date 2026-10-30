/** 工具注册中心
 *  @param opts.toolNotFound 未命中工具时的错误消息生成函数 */
export class ToolRegistry {
  constructor({ toolNotFound = name => `Unknown tool: ${name}` } = {}) {
    this.tools = new Map()
    this.toolNotFound = toolNotFound
  }

  /** 注册单个工具: { name, description, parameters, execute(args, ctx) }
   *  @param opts.enabled 可选动态开关函数，返回 false 时工具不对外暴露且拒绝执行
   *  @param opts.deferred 按需工具：默认不暴露，需经 tool_search 加载后才可调用 */
  register(tool, { enabled, deferred } = {}) {
    if (!tool.name || !tool.execute) throw new Error("Tool 必须包含 name 和 execute")
    tool.enabled = enabled || null
    tool.deferred = !!deferred
    this.tools.set(tool.name, tool)
  }

  unregister(name) {
    this.tools.delete(name)
  }

  /** 导出为 Function Calling 格式；deferred 工具仅在 activeTools 中时才暴露 */
  getDefinitions(filterNames, { activeTools } = {}) {
    const list = []
    for (const [name, tool] of this.tools) {
      if (filterNames && !filterNames.includes(name)) continue
      if (typeof tool.enabled === "function" && !tool.enabled()) continue
      if (tool.deferred && !activeTools?.has(name)) continue
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

  /** 当前可用的按需工具；filter 可用于过滤 master-only 等 */
  listDeferred(filter) {
    return [...this.tools.values()].filter(t => t.deferred && (typeof t.enabled !== "function" || t.enabled()) && (!filter || filter(t)))
  }

  /** 在按需工具中搜索：关键词匹配名称/描述，或 select:name1,name2 精确选择 */
  searchDeferred(query, { limit = 8, filter, activeTools } = {}) {
    const q = String(query || "").trim()
    if (!q) return []
    const candidates = this.listDeferred(filter).filter(t => !activeTools?.has(t.name))
    if (/^select:/i.test(q)) {
      const names = q
        .slice(7)
        .split(/[,;\s]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
      const byName = new Map(candidates.map(t => [t.name.toLowerCase(), t]))
      return [...new Set(names)]
        .map(n => byName.get(n))
        .filter(Boolean)
        .slice(0, limit)
    }
    const lower = q.toLowerCase()
    const tokens = lower.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
    if (!tokens.length) return []
    const scored = []
    for (const tool of candidates) {
      const name = tool.name.toLowerCase()
      const desc = String(tool.description || "").toLowerCase()
      let score = 0
      if (name === lower) score += 100
      else if (name.includes(lower)) score += 40
      for (const token of tokens) {
        if (name.includes(token)) score += 10
        if (desc.includes(token)) score += 3
      }
      if (score > 0) scored.push({ tool, score })
    }
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    return scored.slice(0, limit).map(item => item.tool)
  }

  async execute(name, args, ctx) {
    const tool = this.tools.get(name)
    if (!tool) return { error: this.toolNotFound(name) }
    if (typeof tool.enabled === "function" && !tool.enabled()) return { error: `Tool ${name} 未开启` }
    if (tool.deferred && !ctx?.activeTools?.has(name)) return { error: `Tool ${name} 未加载，请先使用 tool_search 搜索并加载` }
    try {
      const result = await tool.execute(args, ctx)
      return { name, result }
    } catch (err) {
      return { name, error: err.message }
    }
  }
}

export default new ToolRegistry()
