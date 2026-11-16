import fs from "node:fs/promises"
import path from "node:path"

/** 动作工具的工作目录 — 固定为 bot 项目根目录 */
export const WORKSPACE_ROOT = path.resolve(process.cwd())

/** 仅 master 可执行的工具；工具对所有用户可见，执行时由 ToolRegistry 统一校验 */
export const MASTER_ONLY_TOOLS = new Set(["pwsh", "bash"])

export function isMaster(ctx) {
  return !!ctx?.event?.isMaster
}

export const NON_MASTER_MSG = "权限不足：用户未经授权，该工具仅 master 可执行"

/** 普通用户可读写的目录，与媒体工具共用 */
export const NON_MASTER_DIRS = ["data/aigc/chat", "data/aigc/tmp", "temp", "skills", "data/skills"]

/** 非 master 只读目录：在可读写目录之外，额外允许读取插件静态资源 */
export const NON_MASTER_READ_DIRS = [...NON_MASTER_DIRS, "plugins/miao-plugin/resources"]

/** 绝对路径是否位于指定目录列表内 */
function isUnderDirs(abs, dirs) {
  for (const dir of dirs) {
    const rel = path.relative(path.resolve(WORKSPACE_ROOT, dir), abs)
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true
  }
  return false
}

/** 绝对路径是否位于普通用户可访问目录 */
export function isUnderNonMasterDir(abs) {
  return isUnderDirs(abs, NON_MASTER_DIRS)
}

/** 绝对路径是否位于普通用户可读取目录 */
export function isUnderNonMasterReadDir(abs) {
  return isUnderDirs(abs, NON_MASTER_READ_DIRS)
}

/** 相对/绝对路径 → 工作区内绝对路径；越界抛错 */
export function resolveWorkspacePath(input, { allowRoot = false } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path must be a non-empty string")
  const abs = path.resolve(WORKSPACE_ROOT, input)
  const rel = path.relative(WORKSPACE_ROOT, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes the project directory: ${input}`)
  if (!allowRoot && rel === "") throw new Error(`refusing to operate on the project root: ${input}`)
  return abs
}

/** 带权限的路径解析：master 不受目录限制，普通用户仅限 NON_MASTER_DIRS */
export function resolveAccessiblePath(ctx, input, opts) {
  const abs = resolveWorkspacePath(input, opts)
  if (!isMaster(ctx) && !isUnderNonMasterDir(abs)) throw new Error(`用户权限不足：非 master 仅允许访问 ${NON_MASTER_DIRS.join("、")} 下的路径: ${input}`)
  return abs
}

/** 只读路径解析：普通用户可在 NON_MASTER_READ_DIRS 内读取 */
export function resolveReadablePath(ctx, input, opts) {
  const abs = resolveWorkspacePath(input, opts)
  if (!isMaster(ctx) && !isUnderNonMasterReadDir(abs)) throw new Error(`用户权限不足：非 master 仅允许读取 ${NON_MASTER_READ_DIRS.join("、")} 下的路径: ${input}`)
  return abs
}

/** 搜索根目录：master 搜索整个工作区；非 master 未指定路径时只搜索可读写目录 */
export function resolveSearchRoots(ctx, input) {
  if (isMaster(ctx)) return [resolveWorkspacePath(input || ".", { allowRoot: true })]
  if (typeof input === "string" && input.trim()) return [resolveReadablePath(ctx, input, { allowRoot: true })]
  return NON_MASTER_DIRS.map(dir => path.resolve(WORKSPACE_ROOT, dir))
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
