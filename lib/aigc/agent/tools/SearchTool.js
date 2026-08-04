import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "search",
  description: `搜索互联网：网页、图片、视频或音乐。需要实时信息或找媒体资源时使用。

搜索结果的使用方式:
- 搜网页 → browse 打开详情
- 搜图片 → 取 URL 后续用 workspace.write 保存或 media 查看
- 搜音乐 → 取网易云 ID
- 搜视频 → 取 BVID`,
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "搜索关键词" },
      type: { type: "string", enum: ["web", "image", "video", "music"], description: "搜索类型，默认 web" },
      limit: { type: "number", description: "结果数量，默认 10" },
    },
    required: ["q"],
  },
  execute: async (args, ctx) => {
    const result = await tools.execute("search", args, { user_id: ctx.userId })
    if (result.error) return `搜索失败: ${result.error}`
    return result.result
  },
})
