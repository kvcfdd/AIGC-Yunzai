import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: `将图片/视频/音频/文档内容并转为模型可直接理解的多模态输入，类型按文件内容自动识别。

- 图片: 压缩后作为视觉输入
- PDF/docx 等文档: 原生文档解析，支持版式、表格、中文
- 视频/音频: 转码后输入
- 来源: http/https URL、data URI、本地文件路径；也可用 type 参数显式指定类型`,
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "媒体来源 (http/https URL、data URI 或本地文件路径)" },
      type: {
        type: "string",
        enum: ["image", "video", "audio", "file"],
        description: "可选：显式指定媒体类型。指定后按该类型编码，不再自动识别；不指定则按文件内容自动识别。",
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
