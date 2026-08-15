import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"
import log from "../../helpers/log.js"
import { resolvePath } from "./utils.js"

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 单次写入上限 10MB

agentTools.register({
  name: "file_write",
  description: `新建/整体覆盖项目文件 — 一次性写入完整内容。与 file_edit 分工: 新文件或需大幅重写的文件用本工具，局部修改用 file_edit。

说明:
- 自动创建缺失的父目录
- 覆盖已有文件会清空旧内容，局部修改请用 file_edit
- 任务工作区内的产物用 workspace 工具 (工作区相对路径)，本工具针对项目文件
- 写入超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的内容会被拒绝，大文件请分次或改用 bash`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径 (绝对路径，或相对 当前目录的相对路径)" },
      content: { type: "string", description: "完整文件内容" },
    },
    required: ["file", "content"],
  },

  execute: async (args, ctx) => {
    const { file, content } = args
    if (!file) return "请提供文件路径 (file)"
    if (typeof content !== "string") return "请提供文件内容 (content)"

    const buf = Buffer.from(content, "utf-8")
    if (buf.length > MAX_FILE_BYTES) {
      return `内容过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限，请分次或改用 bash`
    }

    const filepath = resolvePath(file)
    try {
      await fs.mkdir(path.dirname(filepath), { recursive: true })
      await fs.writeFile(filepath, content, "utf-8")
    } catch (err) {
      return `写入失败: ${err.message}`
    }

    log.info(`[Agent-FileWrite] ${filepath} (${(buf.length / 1024).toFixed(1)}KB)`)
    return `已写入: ${filepath} (${(buf.length / 1024).toFixed(1)}KB)。可用 file_view 验证，局部修改用 file_edit。`
  },
})
