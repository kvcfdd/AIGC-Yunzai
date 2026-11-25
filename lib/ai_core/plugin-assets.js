import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { pathToFileURL } from "node:url"
import tools, { TOOL_DESC_VIEW_MAX, isToolEnabled } from "./tools/tool-registry.js"
import skills, { BUILTIN_SKILLS_ROOT, SKILLS_ROOT } from "./tools/skills/index.js"
import { addNonMasterReadDir } from "./tools/workspace.js"

/** 插件提供的 Agent 资产目录：plugins/<plugin>/agent/{tools,skills} */
const PLUGIN_AGENT_DIR = "agent"

const PLUGINS_ROOT = "plugins"
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

async function isDirectory(file) {
  try {
    return (await fs.stat(file)).isDirectory()
  } catch {
    return false
  }
}

/** source → 插件名；非插件来源返回空串 */
export function pluginNameFromSource(source) {
  const value = String(source || "")
  return value.startsWith("plugin:") ? value.slice("plugin:".length) : ""
}

/**
 * 插件 Agent 资产加载器 — 启动时随插件加载一次
 *
 * 扫描已加载插件目录下的 agent/tools/*.js 与 agent/skills/
 * 工具注册到全局 registry
 * 技能作为额外根加入 SkillStore
 */
export class PluginAssets {
  constructor({ pluginsRoot = PLUGINS_ROOT, registry = tools, skillStore = skills, logger = null } = {}) {
    this.pluginsRoot = path.resolve(pluginsRoot)
    this.registry = registry
    this.skillStore = skillStore
    this.logger = logger
    this.plugins = new Map()
  }

  /** 加载已加载插件的 Agent 资产 */
  async load(pluginDirs) {
    const dirs = this._resolveDirs(pluginDirs)
    const toolItems = []
    const candidates = []
    this.plugins.clear()

    for (const dir of dirs) {
      const pluginName = path.basename(dir)
      const source = `plugin:${pluginName}`
      const agentDir = path.join(dir, PLUGIN_AGENT_DIR)
      if (!(await isDirectory(agentDir))) continue

      const description = await this._loadDescription(dir)
      if (!description) continue

      const items = await this._loadTools(pluginName, source, path.join(agentDir, "tools"))
      if (!items.length) continue

      const skillDir = path.join(agentDir, "skills")
      candidates.push({ pluginName, source, description, skillDir: (await isDirectory(skillDir)) ? skillDir : "" })
      toolItems.push(...items)
    }

    const { count, applied } = this._applyTools(toolItems)
    const skillRoots = []
    for (const item of candidates) {
      if (!applied.has(item.pluginName)) continue
      this.plugins.set(item.pluginName, item.description)
      if (item.skillDir) skillRoots.push({ dir: item.skillDir, source: item.source })
    }
    this._applySkills(skillRoots)

    if (count || skillRoots.length) this._log("info", `已加载 ${count} 个插件工具，${skillRoots.length} 个插件技能根`)
    return { tools: count, skills: skillRoots.length }
  }

  /** 解析待扫描目录：支持插件名、绝对路径或目录列表 */
  _resolveDirs(pluginDirs) {
    if (!pluginDirs) return []
    const list = Array.isArray(pluginDirs) ? pluginDirs : [pluginDirs]
    return [...new Set(list.map(item => path.resolve(this.pluginsRoot, String(item))))].sort()
  }

  /** 插件级描述：仅读取 agent/plugin.yaml；缺失或为空返回空串 */
  async _loadDescription(dir) {
    try {
      const manifest = YAML.parse(await fs.readFile(path.join(dir, PLUGIN_AGENT_DIR, "plugin.yaml"), "utf8"))
      return typeof manifest?.description === "string" ? manifest.description.trim() : ""
    } catch {
      return ""
    }
  }

