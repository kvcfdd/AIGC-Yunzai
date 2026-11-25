import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { resolveAccessiblePath, writeFileAtomic } from "../workspace.js"

tools.register({
  name: "edit",
  description: "修改文本文件：把 old_string 替换为 new_string",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "文件路径",
      },
      old_string: {
        type: "string",
        description: "要替换的原文本",
      },
      new_string: {
        type: "string",
        description: "替换后的文本，留空即删除",
      },
      replace_all: {
        type: "boolean",
        description: "替换全部匹配，默认 false",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async (args, ctx) => {
    const { file_path, old_string, new_string, replace_all = false } = args
    if (typeof file_path !== "string" || file_path.trim().length === 0) throw new Error("file_path must be a non-empty string")
    if (typeof old_string !== "string" || old_string.length === 0) throw new Error("old_string must be a non-empty string")
    if (typeof new_string !== "string") throw new Error("new_string must be a string")
    if (old_string === new_string) throw new Error("old_string and new_string must differ")

    const abs = resolveAccessiblePath(ctx, file_path)
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
