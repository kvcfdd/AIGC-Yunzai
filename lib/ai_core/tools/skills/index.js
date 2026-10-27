import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { buildFileTree, SKIP_DIRS } from "../../helpers/file-tree.js"

const LIST_TTL = 60_000 // 列表缓存 60s
const DESC_MAX = 100 // 描述单行截断长度
const BODY_MAX = 16 * 1024 // 正文大小上限
const LIST_MAX = 4000 // 提示词列表块总预算

/** 用户技能目录 — 每个 <name>/SKILL.md 即一个技能 */
export const SKILLS_ROOT = "data/skills"

/** frontmatter 与 BOM 剥离正则 */
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export class SkillStore {
  constructor(root = SKILLS_ROOT) {
    this.root = path.resolve(root)
    this._cache = null
  }

  /** 技能列表 [{ name, description, tools, file, dir }]，60s TTL 缓存 */
  async list() {
    if (this._cache && Date.now() - this._cache.t < LIST_TTL) return this._cache.list

    let dirs
    try {
      dirs = await fs.readdir(this.root, { withFileTypes: true })
    } catch {
      dirs = [] // 根目录不存在 → 视为无技能
    }

    const list = []
    await Promise.all(
      dirs
        .filter(i => i.isDirectory() && !i.name.startsWith(".") && !SKIP_DIRS.has(i.name))
        .map(async dir => {
          const skillDir = path.join(this.root, dir.name)
          const file = path.join(skillDir, "SKILL.md")
          let content
          try {
            content = await fs.readFile(file, "utf8")
          } catch {
            return // 无 SKILL.md 的目录跳过
          }
          list.push(this.parseSkill(dir.name, content, file, skillDir))
        }),
    )

    list.sort((a, b) => a.name.localeCompare(b.name))
    this._cache = { t: Date.now(), list }
    return list
  }

  /** 解析 SKILL.md：frontmatter(name/description/tools) + 正文；无 frontmatter 回退目录名/首行 */
  parseSkill(dirName, content, file, dir = path.dirname(file)) {
    content = content.replace(/^﻿/, "")

    const fm = content.match(FRONT_RE)
    let name = dirName
    let description = ""
    let tools = []
    if (fm) {
      try {
        const meta = YAML.parse(fm[1])
        if (typeof meta?.name === "string" && meta.name.trim()) name = meta.name.trim()
        if (typeof meta?.description === "string") description = meta.description
        const t = meta?.tools ?? meta?.["allowed-tools"]
        if (Array.isArray(t)) tools = t.filter(i => typeof i === "string" && i.trim()).map(i => i.trim())
        else if (typeof t === "string" && t.trim()) tools = t.split(/[,\s]+/).filter(Boolean)
      } catch {
        /* frontmatter 非法 → 走回退 */
      }
    }

    if (!description) {
      const body = fm ? content.slice(fm[0].length) : content
      description =
        body
          .split("\n")
          .find(line => line.trim())
          ?.trim() || ""
    }
    if (!description) description = name

    description = description.replace(/\s+/g, " ").slice(0, DESC_MAX)
    return { name, description, tools, file, dir }
  }

  /** 按名称读取技能正文 + 技能目录文件树，未命中返回 null */
  async get(name) {
    const skill = (await this.list()).find(i => i.name === name)
    if (!skill) return null

    let content
    try {
      content = await fs.readFile(skill.file, "utf8")
    } catch {
      return null
    }
    content = content.replace(/^﻿/, "").replace(FRONT_RE, "").trim()
    if (content.length > BODY_MAX) content = `${content.slice(0, BODY_MAX)}\n…(正文过长已截断)`

    return { ...skill, content, files: await buildFileTree(skill.dir) }
  }
}

/** 用户技能：data/skills 下各目录的 SKILL.md */
export const userSkills = new SkillStore(SKILLS_ROOT)
export default userSkills

/** 技能列表 → 系统提示词块 */
export function skillsListBlock(list) {
  const lines = ["<skills>", "可用技能列表（来自 data/skills）。当任务与某技能描述相关时，先调用 skill 工具查看该技能的正文与文件列表，再按指引执行："]
  let budget = lines.join("\n").length
  let omitted = false

  for (const s of list) {
    const line = `- ${s.name}: ${s.description}`
    if (budget + line.length + 1 > LIST_MAX) {
      omitted = true
      break
    }
    lines.push(line)
    budget += line.length + 1
  }

  if (omitted) lines.push(`…(共 ${list.length} 个技能，其余已省略，可通过 skill 工具按名称查看)`)
  lines.push("</skills>")
  return lines.join("\n")
}
