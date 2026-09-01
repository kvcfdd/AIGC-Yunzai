import fs from "node:fs/promises"
import path from "node:path"
import cfg from "../../config/config.js"

const AGENT_DIR = path.resolve("data/aigc/agent")

/** 全局知识库: 所有 Agent 任务共享，位于项目根目录，bash 工具维护，启动时注入索引，正文经 knowledge 工具按需读取 */
const KNOWLEDGE_FILE = path.resolve("knowledge.md")
const INDEX_MAX_CHARS = 4000 // 注入索引的总预算
const DESC_MAX = 100 // 摘要单行截断长度
const BODY_MAX = 12 * 1024 // 单条目正文大小上限

/** 条目分隔: ## 标题 */
const ENTRY_RE = /^##\s+(.+)$/gm

/** 解析 knowledge.md 为条目数组 [{ title, summary, body }] */
async function parseKnowledge() {
  let raw
  try {
    raw = await fs.readFile(KNOWLEDGE_FILE, "utf-8")
  } catch {
    return []
  }
  if (!raw.trim()) return []

  const matches = [...raw.matchAll(ENTRY_RE)]
  if (!matches.length) return [] // 无 ## 条目视为空知识库

  const entries = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length
    const title = matches[i][1].trim()
    // 正文去掉标题行本身, 避免与条目标题重复
    const body = raw
      .slice(start, end)
      .replace(/^##\s+.*(?:\r?\n|$)/, "")
      .trim()
    if (!body) continue
    // 摘要: "- 摘要: xxx" 行; 无则取正文首个非空非标题行
    const sumMatch = body.match(/^[-*]\s*摘要[:：]\s*(.+)$/m)
    const fallback = body.split("\n").find(l => l.trim() && !l.trim().startsWith("#"))
    const summary = (sumMatch?.[1] || fallback || "").trim().slice(0, DESC_MAX)
    entries.push({ title, summary, body: body.slice(0, BODY_MAX) })
  }
  return entries
}

/** 知识库索引，供 runner 注入系统提示词；无条目返回 null */
async function loadKnowledgeIndex() {
  const entries = await parseKnowledge()
  if (!entries.length) return null
  let index = ""
  for (const e of entries) {
    const line = `- ${e.title}${e.summary ? `: ${e.summary}` : ""}`
    if (index.length + line.length + 1 > INDEX_MAX_CHARS) break
    index += line + "\n"
  }
  return index.trim() || null
}

/** 按主题匹配知识条目，返回匹配条目的完整正文；无匹配返回 null */
async function searchKnowledge(topic) {
  const t = String(topic || "")
    .trim()
    .toLowerCase()
  if (!t) return null
  const entries = await parseKnowledge()
  const hit = entries.filter(e => e.title.toLowerCase().includes(t) || e.summary.toLowerCase().includes(t) || e.body.slice(0, 500).toLowerCase().includes(t))
  if (!hit.length) return null
  return hit.map(e => `## ${e.title}\n${e.body}`).join("\n\n")
}

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

    const maxFileBytes = (cfg.agent?.workspace_max_file_mb || 50) * 1024 * 1024
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
      throw new Error(`文件过大 (${(size / 1024 / 1024).toFixed(1)}MB)，上限 ${cfg.agent?.workspace_max_file_mb || 50}MB`)
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
    const maxTotal = (cfg.agent?.workspace_max_total_mb || 200) * 1024 * 1024
    const files = await this.listFiles()
    const total = files.reduce((sum, f) => sum + f.size, 0)
    return { total, max: maxTotal, ok: total < maxTotal }
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

export { WorkspaceManager, AGENT_DIR, loadKnowledgeIndex, searchKnowledge }
