import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: `多模态识别工具：可获取图片/视频/音频/常规文件(如xx.js)的内联编码供你查看对应内容，支持从 http/https URL、data URI、本地文件的绝对路径或基于bot项目当前目录的相对路径获取。

  提示: 图片文件 https URL 来自pixiv时会自动处理防盗链`,
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "来源：http/https URL、data URI、本地绝对路径或基于bot项目当前目录的相对路径。" },
      type: {
        type: "string",
        enum: ["image", "video", "audio", "file"],
        description: "可选：显式指定文件类型，指定后按该类型编码，不指定则按文件内容自动识别。",
      },
    },
    required: ["source"],
  },
  execute: async (args, ctx) => {
    const { source, type } = args
    const result = await tools.execute("fetch_media", { source, type }, { user_id: ctx.userId })
    if (result.error) return `获取失败: ${result.error}`
    return result.result
  },
})
