import fs from "node:fs/promises"
import path from "node:path"

/** 递归遍历时跳过的目录：依赖与版本库元数据 */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", ".bzr", ".jj", ".sl"])

/** glob 匹配：无 "/" 的模式匹配任意深度的 basename */
export function matchesGlob(rel, pattern) {
  const posix = rel.split(path.sep).join("/")
  const normalized = String(pattern).replaceAll("\\", "/")
  return normalized.includes("/") ? path.matchesGlob(posix, normalized) : path.matchesGlob(path.posix.basename(posix), normalized)
}

/**
 * 递归遍历文件（包含隐藏文件），跳过 SKIP_DIRS。
 * onFile 接收绝对路径与相对 root 的路径；返回 { seen, stopped }。
 */
export async function walkFiles(root, { onFile, maxFiles = 10_000, skipDirs = SKIP_DIRS } = {}) {
  let seen = 0
  let stopped = false

  async function walk(dir) {
    if (stopped) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (stopped) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(abs)
      } else if (entry.isFile()) {
        seen++
        if (seen > maxFiles) {
          stopped = true
          return
        }
        await onFile(abs, path.relative(root, abs))
      }
    }
  }

  await walk(root)
  return { seen: Math.min(seen, maxFiles), stopped }
}
