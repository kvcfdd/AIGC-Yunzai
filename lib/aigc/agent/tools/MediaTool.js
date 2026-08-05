import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: "查看图片或视频内容。获取 URL 对应的媒体文件并转码为 data URI 供视觉分析。支持 http/https URL 和 data URI (pixiv 图片 (i.pximg.net) 会自动添加 Referer + 走代理绕过防盗链)。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "媒体 URL (http/https 或 data URI)" },
      type: { type: "string", enum: ["image", "video"], description: "媒体类型，默认 image" },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const result = await tools.execute("fetch_media", args, { user_id: ctx.userId })
    if (result.error) return `获取失败: ${result.error}`
    return result.result
  },
})
