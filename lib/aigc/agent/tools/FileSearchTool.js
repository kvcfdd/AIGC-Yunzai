import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"

/** 递归扫描时跳过的目录 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache", "target"])
const MAX_FILE_BYTES = 1024 * 1024 // 单文件 > 1MB 跳过
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function resolvePath(p, ctx) {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(ctx.workspace?.dir || process.cwd(), p)
}

async function walk(dir, pattern, results, limit, seen) {
  if (results.length >= limit) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (results.length >= limit) return
    const full = path.join(dir, e.name)
    let real
    try {
      real = await fs.realpath(full)
    } catch {
      continue
    }
    if (seen.has(real)) continue // 防符号链接循环
    seen.add(real)

    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await walk(full, pattern, results, limit, seen)
    } else if (e.isFile() && !e.name.startsWith("__deliver__")) {
      try {
        const stat = await fs.stat(full)
        if (stat.size > MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      let content
      try {
        content = await fs.readFile(full, "utf-8")
      } catch {
        continue // 二进制/乱码文件跳过
      }
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0
        if (pattern.test(lines[i])) {
          results.push({ file: full, line: i + 1, text: lines[i].trim() })
          if (results.length >= limit) return
        }
      }
    }
  }
}

agentTools.register({
  name: "file_search",
  description: `结构化代码/文本搜索 — 在目录中递归查找匹配行，返回 文件:行号 定位。

用于: 定位函数/变量定义、查找引用、确认某段文本是否存在。

说明:
- pattern 是正则表达式字符串 (如 "function\\s+\\w+|<div class=\"card\"")，不区分大小写
- 默认搜索整个任务工作区；可用 path 限定子目录或指定文件
- 自动跳过 node_modules/.git/构建目录 与大于 1MB 的文件
- 找到后用 file_view 查看上下文，用 file_edit 修改`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式，匹配目标文本" },
      path: { type: "string", description: "搜索范围 (绝对路径或相对工作区路径)，默认工作区根目录" },
      limit: { type: "number", description: `最多返回条数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
    },
    required: ["pattern"],
  },

  execute: async (args, ctx) => {
    const { pattern: patternStr, path: searchPath, limit = DEFAULT_LIMIT } = args
    if (!patternStr) return "请提供搜索模式 (pattern)"

    let pattern
    try {
      pattern = new RegExp(patternStr, "i")
    } catch (err) {
      return `正则表达式无效: ${err.message}`
    }
    const root = searchPath ? resolvePath(searchPath, ctx) : ctx.workspace?.dir || process.cwd()
    const maxLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)

    const results = []
    const seen = new Set()
    try {
      await walk(root, pattern, results, maxLimit, seen)
    } catch {}

    if (!results.length) return `未找到匹配 "${patternStr}" (搜索范围: ${root})`

    const lines = results.map(r => `${r.file}:${r.line}: ${r.text.slice(0, 200)}`)
    const suffix = results.length >= maxLimit ? `\n...(已达到上限 ${maxLimit} 条，可用更精确的模式缩小范围)` : ""
    return `找到 ${results.length} 处匹配 "${patternStr}":\n\n${lines.join("\n")}${suffix}`
  },
})
