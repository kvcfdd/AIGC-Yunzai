import agentTools from "../registry.js"

agentTools.register({
  name: "workspace",
  description: `读写任务工作区文件。read 读取、write 写入 (自动创建子目录)、list 列出所有文件及大小。

- filename 为工作区内相对路径 (如 "src/utils.js")，仅限工作区内
- 支持 utf-8 文本与 base64 二进制`,

  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write", "list"], description: "操作类型" },
      filename: { type: "string", description: "文件路径 (read/write 必填)。支持相对子路径如 src/utils.js，仅限工作区内" },
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
