import fs from "node:fs/promises"
import path from "node:path"

const TREE_MAX_ENTRIES = 200 // 默认最多展示条目
const TREE_MAX_DEPTH = 6 // 默认最大深度
export const SKIP_DIRS = new Set(["node_modules", ".git"])

/** 目录 → 相对路径文本树；跳过隐藏项与依赖/版本库目录 */
export async function buildFileTree(root, { maxEntries = TREE_MAX_ENTRIES, maxDepth = TREE_MAX_DEPTH } = {}) {
  const lines = []
  let count = 0
  let truncated = false

  async function walk(dir, prefix, depth) {
    if (depth > maxDepth) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries = entries.filter(e => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

    for (let i = 0; i < entries.length; i++) {
      if (count >= maxEntries) {
        truncated = true
        return
      }
      const entry = entries[i]
      const last = i === entries.length - 1
      const branch = last ? "└── " : "├── "
      lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? "/" : ""}`)
      count++
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${last ? "    " : "│   "}`, depth + 1)
    }
  }

  await walk(root, "", 0)
  if (truncated) lines.push(`…(文件过多，仅显示前 ${maxEntries} 项)`)
  return lines.join("\n")
}
