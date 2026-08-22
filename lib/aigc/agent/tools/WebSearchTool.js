import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "web_search",
  description: `搜索互联网获取实时信息或图片资源(本工具仅用于同类工具兜底)。`,
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "搜索关键词" },
      type: { type: "string", enum: ["web", "image"], description: "搜索类型，默认 web" },
      limit: { type: "number", description: "结果数量，默认 10" },
    },
    required: ["q"],
  },

  execute: async (args, ctx) => {
    const { q, type = "web", limit = 10 } = args
    const result = await tools.execute("search", { q, type, limit }, { user_id: ctx.userId })
    if (result.error) return `搜索失败: ${result.error}`
    return result.result
  },
})
