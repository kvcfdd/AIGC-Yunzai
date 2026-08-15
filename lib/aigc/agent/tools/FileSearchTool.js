import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"
import { globToRegExp, resolvePath, SKIP_DIRS } from "./utils.js"

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 单文件 > 5MB 跳过
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

async function walk(dir, pattern, globRe, root, results, limit, seen, context) {
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
      await walk(full, pattern, globRe, root, results, limit, seen, context)
    } else if (e.isFile()) {
      if (globRe && !globRe.test(path.relative(root, full).split(path.sep).join("/"))) continue
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
          const start = Math.max(0, i - context)
          const end = Math.min(lines.length - 1, i + context)
          const block = []
          for (let j = start; j <= end; j++) {
            block.push(context > 0 ? `${j + 1}: ${lines[j].trim().slice(0, 200)}` : lines[j].trim().slice(0, 200))
          }
          results.push({ file: full, line: i + 1, text: block.join("\n") })
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
- pattern 是正则表达式字符串 (如 "function\\s+\\w+|<div class=\"card\"")，默认不区分大小写，case_sensitive: true 区分大小写
- glob 按文件名模式过滤搜索范围 (如 "*.js"、"src/**/*.ts")，文件多时先缩小范围
- 默认搜索 当前目录；path 可指定搜索目录 (绝对路径或相对 当前目录 的路径)
- 结果以绝对路径 "文件:行号" 返回
- context 为匹配行前后各显示的行数 (带行号)，默认 0 只显示匹配行本身
- 找到后用 file_view 查看上下文，用 file_edit 修改`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式，匹配目标文本" },
      path: { type: "string", description: "搜索范围 (绝对路径，或相对 当前目录的相对路径)，默认 当前目录" },
      glob: { type: "string", description: '按文件名模式过滤，如 "*.js"、"src/**/*.ts"，可选' },
      case_sensitive: { type: "boolean", description: "true=区分大小写，默认 false 不区分" },
      limit: { type: "number", description: `最多返回匹配条数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
      context: { type: "number", description: "匹配行前后各显示的行数 (带行号)，默认 0，最大 5" },
    },
    required: ["pattern"],
  },

  execute: async (args, ctx) => {
    const { pattern: patternStr, path: searchPath, glob, case_sensitive = false, limit = DEFAULT_LIMIT, context = 0 } = args
    if (!patternStr) return "请提供搜索模式 (pattern)"

    let pattern
    try {
      pattern = new RegExp(patternStr, case_sensitive ? "" : "i")
    } catch (err) {
      return `正则表达式无效: ${err.message}`
    }
    let globRe
    if (glob) {
      try {
        globRe = globToRegExp(String(glob))
      } catch (err) {
        return `glob 模式无效: ${err.message}`
      }
    }
    const root = searchPath ? resolvePath(searchPath) : process.cwd()
    const maxLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const maxContext = Math.min(Math.max(Math.floor(Number(context) || 0), 0), 5)

    const results = []
    const seen = new Set()
    try {
      await walk(root, pattern, globRe, root, results, maxLimit, seen, maxContext)
    } catch {}

    if (!results.length) return `未找到匹配 "${patternStr}" (搜索范围: ${root})`

    const lines = results.map(r => (maxContext > 0 ? `${r.file}:${r.line}:\n${r.text}` : `${r.file}:${r.line}: ${r.text}`))
    const suffix = results.length >= maxLimit ? `\n...(已达到上限 ${maxLimit} 条，可用更精确的模式缩小范围)` : ""
    return `找到 ${results.length} 处匹配 "${patternStr}":\n\n${lines.join("\n")}${suffix}`
  },
})
