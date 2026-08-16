import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

const LIST_TTL = 60_000 // 列表缓存 60s
const DESC_MAX = 100 // 描述单行截断长度
const BODY_MAX = 16 * 1024 // 正文大小上限
const LIST_MAX = 4000 // 提示词列表块总预算

/** frontmatter 与 BOM 剥离正则 */
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export class SkillStore {
  constructor(root) {
    this.root = path.resolve(root)
    this._cache = null
  }

  /** 技能列表 [{ name, description, file }]，60s TTL 缓存 */
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
        .filter(i => i.isDirectory() && !i.name.startsWith(".") && i.name !== "node_modules")
        .map(async dir => {
          const file = path.join(this.root, dir.name, "SKILL.md")
          let content
          try {
            content = await fs.readFile(file, "utf8")
          } catch {
            return // 无 SKILL.md 的目录跳过
          }
          list.push(this.parseSkill(dir.name, content, file))
        }),
    )

    list.sort((a, b) => a.name.localeCompare(b.name))
    this._cache = { t: Date.now(), list }
    return list
  }

  /** 解析 SKILL.md：frontmatter(name/description/tools) + 正文；无 frontmatter 回退目录名/首行 */
  parseSkill(dirName, content, file) {
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
    return { name, description, tools, file }
  }

  /** 按名称读取技能正文，未命中返回 null；末尾附声明使用的工具 */
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
    if (skill.tools?.length) content += `\n\n本技能声明使用的工具: ${skill.tools.join(", ")}`
    return content
  }
}

/** 主 Agent 技能：plugins 下各插件目录的 SKILL.md */
export const pluginSkills = new SkillStore("plugins")

/** 子 Agent 技能：config/skills 下各技能目录的 SKILL.md */
export const agentSkills = new SkillStore("config/skills")

/** 技能列表 → 系统提示词块 */
export function skillsListBlock(list) {
  const lines = ["<skills>", "可用技能列表。当任务与某技能描述相关时，先调用 skill 工具查看该技能的详细指引再执行："]
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