  /** 有可用工具的插件列表；按名称排序 */
  list() {
    const names = new Set()
    for (const tool of this.registry?.tools?.values?.() || []) {
      if (!isToolEnabled(tool)) continue
      const name = pluginNameFromSource(tool.source)
      if (name) names.add(name)
    }
    return [...names].map(name => ({ name, description: this.plugins.get(name) || name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 插件元信息；未知插件返回 null */
  get(name) {
    const key = String(name || "").trim()
    return key && this.plugins.has(key) ? { name: key, description: this.plugins.get(key) } : null
  }

  async _loadTools(pluginName, source, dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }

    const files = entries
      .filter(entry => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".js"))
      .map(entry => path.join(dir, entry.name))
      .sort()

    const out = []
    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(file).href)
        const tool = mod.default
        if (!tool) throw new Error("没有默认导出工具")
        out.push({ pluginName, source, file, tool })
      } catch (err) {
        this._log("error", `${pluginName}: 载入工具 ${path.basename(file)} 失败: ${err?.message || err}`)
      }
    }
    return out
  }

  /** 校验、去重并注册工具；返回成功数量与至少有一个工具成功注册的插件名 */
  _applyTools(items) {
    const seen = new Set()
    const applied = new Set()
    let count = 0

    for (const item of items) {
      try {
        this._validateTool(item.tool)
        if (seen.has(item.tool.name)) throw new Error(`工具名重复: ${item.tool.name}`)
        if (this.registry.tools.has(item.tool.name)) throw new Error(`工具名冲突: ${item.tool.name} 已存在`)

        this.registry.register({ ...item.tool }, { source: item.source })
        seen.add(item.tool.name)
        applied.add(item.pluginName)
        count++
      } catch (err) {
        this._log("error", `${item.pluginName}: ${path.basename(item.file)} ${err?.message || err}`)
      }
    }
    return { count, applied }
  }

  _validateTool(tool) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error("默认导出必须是工具对象")
    if (typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)) throw new Error(`name 不合法: ${tool?.name ?? "(missing)"}`)
    if (tool.name.startsWith("mcp_")) throw new Error('name 不能以 "mcp_" 开头（保留给 MCP 工具）')
    if (typeof tool.description !== "string" || !tool.description.trim()) throw new Error(`${tool.name} 缺少 description`)
    if (tool.description.length > TOOL_DESC_VIEW_MAX) throw new Error(`${tool.name} 的 description 不能超过 ${TOOL_DESC_VIEW_MAX} 字符`)
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) throw new Error(`${tool.name} 的 parameters 必须是 JSON Schema 对象`)
    if (tool.parameters.type !== "object") throw new Error(`${tool.name} 的 parameters.type 必须是 "object"`)
    if (!tool.parameters.properties || typeof tool.parameters.properties !== "object" || Array.isArray(tool.parameters.properties)) throw new Error(`${tool.name} 的 parameters.properties 必须是对象`)
    if (tool.parameters.required != null && !Array.isArray(tool.parameters.required)) throw new Error(`${tool.name} 的 parameters.required 必须是数组`)
    for (const key of tool.parameters.required || []) {
      if (typeof key !== "string" || !(key in tool.parameters.properties)) throw new Error(`${tool.name} 的 required 项 ${key} 未在 properties 中定义`)
    }
    if (typeof tool.execute !== "function") throw new Error(`${tool.name} 缺少 execute`)
    if (tool.permission != null && tool.permission !== "all" && tool.permission !== "master") throw new Error(`${tool.name} 的 permission 只能是 "all" 或 "master"`)
    if (tool.enabled != null && typeof tool.enabled !== "function") throw new Error(`${tool.name} 的 enabled 必须是函数`)
  }

  /** 追加插件技能根；插件根排在内置之前，内置/用户优先覆盖 */
  _applySkills(roots) {
    for (const root of roots) addNonMasterReadDir(root.dir)
    this.skillStore?.setRoots?.([...roots, { dir: BUILTIN_SKILLS_ROOT, source: "builtin" }, { dir: SKILLS_ROOT, source: "user" }])
  }

  _log(level, message) {
    const log = this.logger || globalThis.logger
    log?.[level]?.(`[plugin-assets] ${message}`)
  }
}

export default new PluginAssets()
