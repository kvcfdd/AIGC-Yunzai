import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { buildFileTree, SKIP_DIRS } from "../../helpers/file-tree.js"
import { xmlEscape } from "../../helpers/xml.js"

const LIST_TTL = 60_000 // 列表缓存 60s
const DESC_MAX = 1024 // 描述单行截断长度

/** 内置技能目录 — 随仓库发布 */
export const BUILTIN_SKILLS_ROOT = "skills"
/** 用户技能目录 — 同名覆盖内置技能 */
export const SKILLS_ROOT = "data/skills"

/** frontmatter 与 BOM 剥离正则 */
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export class SkillStore {
  constructor(roots = SKILLS_ROOT) {
    this.setRoots(roots)
  }

  /** 设置技能根目录；支持字符串或 { dir, source }，后面的根覆盖同名技能 */
  setRoots(roots) {
    const builtinDir = path.resolve(BUILTIN_SKILLS_ROOT)
    this.roots = (Array.isArray(roots) ? roots : [roots]).map(entry => {
      if (typeof entry === "string") {
        const dir = path.resolve(entry)
        return { dir, source: dir === builtinDir ? "builtin" : "user" }
      }
      if (!entry?.dir) throw new Error("Skill 根目录必须包含 dir")
      return { dir: path.resolve(entry.dir), source: entry.source || "user" }
    })
    this._cache = null
  }

  /** 技能列表 [{ name, description, tools, file, dir, source }]；后面的根覆盖同名技能 */
  async list() {
    if (this._cache && Date.now() - this._cache.t < LIST_TTL) return this._cache.list

    const byName = new Map()
    for (const { dir: root, source } of this.roots) {
      let dirs
      try {
        dirs = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue // 根目录不存在 → 跳过
      }

      await Promise.all(
        dirs
          .filter(i => i.isDirectory() && !i.name.startsWith(".") && !SKIP_DIRS.has(i.name))
          .map(async dir => {
            const skillDir = path.join(root, dir.name)
            const file = path.join(skillDir, "SKILL.md")
            let content
            try {
              content = await fs.readFile(file, "utf8")
            } catch {
              return // 无 SKILL.md 的目录跳过
            }
            const skill = this.parseSkill(dir.name, content, file, skillDir, source)
            byName.set(skill.name, skill)
          }),
      )
    }

    const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    this._cache = { t: Date.now(), list }
    return list
  }

  /** 解析 SKILL.md：frontmatter(name/description/tools) + 正文；无 frontmatter 回退目录名/首行 */
  parseSkill(dirName, content, file, dir = path.dirname(file), source = "user") {
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
    return { name, description, tools, file, dir, source }
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

    return { ...skill, content, files: await buildFileTree(skill.dir) }
  }
}

/** 内置 + 用户技能；同名时用户覆盖内置 */
export const userSkills = new SkillStore([
  { dir: BUILTIN_SKILLS_ROOT, source: "builtin" },
  { dir: SKILLS_ROOT, source: "user" },
])
export default userSkills

/** 技能来源排序：内置 → 插件 → 用户 */
function sourceRank(source) {
  if (!source || source === "builtin") return 0
  if (String(source).startsWith("plugin:")) return 1
  if (source === "user") return 2
  return 3
}

/** 技能列表 → 系统提示词块；按来源排序，来源仅用于排序 */
export function skillsListBlock(list) {
  const sorted = [...list].sort((a, b) => {
    const rank = sourceRank(a.source) - sourceRank(b.source)
    if (rank) return rank
    const source = String(a.source || "").localeCompare(String(b.source || ""))
    if (source) return source
    return a.name.localeCompare(b.name)
  })
  const lines = ["<skills>"]
  for (const s of sorted) lines.push(`  <skill name="${xmlEscape(s.name)}">${xmlEscape(s.description)}</skill>`)
  lines.push("</skills>")
  return lines.join("\n")
}
