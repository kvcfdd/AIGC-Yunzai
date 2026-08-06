import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: `查看网络媒体内容 — 获取 URL 对应的图片/视频并转码为视觉输入供模型分析。

用于: 查看搜索结果里的图片、视频封面、网络图片内容等。
本地文件 (截图、生成的图片、PDF) 请用 file_view 查看。

说明:
- 支持 http/https URL 与 data URI
- pixiv 图片 (i.pximg.net) 自动添加 Referer + 走代理绕过防盗链`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "媒体 URL (http/https 或 data URI)" },
      type: { type: "string", enum: ["image", "video"], description: "媒体类型，默认 image" },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url, type = "image" } = args
    const result = await tools.execute("fetch_media", { url, type }, { user_id: ctx.userId })
    if (result.error) return `获取失败: ${result.error}`
    return result.result
  },
})
