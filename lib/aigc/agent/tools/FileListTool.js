import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"

/** 递归扫描时跳过的目录 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache", "target", ".bg"])
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

function resolvePath(p, ctx) {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p)
}

/** glob → 正则: 星号不跨目录, 双星号任意深度, 问号单字符
 *  双星号加斜杠作为前缀时可省略 — 让 "双星-斜杠-星号" 也能匹配根目录文件 */
function globToRegExp(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2
        } else {
          re += ".*"
          i++
        }
      } else {
        re += "[^/\\\\]*"
      }
    } else if (c === "?") {
      re += "[^/\\\\]"
    } else if ("\\^$+{}[]()|.".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp("^" + re + "$")
}

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
  description: `按文件名模式列出文件 — 快速找到目录下的文件，不读取内容。

用于: 确认工作区有哪些文件、按扩展名/名称找文件 (如 "*.py"、"**/*.md"、"report*")。

说明:
- pattern 是 glob 模式: * 匹配单层内任意 (不跨目录)，** 匹配任意深度，? 匹配单字符
- 默认搜索 当前目录；可用 path 限定范围。文件路径一律使用绝对路径
- 目录本身也会列出 (以 / 结尾)
- 找到文件后用 file_view 查看、file_edit 修改`,
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
    const root = searchPath ? resolvePath(searchPath, ctx) : process.cwd()
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
