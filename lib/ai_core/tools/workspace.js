import fs from "node:fs/promises"
import path from "node:path"

/** 动作工具的工作目录 — 固定为 bot 项目根目录 */
export const WORKSPACE_ROOT = path.resolve(process.cwd())

/** 动作工具仅 bot owner (master) 可用 */
export const MASTER_ONLY_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "pwsh", "bash"])

export function isMaster(ctx) {
  return !!ctx?.event?.isMaster
}

export const NON_MASTER_MSG = "权限不足：该工具仅 bot owner (master) 可用"

/** 相对/绝对路径 → 工作区内绝对路径；越界抛错 */
export function resolveWorkspacePath(input, { allowRoot = false } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path must be a non-empty string")
  const abs = path.resolve(WORKSPACE_ROOT, input)
  const rel = path.relative(WORKSPACE_ROOT, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes the project directory: ${input}`)
  if (!allowRoot && rel === "") throw new Error(`refusing to operate on the project root: ${input}`)
  return abs
}

/** 绝对路径 → 项目内相对路径（统一 / 分隔） */
export function displayPath(abs) {
  const rel = path.relative(WORKSPACE_ROOT, abs)
  return (rel || ".").split(path.sep).join("/")
}

/** 原子写入；保留原文件权限位，Windows 上 rename 覆盖失败时退化为删除后重命名 */
export async function writeFileAtomic(abs, content) {
  let mode
  try {
    mode = (await fs.stat(abs)).mode
  } catch {
    /* new file */
  }

  const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`
  await fs.writeFile(tmp, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) })
  try {
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(abs, { force: true }).catch(() => {})
    await fs.rename(tmp, abs)
  }
}

/** 输出尾部截断 — 保留最后 maxBytes 字节，并保证 UTF-8 边界 */
export function tailBytes(text, maxBytes = 64_000) {
  const s = String(text ?? "")
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return { text: s, truncated: false }
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return { text: buf.subarray(start).toString("utf8"), truncated: true }
}

/** 完整输出落盘到 temp/tool-output，返回项目内相对路径 */
export async function spillStream(name, text) {
  const dir = path.join(WORKSPACE_ROOT, "temp", "tool-output")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now().toString(36)}-${process.pid}-${name}.log`)
  await fs.writeFile(file, text, "utf8")
  return displayPath(file)
}
