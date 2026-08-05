import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "browse",
  description: "浏览指定网页，获取页面正文内容。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要浏览的网页 URL" },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const result = await tools.execute("browse", args, { user_id: ctx.userId })
    if (result.error) return `浏览失败: ${result.error}`
    return result.result
  },
})
