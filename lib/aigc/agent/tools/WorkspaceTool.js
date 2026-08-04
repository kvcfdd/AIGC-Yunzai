import agentTools from "../registry.js"

agentTools.register({
  name: "workspace",
  description: `读写 Agent 任务工作区文件。所有任务中间产物都应该存在工作区中。

操作:
- read: 读取文件内容 (支持 utf-8 和 base64)
- write: 写入文件 (支持 utf-8 文本和 base64 二进制)
- list: 列出工作区所有文件及大小

写入的文件后续可用 ctrl.deliver 标记为交付文件，由主模型发送给用户。`,

  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write", "list"], description: "操作类型" },
      filename: { type: "string", description: "文件名 (read/write 必填)，仅允许纯文件名" },
      content: { type: "string", description: "文件内容 (write 必填)。文本内容直接传，二进制内容传 base64 并设置 encoding=base64" },
      encoding: { type: "string", enum: ["utf-8", "base64"], description: "编码方式。read 时默认 utf-8；write 时默认 utf-8，二进制内容用 base64" },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, filename, content, encoding } = args
    const ws = ctx.workspace

    if (action === "list") {
      const files = await ws.listFiles()
      if (!files.length) return "工作区为空"
      const lines = files.map(f => `- ${f.name} (${(f.size / 1024).toFixed(1)}KB, ${new Date(f.mtime).toISOString()})`)
      return `工作区文件 (${files.length}):\n${lines.join("\n")}`
    }

    if (action === "read") {
      if (!filename) return "请提供文件名"
      try {
        return await ws.readFile(filename, encoding || "utf-8")
      } catch (err) {
        return `读取失败: ${err.message}`
      }
    }

    if (action === "write") {
      if (!filename || content === undefined) return "请提供 filename 和 content"
      try {
        const result = await ws.writeFile(filename, content, encoding || "utf-8")
        return `已写入: ${result.path} (${(result.size / 1024).toFixed(1)}KB)`
      } catch (err) {
        return `写入失败: ${err.message}`
      }
    }

    return `未知操作: ${action}`
  },
})
