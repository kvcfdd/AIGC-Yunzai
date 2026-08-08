import fs from "node:fs/promises"
import path from "node:path"
import cfg from "../../config/config.js"
import log from "../helpers/log.js"

const AGENT_DIR = path.resolve("data/aigc/agent")

class WorkspaceManager {
  constructor(taskId) {
    this.taskId = taskId
    this.dir = path.join(AGENT_DIR, taskId)
  }

  /** 确保工作区目录存在 */
  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true })
    return this.dir
  }

  /** 读取文件内容，支持文本和 base64 */
  async readFile(filename, encoding = "utf-8") {
    this._validatePath(filename)
    const filepath = path.join(this.dir, filename)
    try {
      if (encoding === "base64") {
        const buf = await fs.readFile(filepath)
        return buf.toString("base64")
      }
      return await fs.readFile(filepath, "utf-8")
    } catch (err) {
      throw new Error(`读取文件失败 ${filename}: ${err.message}`)
    }
  }

  /** 写入文件，支持文本和 base64 二进制 */
  async writeFile(filename, content, encoding = "utf-8") {
    this._validatePath(filename)
    await this.ensureDir()

    const maxFileBytes = (cfg.aigc?.agent?.workspace_max_file_mb || 50) * 1024 * 1024
    const filepath = path.join(this.dir, filename)
    await fs.mkdir(path.dirname(filepath), { recursive: true }) // 支持相对子路径自动建目录

    let buf, size
    if (encoding === "base64") {
      buf = Buffer.from(String(content), "base64")
      size = buf.length
    } else {
      const contentStr = typeof content === "string" ? content : JSON.stringify(content, null, 2)
      buf = Buffer.from(contentStr, "utf-8")
      size = buf.length
    }

    if (size > maxFileBytes) {
      throw new Error(`文件过大 (${(size / 1024 / 1024).toFixed(1)}MB)，上限 ${cfg.aigc?.agent?.workspace_max_file_mb || 50}MB`)
    }

    await fs.writeFile(filepath, buf)
    return { path: filepath, size }
  }

  /** 列出工作区所有文件 */
  async listFiles() {
    await this.ensureDir()
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true })
      const files = []
      for (const e of entries) {
        if (e.isFile()) {
          const stat = await fs.stat(path.join(this.dir, e.name))
          files.push({ name: e.name, size: stat.size, mtime: stat.mtimeMs })
        }
      }
      return files
    } catch {
      return []
    }
  }

  /** 检查工作区总大小是否超限 */
  async checkQuota() {
    const maxTotal = (cfg.aigc?.agent?.workspace_max_total_mb || 200) * 1024 * 1024
    const files = await this.listFiles()
    const total = files.reduce((sum, f) => sum + f.size, 0)
    return { total, max: maxTotal, ok: total < maxTotal }
  }

  /** 删除工作区 */
  async destroy() {
    try {
      await fs.rm(this.dir, { recursive: true, force: true })
    } catch {
      /* 删除失败不阻塞 */
    }
  }

  _validatePath(filename) {
    if (typeof filename !== "string" || !filename.trim()) throw new Error("文件名无效")
    // 仅允许相对路径: 禁绝对路径, 禁 .. 逃逸与空段
    if (path.isAbsolute(filename)) throw new Error("仅支持相对路径")
    const parts = filename.split(/[\\/]/)
    if (parts.some(p => !p || p === "." || p === "..")) {
      throw new Error("文件名无效，禁止路径穿越")
    }
    if (filename.length > 200) {
      throw new Error("路径过长 (最大 200 字符)")
    }
  }
}

/** 启动时清理过期工作区 */
async function cleanupExpiredWorkspaces() {
  const ttl = cfg.aigc?.agent?.workspace_ttl
  if (!ttl || ttl <= 0) return

  try {
    await fs.mkdir(AGENT_DIR, { recursive: true })
    const entries = await fs.readdir(AGENT_DIR, { withFileTypes: true })
    const now = Date.now()
    let cleaned = 0

    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        const stat = await fs.stat(path.join(AGENT_DIR, e.name))
        if (now - stat.mtimeMs > ttl * 1000) {
          await fs.rm(path.join(AGENT_DIR, e.name), { recursive: true, force: true })
          cleaned++
        }
      } catch {
        /* pass */
      }
    }

    if (cleaned > 0) {
      log.info(`[Agent] 清理 ${cleaned} 个过期工作区 (TTL: ${ttl}s)`)
    }
  } catch {
    /* pass */
  }
}

// 模块加载时清理
await cleanupExpiredWorkspaces()

export { WorkspaceManager, cleanupExpiredWorkspaces, AGENT_DIR }
