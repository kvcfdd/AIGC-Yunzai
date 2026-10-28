import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath, writeFileAtomic } from "../workspace.js"

tools.register({
  name: "edit",
  description: "Edit an existing UTF-8 text file by replacing literal text; read the file first so old_string matches exactly.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to edit, relative to the project root.",
      },
      old_string: {
        type: "string",
        description: "Literal text to replace.",
      },
      new_string: {
        type: "string",
        description: "Replacement text; empty string deletes the match.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all matches. Defaults to false; when false, old_string must be unique.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG

    const { file_path, old_string, new_string, replace_all = false } = args
    if (typeof file_path !== "string" || file_path.trim().length === 0) throw new Error("file_path must be a non-empty string")
    if (typeof old_string !== "string" || old_string.length === 0) throw new Error("old_string must be a non-empty string")
    if (typeof new_string !== "string") throw new Error("new_string must be a string")
    if (old_string === new_string) throw new Error("old_string and new_string must differ")

    const abs = resolveWorkspacePath(file_path)
    let content
    try {
      content = await fs.readFile(abs, "utf8")
    } catch {
      throw new Error(`cannot edit "${file_path}": not found`)
    }

    const count = content.split(old_string).length - 1
    if (count === 0) throw new Error(`cannot edit "${file_path}": old_string not found`)
    if (count > 1 && !replace_all) throw new Error(`cannot edit "${file_path}": old_string appears ${count} times; provide more context or set replace_all=true`)

    let next
    if (replace_all) {
      next = content.split(old_string).join(new_string)
    } else {
      const idx = content.indexOf(old_string)
      next = content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
    }
    await writeFileAtomic(abs, next)

    return replace_all ? `The file ${abs} has been updated. All occurrences were successfully replaced.` : `The file ${abs} has been updated successfully.`
  },
})
