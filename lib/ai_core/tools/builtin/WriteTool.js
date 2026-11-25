import fs from "node:fs/promises"
import path from "node:path"
import tools from "../tool-registry.js"
import { resolveAccessiblePath, writeFileAtomic } from "../workspace.js"

tools.register({
  name: "write",
  description: "创建或覆盖写入文本文件",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "文件路径",
      },
      content: {
        type: "string",
        description: "文件内容",
      },
    },
    required: ["file_path", "content"],
  },
  execute: async (args, ctx) => {
    const { file_path, content } = args
    if (typeof file_path !== "string" || file_path.trim().length === 0) throw new Error("file_path must be a non-empty string")
    if (typeof content !== "string") throw new Error("content must be a string")

    const abs = resolveAccessiblePath(ctx, file_path)
    let operation = "create"
    try {
      await fs.access(abs)
      operation = "update"
    } catch {
      /* new file */
    }

    await fs.mkdir(path.dirname(abs), { recursive: true })
    await writeFileAtomic(abs, content)

    const verb = operation === "create" ? "Created file" : "Updated file"
    return `<path>${abs}</path>\n<type>file</type>\n<content>\n${verb}\n</content>`
  },
})
