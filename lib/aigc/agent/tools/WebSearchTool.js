import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "web_search",
  description: `搜索互联网 — 获取实时信息或图片资源。需要实时信息、最新动态或找媒体资源时使用。

来源:
- 搜网页: 来自Bing，duckduckgo，baidu
- 搜图片: 来自Bing，pixiv(需要下载pixiv的图片需要主动传Referer:https://www.pixiv.net/)

参数:
- q: 搜索关键词
- type: web=网页, image=图片, 默认 web
- limit: 结果数量,默认 10

示例:
- 搜索新闻: web_search({ q: "2026年8月 AI 行业新闻" })
- 搜索图片: web_search({ q: "cat wallpaper", type: "image", limit: 5 })`,
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
