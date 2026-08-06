import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "web_search",
  description: `搜索互联网获取实时信息或找媒体资源。

用法:
- 搜网页 (type=web) → 拿到结果后用 fetch_doc 打开详情页获取全文
- 搜图片 (type=image) → 拿 URL 后用 media 查看或下载保存

需要最新/实时信息时使用；本地问题优先用 file_search 与 bash。`,
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
