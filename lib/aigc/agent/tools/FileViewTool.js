import agentTools from "../registry.js"
import fs from "node:fs/promises"
import { resolvePath } from "./utils.js"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_FILE_BYTES = 20 * 1024 * 1024 // 单文件 > 20MB 拒绝
const BINARY_CHECK_BYTES = 4096

agentTools.register({
  name: "file_view",
  description: `查看本地文件内容，分页按行返回带行号的内容片段。

- 支持: 源代码、日志、配置等文本文件
- file: 文件路径 (绝对路径，或相对 当前目录的相对路径)
- offset: 起始行号 (1-based)，默认 1
- limit: 每页行数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径 (绝对路径，或相对 当前目录的相对路径)" },
      offset: { type: "number", description: "起始行号 (1-based)，默认 1，仅文本文件生效" },
      limit: { type: "number", description: `每页行数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}，仅文本文件生效` },
    },
    required: ["file"],
  },

  execute: async (args, ctx) => {
    const { file, offset, limit } = args
    if (!file) return "请提供文件路径 (file)"

    const filepath = resolvePath(file)

    let stat
    try {
      stat = await fs.stat(filepath)
    } catch (err) {
      return `文件不存在或不可读: ${err.message}`
    }
    if (!stat.isFile()) return `不是普通文件: ${filepath}`
    if (stat.size > MAX_FILE_BYTES) return `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`

    const buf = await fs.readFile(filepath)
    const head = buf.subarray(0, BINARY_CHECK_BYTES)
    let content
    try {
      content = buf.toString("utf-8")
    } catch (err) {
      return `读取失败: ${err.message}`
    }
    if (head.includes(0)) {
      return `二进制文件 (${(buf.length / 1024).toFixed(1)}KB)，不支持的类型: ${filepath}`
    }

    const start = Math.max(Math.floor(Number(offset) || 1), 1)
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT)
    const lines = content.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    const total = lines.length

    if (total === 0) return `文件为空: ${filepath}`

    const end = Math.min(start + pageSize - 1, total)
    if (start > total) return `起始行 ${start} 超出文件总行数 ${total} (文件: ${filepath})`

    const width = String(end).length
    const body = []
    for (let i = start - 1; i < end; i++) {
      body.push(`${String(i + 1).padStart(width)}: ${lines[i]}`)
    }

    const more = end < total ? `\n... (共 ${total} 行, 已显示 ${start}-${end} 行, 继续查看请设 offset=${end + 1})` : ""
    return `文件: ${filepath}\n共 ${total} 行, 显示 ${start}-${end} 行:\n\n${body.join("\n")}${more}`
  },
})
