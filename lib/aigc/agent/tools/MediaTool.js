import agentTools from "../registry.js"
import tools from "../../tools/registry.js"

agentTools.register({
  name: "media",
  description: `查看媒体内容 — 获取 URL 或本地路径对应的图片/视频/音频/文档并转码为模型输入供分析，类型按文件内容自动识别。

用于:
- 网络媒体: 搜索结果里的图片、视频封面等 http/https URL 或 data URI
- 对话历史媒体: 主模型 goal 中给出的 [图片]/[视频]/[语音]/[文件] 标记路径 (如 data/aigc/chat/xxx) — 直接传路径即可
- 需要原生读懂的 PDF/docx 等文档，以及语音/视频内容

注意:
- 工作区/项目里的普通文件 (文本、代码、截图) 请用 file_view 查看 (带行号分页，便于 file_edit 定位修改)
- pixiv 图片 (i.pximg.net) 自动添加 Referer + 走代理绕过防盗链`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "媒体 URL (http/https , data URI 或本地文件路径)" },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url } = args
    const result = await tools.execute("fetch_media", { url }, { user_id: ctx.userId })
    if (result.error) return `获取失败: ${result.error}`
    return result.result
  },
})
