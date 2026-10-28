import fs from "node:fs/promises"
import path from "node:path"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath, writeFileAtomic } from "../workspace.js"

tools.register({
  name: "write",
  description: "Create or fully replace a UTF-8 text file; parent directories are created automatically. Prefer edit for targeted changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to write, relative to the project root.",
      },
      content: {
        type: "string",
        description: "Full UTF-8 text content to write.",
      },
    },
    required: ["file_path", "content"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG

    const { file_path, content } = args
    if (typeof file_path !== "string" || file_path.trim().length === 0) throw new Error("file_path must be a non-empty string")
    if (typeof content !== "string") throw new Error("content must be a string")

    const abs = resolveWorkspacePath(file_path)
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
