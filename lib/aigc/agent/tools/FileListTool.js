import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"
import { globToRegExp, resolvePath, SKIP_DIRS } from "./utils.js"

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

async function walk(dir, re, root, results, limit, seen) {
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

    const rel = path.relative(root, full).split(path.sep).join("/")
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (re.test(rel + "/")) results.push(rel + "/")
      await walk(full, re, root, results, limit, seen)
    } else if (e.isFile()) {
      if (re.test(rel)) results.push(rel)
    }
  }
}

agentTools.register({
  name: "file_list",
  description: `按文件名模式列出文件 — 不读取内容。pattern 为 glob 模式 (* 不跨目录，** 匹配任意深度)。

- 默认搜索 当前目录，path 可指定搜索目录
- 结果为相对搜索范围的路径，其他工具使用时需拼上搜索范围；目录以 / 结尾`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'glob 模式，如 "*.js"、"**/*.md"、"data_*.csv"' },
      path: { type: "string", description: "搜索范围 (绝对路径，或相对 当前目录的相对路径)，默认 当前目录" },
      limit: { type: "number", description: `最多返回条数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
    },
    required: ["pattern"],
  },

  execute: async (args, ctx) => {
    const { pattern, path: searchPath, limit = DEFAULT_LIMIT } = args
    if (!pattern) return "请提供 glob 模式 (pattern)"

    let re
    try {
      re = globToRegExp(String(pattern))
    } catch (err) {
      return `glob 模式无效: ${err.message}`
    }
    const root = searchPath ? resolvePath(searchPath) : process.cwd()
    const maxLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)

    const results = []
    const seen = new Set()
    try {
      await walk(root, re, root, results, maxLimit, seen)
    } catch {}

    if (!results.length) return `未找到匹配 "${pattern}" 的文件 (搜索范围: ${root})`

    const suffix = results.length >= maxLimit ? `\n...(已达到上限 ${maxLimit} 条，可缩小模式范围)` : ""
    return `匹配 "${pattern}" 的文件 (${results.length} 条):\n${results.join("\n")}${suffix}`
  },
})
