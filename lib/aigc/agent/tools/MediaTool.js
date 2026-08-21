import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: `查看媒体内容 — 获取 URL 或本地路径对应的图片/视频/音频/文档并转码为模型输入，类型按文件内容自动识别。

- 媒体来源: http/https URL 或 data URI 或本地路径
- 需要原生读懂的 PDF/docx 文档及语音/视频
- 普通文本/代码/截图文件请用 file_view`,
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
