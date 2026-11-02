import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import cfg from "../config/config.js"
import { writeFileAtomic } from "../ai_core/tools/workspace.js"
import { CORE_CONFIGS, CORE_CRON_KEYS, CORE_JSON_KEYS, CORE_KEY_CHOICES, CORE_KEY_FIELDS, CORE_KEY_NUMERIC_LIMITS, CORE_NUMERIC_LIMITS, CORE_OBJECT_ARRAYS, CORE_SWITCH_KEYS, CORE_TYPE_HINTS, flattenCoreFields, getCoreConfig } from "./core-configs.js"

const CORE_DIR = "config/default_config"
const USER_DIR = "config/config"
const PLUGIN_DIR = "config"
const PLUGIN_ROOT = "plugins"
const DATA_ROOT = "data"
const CORE_INDEX = new Map(CORE_CONFIGS.map((config, index) => [config.name, index]))
const ROOT_LABELS = { pm2: "PM2" }
const BUILTIN_PLUGINS = new Set(["adapter", "system", "other", "example"])
const MIAO_HELP_TARGET = path.join(PLUGIN_ROOT, "miao-plugin", "config", "help.js")
const MIAO_HELP_DEFAULT = path.join(PLUGIN_ROOT, "miao-plugin", "config", "help_default.js")
const MAX_STRING = 200_000
const MAX_DEPTH = 12
const MAX_ARRAY = 1000
const SKIP_DIRS = new Set(["node_modules", ".git", "resources"])

let discovery = { at: 0, entries: null }

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

function readYamlInfo(file) {
  const text = file ? readText(file) : ""
  if (!text.trim()) return { value: undefined, error: null }
  try {
    return { value: YAML.parse(text), error: null }
  } catch (err) {
    return { value: undefined, error: err.message }
  }
}

function parseDoc(text) {
  const doc = YAML.parseDocument(text || "{}")
  if (doc.errors.length) throw new HttpError(400, `YAML 语法错误：${doc.errors[0].message}`)
  if (doc.contents == null) doc.contents = doc.createNode({})
  if (!YAML.isMap(doc.contents)) throw new HttpError(400, "配置根节点必须是对象")
  return doc
}

function listYaml(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map(entry => entry.name.replace(/\.ya?ml$/i, ""))
  } catch {
    return []
  }
}

function walkYaml(dir, prefix = "", depth = 0, out = []) {
  if (depth > 5) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) walkYaml(path.join(dir, entry.name), rel, depth + 1, out)
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) out.push(rel)
  }
  return out
}

function relative(file) {
  return file.split(path.sep).join("/")
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file)
    return { size: stat.size, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, char => char.toUpperCase())
}

function pathLabel(rel) {
  return String(rel)
    .replace(/\.ya?ml$/i, "")
    .split("/")
    .filter(Boolean)
    .map(part => titleCase(part))
    .join(" / ")
}

function detectPlugins() {
  let dirs = []
  try {
    dirs = fs.readdirSync(PLUGIN_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return []
  }
  return dirs
    .filter(entry => !BUILTIN_PLUGINS.has(entry.name))
    .map(entry => {
      let pkg = {}
      try {
        pkg = JSON.parse(readText(path.join(PLUGIN_ROOT, entry.name, "package.json")) || "{}")
      } catch {}
      return {
        dir: entry.name,
        name: String(pkg.name || entry.name),
        version: String(pkg.version || ""),
        description: String(pkg.description || ""),
        hasGuoba: fs.existsSync(path.join(PLUGIN_ROOT, entry.name, "guoba.support.js")),
      }
    })
}

function pluginLabel(plugin) {
  if (!plugin) return ""
  return titleCase(plugin.name.replace(/-plugin$/i, ""))
}

function matchPlugin(key, plugins) {
  const name = String(key).toLowerCase()
  const bare = name.replace(/-plugin$/, "")
  return (
    plugins.find(plugin => {
      const dir = plugin.dir.toLowerCase()
      const pkg = plugin.name.toLowerCase()
      return dir === name || pkg === name || dir.replace(/-plugin$/, "") === bare || pkg.replace(/-plugin$/, "") === bare || pkg.includes(bare) || dir.includes(bare)
    }) || null
  )
}

function findDefaultFile(pluginDir, relPath) {
  const root = path.join(PLUGIN_ROOT, pluginDir)
  for (const folder of ["defSet", "defaultConfig"]) {
    const file = path.join(root, folder, relPath)
    if (fs.existsSync(file)) return file
  }
  return null
}

function discoverConfigs() {
  const now = Date.now()
  if (discovery.entries && now - discovery.at < 1000) return discovery.entries

  const plugins = detectPlugins()
  const entries = []
  const seen = new Set()
  const add = entry => {
    if (seen.has(entry.name)) return
    seen.add(entry.name)
    const info = fileInfo(entry.targetFile)
    entries.push({ ...entry, size: info?.size || 0, mtime: info?.mtime || null })
  }

  for (const core of CORE_CONFIGS) {
    const defaultFile = path.join(CORE_DIR, `${core.name}.yaml`)
    const userFile = path.join(USER_DIR, `${core.name}.yaml`)
    const hasDefault = fs.existsSync(defaultFile)
    const hasUser = fs.existsSync(userFile)
    if (!hasDefault && !hasUser) continue
    add({
      name: `core:${core.name}`,
      label: core.label,
      description: core.description,
      group: "core",
      plugin: "",
      core: true,
      targetFile: userFile,
      defaultFile: hasDefault ? defaultFile : null,
      file: relative(userFile),
      hasDefault,
      hasUser,
    })
  }

  const knownCore = new Set(CORE_CONFIGS.map(core => core.name))
  for (const name of new Set([...listYaml(CORE_DIR), ...listYaml(USER_DIR)])) {
    if (knownCore.has(name)) continue
    const defaultFile = path.join(CORE_DIR, `${name}.yaml`)
    const userFile = path.join(USER_DIR, `${name}.yaml`)
    const hasDefault = fs.existsSync(defaultFile)
    const hasUser = fs.existsSync(userFile)
    if (!hasDefault && !hasUser) continue
    add({
      name: `core:${name}`,
      label: `未收录 · ${titleCase(name)}`,
      description: "未收录的本体配置文件，按通用方式展示",
      group: "extra",
      plugin: "",
      core: true,
      targetFile: userFile,
      defaultFile: hasDefault ? defaultFile : null,
      file: relative(userFile),
      hasDefault,
      hasUser,
    })
  }

  for (const name of listYaml(PLUGIN_DIR)) {
    if (name === "config" || name === "default_config") continue
    const file = path.join(PLUGIN_DIR, `${name}.yaml`)
    if (!fs.existsSync(file)) continue
    const plugin = matchPlugin(name, plugins)
    add({
      name: `root:${name}`,
      label: ROOT_LABELS[name] || (plugin ? pluginLabel(plugin) : titleCase(name)),
      description: name === "pm2" ? "PM2 进程管理配置" : plugin ? plugin.description || `${pluginLabel(plugin)} 插件配置` : "未识别的根目录配置",
      group: plugin ? "plugin" : "extra",
      plugin: plugin?.name || "",
      core: false,
      targetFile: file,
      defaultFile: null,
      file: relative(file),
      hasDefault: false,
      hasUser: true,
    })
  }

  for (const plugin of plugins) {
    const root = path.join(PLUGIN_ROOT, plugin.dir)
    const configDir = path.join(root, "config")
    for (const relPath of walkYaml(configDir)) {
      const targetFile = path.join(configDir, relPath)
      const defaultFile = findDefaultFile(plugin.dir, relPath)
      add({
        name: `plugin:${plugin.dir}:${relPath.replace(/\.ya?ml$/i, "")}`,
        label: `${pluginLabel(plugin)} · ${pathLabel(relPath)}`,
        description: plugin.description || `${pluginLabel(plugin)} 插件配置`,
        group: "plugin",
        plugin: plugin.name,
        core: false,
        targetFile,
        defaultFile,
        file: relative(targetFile),
        hasDefault: !!defaultFile,
        hasUser: true,
      })
    }
    const single = path.join(root, "config.yaml")
    if (fs.existsSync(single)) {
      const defaultFile = findDefaultFile(plugin.dir, "config.yaml")
      add({
        name: `plugin:${plugin.dir}:config`,
        label: `${pluginLabel(plugin)} · 配置`,
        description: plugin.description || `${pluginLabel(plugin)} 插件配置`,
        group: "plugin",
        plugin: plugin.name,
        core: false,
        targetFile: single,
        defaultFile,
        file: relative(single),
        hasDefault: !!defaultFile,
        hasUser: true,
      })
    }
  }

  if (fs.existsSync(MIAO_HELP_DEFAULT)) {
    add({
      name: "special:miao-help",
      label: "Miao · 帮助",
      description: "Miao 插件帮助菜单内容",
      group: "plugin",
      plugin: "miao-plugin",
      core: false,
      special: "miao-help",
      targetFile: MIAO_HELP_TARGET,
      defaultFile: MIAO_HELP_DEFAULT,
      file: relative(MIAO_HELP_TARGET),
      hasDefault: true,
      hasUser: fs.existsSync(MIAO_HELP_TARGET),
    })
  }

  let dataDirs = []
  try {
    dataDirs = fs
      .readdirSync(DATA_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {}
  for (const key of dataDirs) {
    const configDir = path.join(DATA_ROOT, key, "config")
    if (!fs.existsSync(configDir)) continue
    const plugin = matchPlugin(key, plugins) || plugins.find(item => item.dir === key) || null
    const defaultRoot = plugin ? path.join(PLUGIN_ROOT, plugin.dir) : null
    for (const relPath of walkYaml(configDir)) {
      const targetFile = path.join(configDir, relPath)
      const defaultFile = defaultRoot ? findDefaultFile(plugin.dir, relPath) : null
      add({
        name: `data:${key}:${relPath.replace(/\.ya?ml$/i, "")}`,
        label: `${plugin ? pluginLabel(plugin) : titleCase(key)} · ${pathLabel(relPath)}`,
        description: plugin ? plugin.description || `${pluginLabel(plugin)} 插件运行配置` : "插件数据目录中的配置",
        group: plugin ? "plugin" : "extra",
        plugin: plugin?.name || "",
        core: false,
        targetFile,
        defaultFile,
        file: relative(targetFile),
        hasDefault: !!defaultFile,
        hasUser: true,
      })
    }
  }

  const rank = name => CORE_INDEX.get(name) ?? 99
  entries.sort((a, b) => {
    if (a.group !== b.group) return { core: 0, plugin: 1, extra: 2 }[a.group] - { core: 0, plugin: 1, extra: 2 }[b.group]
    if (a.group === "core") return rank(a.name.slice(5)) - rank(b.name.slice(5))
    return a.label.localeCompare(b.label, "zh-CN")
  })

  discovery = { at: now, entries }
  return entries
}

function invalidateDiscovery() {
  discovery = { at: 0, entries: null }
}

function publicConfig(entry) {
  const { targetFile, defaultFile, core, ...rest } = entry
  return rest
}

function entryFor(name) {
  if (typeof name !== "string" || !name) throw new HttpError(400, "缺少配置 ID")
  const entry = discoverConfigs().find(item => item.name === name)
  if (!entry) throw new HttpError(404, `配置不存在：${name}`)
  return entry
}

function splitComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) {
      if (char === "\\" && quote === '"') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return { code: line.slice(0, index), comment: line.slice(index + 1).trim() }
    }
  }
  return { code: line, comment: "" }
}

function parseYamlLine(trimmed) {
  const match = /^(.+?):(?:\s+(.*))?$/.exec(trimmed)
  if (!match) return null
  return { key: match[1].trim().replace(/^["']|["']$/g, ""), value: (match[2] || "").trim() }
}

function lineComments(text) {
  const fields = {}
  const stack = []
  const sequences = new Map()
  let pending = []
  let blockIndent = -1
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "")
    const { code, comment } = splitComment(line)
    const trimmed = code.trim()
    const indent = code.length - code.trimStart().length
    if (blockIndent >= 0) {
      if (trimmed && indent <= blockIndent) blockIndent = -1
      else continue
    }
    if (!trimmed) {
      if (comment) pending.push(comment)
      else pending = []
      continue
    }
    if (trimmed.startsWith("-")) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      const parentPath = stack.map(item => item.key).join(".")
      const index = sequences.get(parentPath) || 0
      sequences.set(parentPath, index + 1)
      stack.push({ indent, key: String(index) })
      pending = []
      const rest = trimmed.slice(1)
      const leading = rest.length - rest.trimStart().length
      const keyIndent = indent + 1 + leading
      const restTrimmed = rest.trim()
      if (!restTrimmed) continue
      const parsed = parseYamlLine(restTrimmed)
      if (!parsed) continue
      stack.push({ indent: keyIndent, key: parsed.key })
      const path = stack.map(item => item.key).join(".")
      if (comment) fields[path] = comment
      if (parsed.value.startsWith("|") || parsed.value.startsWith(">")) blockIndent = keyIndent
      continue
    }
    const parsed = parseYamlLine(trimmed)
    if (!parsed) {
      pending = []
      continue
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: parsed.key })
    const path = stack.map(item => item.key).join(".")
    if (pending.length) fields[path] = pending.join(" ")
    else if (comment) fields[path] = comment
    pending = []
    if (parsed.value.startsWith("|") || parsed.value.startsWith(">")) blockIndent = indent
  }
  return fields
}

function listLike(key) {
  return /(list|keys|prefixes|filters)$/i.test(key)
}

function guessNullType(key) {
  return listLike(key) ? "list" : "string"
}

function arrayItemType(value) {
  if (!Array.isArray(value) || !value.length) return ""
  const types = new Set(value.map(item => (Array.isArray(item) ? "array" : item === null ? "null" : typeof item)))
  return types.size === 1 ? [...types][0] : "mixed"
}

function inferTypes(value, prefix, out) {
  if (prefix) {
    if (Array.isArray(value)) out[prefix] = { type: "array", itemType: arrayItemType(value) }
    else if (isPlainObject(value)) out[prefix] = { type: "object" }
    else if (value === null || value === undefined) out[prefix] = { type: guessNullType(prefix.split(".").pop()) }
    else out[prefix] = { type: typeof value }
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) inferTypes(item, prefix ? `${prefix}.${key}` : key, out)
  }
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value
  return out
}

const TYPE_LABELS = { boolean: "开关", number: "数字", string: "文本", array: "列表", object: "对象", null: "空值" }

function typeLabel(value) {
  if (Array.isArray(value)) return "列表"
  if (value === null) return "空值"
  if (isPlainObject(value)) return "对象"
  return TYPE_LABELS[typeof value] || typeof value
}

function sameTypeShape(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
  if (isPlainObject(a) || isPlainObject(b)) return isPlainObject(a) && isPlainObject(b)
  return typeof a === typeof b
}

function coreTypeWarnings(def, user, prefix = [], out = []) {
  if (!isPlainObject(def) || !isPlainObject(user) || out.length >= 10) return out
  for (const [key, defValue] of Object.entries(def)) {
    if (out.length >= 10) break
    if (!Object.prototype.hasOwnProperty.call(user, key)) continue
    const userValue = user[key]
    if (defValue === null || defValue === undefined || userValue === null || userValue === undefined) {
      if (isPlainObject(defValue) && isPlainObject(userValue)) coreTypeWarnings(defValue, userValue, [...prefix, key], out)
      continue
    }
    if (!sameTypeShape(defValue, userValue)) {
      out.push(`${[...prefix, key].join(".")} 需要${typeLabel(defValue)}，当前是${typeLabel(userValue)}`)
      continue
    }
    if (isPlainObject(defValue)) coreTypeWarnings(defValue, userValue, [...prefix, key], out)
  }
  return out
}

function buildCoreMeta(core, effective, comments) {
  const labels = {}
  const hints = {}
  const typeHints = {}
  const choices = {}
  const emptyChoices = {}
  const keyLabels = {}
  const keyComments = {}
  const keyChoices = { ...CORE_KEY_CHOICES }
  for (const [key, meta] of Object.entries(CORE_KEY_FIELDS)) {
    if (meta.label) keyLabels[key] = meta.label
    if (meta.description) keyComments[key] = meta.description
  }
  for (const [path, meta] of Object.entries(flattenCoreFields(core.fields))) {
    if (meta.label) labels[path] = meta.label
    if (meta.description) {
      comments[path] = meta.description
      hints[path] = meta.description
    }
    if (Array.isArray(meta.options)) choices[path] = meta.options
    if (meta.allowEmpty) emptyChoices[path] = true
  }
  for (const path of CORE_TYPE_HINTS[core.name] || []) typeHints[path] = "list"
  if (core.name === "aigc") {
    const names = Array.isArray(effective.models) ? [...new Set(effective.models.map(item => item?.name).filter(name => typeof name === "string" && name.trim()))] : []
    if (names.length) {
      for (const path of ["model_config", "agent.model_config", "multimodal.model_config", "security_audit.model_config", "proactive_group_chat.model_config", "embeddings.model_config"]) choices[path] = names
    }
  }
  if (core.name === "group") {
    for (const [key, value] of Object.entries(effective)) {
      if (!isPlainObject(value)) continue
      const parts = String(key).split(":")
      const isDefault = key === "default"
      const botDefault = parts.length === 2 && parts[1] === "default"
      if (!labels[key]) labels[key] = parts.length === 1 ? (isDefault ? "默认设置" : "群单独设置") : botDefault ? "机器人单独设置" : "机器人群单独设置"
      const description = parts.length === 1 ? (isDefault ? "所有群聊共用的默认设置" : `仅对群 ${key} 生效的覆盖设置`) : botDefault ? `机器人 ${parts[0]} 的默认设置` : `机器人 ${parts[0]} 在群 ${parts[1]} 的覆盖设置`
      comments[key] = description
      hints[key] = description
      for (const field of ["enable", "disable", "botAlias"]) typeHints[`${key}.${field}`] = "list"
      if (!isDefault) {
        hints[`${key}.enable`] ||= "只启用列出的功能，留空表示不限制"
        hints[`${key}.disable`] ||= "禁用列出的功能"
        hints[`${key}.botAlias`] ||= "可以触发机器人的额外名称"
      }
    }
  }
  return { labels, hints, typeHints, choices, emptyChoices, keyLabels, keyComments, keyChoices }
}

function describe(entry) {
  const defInfo = entry.defaultFile ? readYamlInfo(entry.defaultFile) : { value: undefined, error: null }
  const userInfo = readYamlInfo(entry.targetFile)
  const warning = []
  if (defInfo.error) warning.push(`默认配置 YAML 语法错误：${defInfo.error}`)
  if (userInfo.error) warning.push(`用户配置 YAML 语法错误：${userInfo.error}`)
  if (defInfo.value !== undefined && !defInfo.error && !isPlainObject(defInfo.value)) warning.push("默认配置根节点必须是对象")
  if (userInfo.value !== undefined && !userInfo.error && !isPlainObject(userInfo.value)) warning.push("用户配置根节点必须是对象")
  const def = isPlainObject(defInfo.value) ? defInfo.value : undefined
  const user = isPlainObject(userInfo.value) ? userInfo.value : undefined
  const effective = entry.core ? { ...(def || {}), ...(user || {}) } : entry.defaultFile ? deepMerge(def || {}, user || {}) : user || {}
  let comments = lineComments(readText(entry.targetFile))
  if (entry.defaultFile) comments = { ...comments, ...lineComments(readText(entry.defaultFile)) }
  const core = entry.core ? getCoreConfig(entry.name.slice(5)) : null
  let labels = {}
  let hints = {}
  let typeHints = {}
  let choices = {}
  let emptyChoices = {}
  let keyLabels = {}
  let keyComments = {}
  let keyChoices = {}
  let limits = {}
  let keyLimits = {}
  let switchKeys = []
  if (core) {
    const meta = buildCoreMeta(core, effective, comments)
    labels = meta.labels
    hints = meta.hints
    typeHints = meta.typeHints
    choices = meta.choices
    emptyChoices = meta.emptyChoices
    keyLabels = meta.keyLabels
    keyComments = meta.keyComments
    keyChoices = meta.keyChoices
    limits = CORE_NUMERIC_LIMITS[core.name] || {}
    keyLimits = CORE_KEY_NUMERIC_LIMITS
    switchKeys = CORE_SWITCH_KEYS[core.name] || []
    warning.push(...coreTypeWarnings(def, user))
    if (core.name === "aigc") warning.push(...mcpServerWarnings(effective.mcp?.servers))
  } else if (entry.core) {
    warning.push("该文件未收录为本体配置，字段说明可能不完整")
  }
  const types = {}
  inferTypes(effective, "", types)
  if (core) for (const path of CORE_OBJECT_ARRAYS[core.name] || []) types[path] = { type: "array", itemType: "object" }
  return {
    ...publicConfig(entry),
    effective,
    comments,
    types,
    labels,
    hints,
    typeHints,
    choices,
    emptyChoices,
    keyLabels,
    keyComments,
    keyChoices,
    limits,
    keyLimits,
    switchKeys,
    jsonKeys: CORE_JSON_KEYS,
    cronKeys: CORE_CRON_KEYS,
    warning: warning.slice(0, 10),
  }
}

function isStdioServer(server) {
  return server?.type === "stdio" || (!server?.type && !!server?.command)
}

function mcpServerWarnings(servers) {
  if (!Array.isArray(servers)) return []
  const warnings = []
  for (const [index, server] of servers.entries()) {
    if (isStdioServer(server)) continue
    const url = typeof server?.url === "string" ? server.url.trim() : ""
    if (!url) warnings.push(`mcp.servers 第 ${index + 1} 项：url 未填写`)
    else if (!/^https?:\/\//i.test(url)) warnings.push(`mcp.servers 第 ${index + 1} 项：url 需以 http:// 或 https:// 开头`)
  }
  return warnings
}

function validateMcpServers(servers) {
  if (!Array.isArray(servers)) return
  for (const [index, server] of servers.entries()) {
    if (!server || typeof server !== "object" || isStdioServer(server)) continue
    const url = typeof server.url === "string" ? server.url.trim() : ""
    if (!url) throw new HttpError(400, `mcp.servers 第 ${index + 1} 项：url 不能为空`)
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, `mcp.servers 第 ${index + 1} 项：url 需以 http:// 或 https:// 开头`)
    server.url = url
  }
}

function packageVersion(bot) {
  if (bot?.package?.version) return bot.package.version
  try {
    return JSON.parse(readText("package.json")).version || ""
  } catch {
    return ""
  }
}

function isBotEntry(item) {
  if (!item || typeof item !== "object") return false
  return typeof item.pickGroup === "function" || typeof item.pickFriend === "function" || item.gl instanceof Map || "uin" in item || "info" in item
}

function botEntries(bot) {
  return Object.entries(bot?.bots || {}).filter(([, item]) => isBotEntry(item))
}

export function getBotInfo(bot) {
  const first = botEntries(bot)[0]?.[1]
  if (!first) return null
  const selfId = String(first.uin || first.info?.user_id || first.self_id || "")
  const nickname = String(first.nickname || first.info?.nickname || "")
  let avatar = ""
  try {
    avatar = String(first.avatar || "")
  } catch {}
  if (!avatar && selfId) avatar = `https://q.qlogo.cn/g?b=qq&s=0&nk=${selfId}`
  if (!selfId && !avatar) return null
  return { self_id: selfId, nickname, avatar }
}

const GROUP_LIST_TIMEOUT = 3000

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
}

function collectBotList(bot) {
  return botEntries(bot)
    .filter(([, item]) => item?.adapter?.id !== "stdin" && item?.adapter?.name !== "标准输入")
    .map(([id, item]) => ({
      self_id: String(item.uin ?? item.info?.user_id ?? item.self_id ?? id),
      nickname: String(item.nickname ?? item.info?.nickname ?? ""),
    }))
}

async function collectGroups(bot) {
  const result = new Map()
  const add = (botId, group) => {
    const id = group?.group_id ?? group?.groupId
    if (id == null) return
    const key = String(id)
    if (!result.has(key)) result.set(key, { group_id: Number(id) || id, group_name: String(group?.group_name ?? group?.groupName ?? id), bot_ids: new Set() })
    result.get(key).bot_ids.add(String(botId))
  }
  await Promise.all(
    botEntries(bot)
      .filter(([, item]) => item?.adapter?.id !== "stdin" && item?.adapter?.name !== "标准输入")
      .map(async ([id, item]) => {
        const botId = String(item.uin ?? item.info?.user_id ?? item.self_id ?? id)
        let list = []
        if (typeof item.getGroupArray === "function") {
          try {
            list = await withTimeout(Promise.resolve(item.getGroupArray()), GROUP_LIST_TIMEOUT)
          } catch {}
        }
        if (!Array.isArray(list) || !list.length) list = [...(item.gl?.values?.() || [])]
        for (const group of list || []) add(botId, group)
      }),
  )
  return [...result.values()].map(item => ({ ...item, bot_ids: [...item.bot_ids] })).sort((a, b) => a.group_name.localeCompare(b.group_name, "zh-CN") || String(a.group_id).localeCompare(String(b.group_id)))
}

async function collectFeatures() {
  const names = new Set()
  try {
    const { default: loader } = await import("../plugins/loader.js")
    for (const item of loader.priority || []) if (item?.name) names.add(String(item.name))
  } catch {}
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"))
}

export async function getState(bot) {
  const entries = discoverConfigs()
  const [groups, features] = await Promise.all([collectGroups(bot), collectFeatures()])
  return {
    system: {
      online: bot?.stat?.online === 2,
      uptime: Math.floor(process.uptime()),
      bots: botEntries(bot).map(([id]) => id),
      version: packageVersion(bot),
      bot: getBotInfo(bot),
      url: cfg.server?.url || "",
      authRequired: !!(cfg.server?.auth && Object.keys(cfg.server.auth).length),
      authKeys: Object.keys(cfg.server?.auth || {}),
    },
    plugins: detectPlugins(),
    configs: entries.map(publicConfig),
    bots: collectBotList(bot),
    groups,
    features,
  }
}

async function importHelpModule(file) {
  const url = `${pathToFileURL(path.resolve(file)).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  const mod = await import(url)
  const rawCfg = mod.helpCfg ?? mod.default?.helpCfg ?? {}
  const valid = !!(mod.helpCfg || mod.helpList || mod.default)
  if (Array.isArray(rawCfg)) return { helpCfg: {}, helpList: rawCfg, valid }
  return {
    helpCfg: isPlainObject(rawCfg) ? rawCfg : {},
    helpList: Array.isArray(mod.helpList) ? mod.helpList : Array.isArray(mod.default?.helpList) ? mod.default.helpList : [],
    valid,
  }
}

const MIAO_HELP_THEME_DIR = path.join(PLUGIN_ROOT, "miao-plugin", "resources", "help", "theme")
const MIAO_API_BASE = "/yunzai/api/miao-help"

async function collectHelpThemes() {
  let dirs = []
  try {
    dirs = fs
      .readdirSync(MIAO_HELP_THEME_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const themes = []
  const defaultMain = path.join(MIAO_HELP_THEME_DIR, "default", "main.png")
  for (const name of dirs.sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    const dir = path.join(MIAO_HELP_THEME_DIR, name)
    let files = []
    try {
      files = fs.readdirSync(dir)
    } catch {}
    const themeLike = files.some(file => file === "config.js" || /^(main\.png|bg\.(jpe?g|png|webp))$/i.test(file))
    if (!themeLike) continue

    if (!files.includes("main.png") && fs.existsSync(defaultMain)) {
      try {
        fs.copyFileSync(defaultMain, path.join(dir, "main.png"))
        files.push("main.png")
      } catch {}
    }
    if (!files.includes("main.png")) continue
    const bgFile = files.find(file => /^bg\.(jpe?g|png|webp)$/i.test(file)) || ""
    let style = {}
    if (files.includes("config.js")) {
      try {
        const mod = await import(`${pathToFileURL(path.join(dir, "config.js")).href}?t=${Date.now()}`)
        style = mod.style || mod.default?.style || {}
      } catch {}
    }
    const mtime = file => {
      try {
        return Math.floor(fs.statSync(path.join(dir, file)).mtimeMs)
      } catch {
        return 0
      }
    }
    themes.push({
      name,
      custom: name !== "default",
      main: `${MIAO_API_BASE}/theme/${encodeURIComponent(name)}/main.png?v=${mtime("main.png")}`,
      bg: bgFile ? `${MIAO_API_BASE}/theme/${encodeURIComponent(name)}/${encodeURIComponent(bgFile)}?v=${mtime(bgFile)}` : "",
      style,
    })
  }
  return themes
}

const MIAO_THEME_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MIAO_THEME_STYLE_KEYS = new Set(["fontColor", "fontShadow", "descColor", "descShadow", "contBgColor", "contBgBlur", "headerBgColor", "rowBgColor1", "rowBgColor2"])

function miaoThemeDir(name) {
  const text = String(name || "")
  if (!MIAO_THEME_NAME.test(text) || text === "default") throw new HttpError(400, "主题名只能包含字母、数字、_、-，且不能为 default")
  const base = path.resolve(MIAO_HELP_THEME_DIR)
  const dir = path.resolve(path.join(MIAO_HELP_THEME_DIR, text))
  if (!dir.startsWith(base + path.sep)) throw new HttpError(400, "主题路径不合法")
  return dir
}

async function readThemeStyle(name) {
  const file = path.join(MIAO_HELP_THEME_DIR, name, "config.js")
  if (!fs.existsSync(file)) return {}
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return isPlainObject(mod.style) ? mod.style : isPlainObject(mod.default?.style) ? mod.default.style : {}
  } catch {
    return {}
  }
}

function writeThemeStyle(dir, style) {
  const body = Object.entries(style)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n")
  fs.writeFileSync(path.join(dir, "config.js"), `export const style = {\n${body}\n}\n`)
}

function cleanThemeStyle(input) {
  const style = {}
  for (const [key, value] of Object.entries(isPlainObject(input) ? input : {})) {
    if (!MIAO_THEME_STYLE_KEYS.has(key)) continue
    if (typeof value === "number" && Number.isFinite(value)) style[key] = value
    else if (typeof value === "string" && value.trim() && value.length <= 160) style[key] = value
  }
  return style
}

async function updateHelpThemeRefs(mutator) {
  if (!fs.existsSync(MIAO_HELP_TARGET)) return null
  const data = await importHelpModule(MIAO_HELP_TARGET)
  const helpCfg = { ...data.helpCfg }
  if (!mutator(helpCfg)) return null
  await writeFileAtomic(path.resolve(MIAO_HELP_TARGET), generateMiaoHelp(helpCfg, data.helpList))
  return { theme: helpCfg.theme, themeExclude: helpCfg.themeExclude }
}

export async function listMiaoThemes() {
  return collectHelpThemes()
}

export async function createMiaoTheme(name, mainBuffer) {
  if (!Buffer.isBuffer(mainBuffer) || !mainBuffer.length) throw new HttpError(400, "缺少主图")
  const dir = miaoThemeDir(name)
  if (fs.existsSync(dir)) throw new HttpError(409, "主题已存在")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "main.png"), mainBuffer)
  writeThemeStyle(dir, await readThemeStyle("default"))
  return await collectHelpThemes()
}

export async function updateMiaoThemeMain(name, mainBuffer) {
  const dir = miaoThemeDir(name)
  if (!fs.existsSync(dir)) throw new HttpError(404, "主题不存在")
  if (!Buffer.isBuffer(mainBuffer) || !mainBuffer.length) throw new HttpError(400, "缺少主图")
  fs.writeFileSync(path.join(dir, "main.png"), mainBuffer)
  return await collectHelpThemes()
}

export async function updateMiaoThemeStyle(name, style) {
  const dir = miaoThemeDir(name)
  if (!fs.existsSync(dir)) throw new HttpError(404, "主题不存在")
  const next = { ...(await readThemeStyle(name)), ...cleanThemeStyle(style) }
  writeThemeStyle(dir, next)
  return await collectHelpThemes()
}

export async function renameMiaoTheme(oldName, newName) {
  const from = miaoThemeDir(oldName)
  const to = miaoThemeDir(newName)
  if (!fs.existsSync(from)) throw new HttpError(404, "主题不存在")
  if (fs.existsSync(to)) throw new HttpError(409, "目标主题已存在")
  fs.renameSync(from, to)
  const helpCfg = await updateHelpThemeRefs(cfg => {
    let changed = false
    if (Array.isArray(cfg.theme)) {
      const next = cfg.theme.map(name => (name === oldName ? newName : name))
      if (JSON.stringify(next) !== JSON.stringify(cfg.theme)) {
        cfg.theme = next
        changed = true
      }
    } else if (cfg.theme === oldName) {
      cfg.theme = newName
      changed = true
    }
    if (Array.isArray(cfg.themeExclude)) {
      const next = cfg.themeExclude.map(name => (name === oldName ? newName : name))
      if (JSON.stringify(next) !== JSON.stringify(cfg.themeExclude)) {
        cfg.themeExclude = next
        changed = true
      }
    }
    return changed
  })
  return { themes: await collectHelpThemes(), helpCfg }
}

export async function deleteMiaoTheme(name) {
  const dir = miaoThemeDir(name)
  if (!fs.existsSync(dir)) throw new HttpError(404, "主题不存在")
  fs.rmSync(dir, { recursive: true, force: true })
  const helpCfg = await updateHelpThemeRefs(cfg => {
    let changed = false
    if (cfg.theme === name) {
      cfg.theme = "all"
      changed = true
    } else if (Array.isArray(cfg.theme)) {
      const next = cfg.theme.filter(item => item !== name)
      if (next.length !== cfg.theme.length) {
        cfg.theme = next
        changed = true
      }
    }
    if (Array.isArray(cfg.themeExclude) && cfg.themeExclude.includes(name)) {
      cfg.themeExclude = cfg.themeExclude.filter(item => item !== name)
      changed = true
    }
    return changed
  })
  return { themes: await collectHelpThemes(), helpCfg }
}

async function describeMiaoHelp(entry) {
  const warning = []
  let data
  const targetExists = fs.existsSync(entry.targetFile)
  const file = targetExists ? entry.targetFile : entry.defaultFile
  try {
    data = await importHelpModule(file)
  } catch (err) {
    warning.push(`help.js 加载失败：${err.message}`)
    try {
      data = await importHelpModule(entry.defaultFile)
    } catch (err2) {
      warning.push(`help_default.js 加载失败：${err2.message}`)
      data = { helpCfg: {}, helpList: [], valid: false }
    }
  }
  const effective = { helpCfg: data.helpCfg, helpList: data.helpList }
  return {
    ...publicConfig(entry),
    effective,
    special: "miao-help",
    helpCfg: data.helpCfg,
    helpList: data.helpList,
    themes: await collectHelpThemes(),
    iconUrl: `${MIAO_API_BASE}/icon`,
    warning,
  }
}

function validateHelpData(helpCfg, helpList) {
  if (!isPlainObject(helpCfg)) throw new HttpError(400, "helpCfg 必须是对象")
  if (!Array.isArray(helpList) || helpList.length > 100) throw new HttpError(400, "helpList 必须是不超过 100 项的数组")
  checkJson(helpCfg)
  checkJson(helpList)
  for (const group of helpList) {
    if (!isPlainObject(group)) throw new HttpError(400, "helpList 的分组必须是对象")
    if (!Array.isArray(group.list) || group.list.length > 500) throw new HttpError(400, "每个分组必须是不超过 500 项的数组")
    for (const item of group.list) if (!isPlainObject(item)) throw new HttpError(400, "帮助项必须是对象")
  }
}

function generateMiaoHelp(helpCfg, helpList) {
  return `export const helpCfg = ${JSON.stringify(helpCfg, null, 2)}\n\nexport const helpList = ${JSON.stringify(helpList, null, 2)}\n`
}

async function saveMiaoHelp(entry, patch) {
  const current = await describeMiaoHelp(entry)
  const helpCfg = { ...(current.helpCfg || {}), ...(isPlainObject(patch?.helpCfg) ? patch.helpCfg : {}) }
  const helpList = Array.isArray(patch?.helpList) ? patch.helpList : current.helpList || []
  validateHelpData(helpCfg, helpList)
  if (!fs.existsSync(entry.targetFile)) {
    try {
      fs.copyFileSync(entry.defaultFile, entry.targetFile)
    } catch (err) {
      throw new HttpError(500, `初始化 help.js 失败：${err.message}`)
    }
  }
  await writeFileAtomic(path.resolve(entry.targetFile), generateMiaoHelp(helpCfg, helpList))
  invalidateDiscovery()
  return await getConfig(entry.name)
}

async function saveMiaoHelpRaw(entry, content) {
  if (typeof content !== "string") throw new HttpError(400, "content 必须是字符串")
  if (content.length > MAX_STRING) throw new HttpError(413, "内容过大")
  const tmp = path.join(path.dirname(entry.targetFile), `.help-${process.pid}-${Date.now()}.mjs`)
  try {
    fs.writeFileSync(tmp, content, "utf8")
    const data = await importHelpModule(tmp)
    if (!data.valid) throw new Error("未导出 helpCfg 或 helpList")
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw new HttpError(400, `help.js 校验失败：${err.message}`)
  }
  try {
    fs.rmSync(tmp, { force: true })
  } catch {}
  if (!fs.existsSync(entry.targetFile)) {
    try {
      fs.copyFileSync(entry.defaultFile, entry.targetFile)
    } catch {}
  }
  await writeFileAtomic(path.resolve(entry.targetFile), content.endsWith("\n") ? content : `${content}\n`)
  invalidateDiscovery()
  return await getConfig(entry.name)
}

export async function getConfig(name) {
  const entry = entryFor(name)
  if (entry.special === "miao-help") return describeMiaoHelp(entry)
  return describe(entry)
}

export function getRaw(name) {
  const entry = entryFor(name)
  if (entry.special === "miao-help") {
    const exists = fs.existsSync(entry.targetFile)
    return { name, content: readText(exists ? entry.targetFile : entry.defaultFile), defaultContent: readText(entry.defaultFile), exists, special: "miao-help" }
  }
  return {
    name,
    content: readText(entry.targetFile),
    defaultContent: entry.defaultFile ? readText(entry.defaultFile) : "",
  }
}

function checkJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new HttpError(400, "配置嵌套过深")
  if (value == null) return
  if (typeof value === "string") {
    if (value.length > MAX_STRING) throw new HttpError(400, "字符串过长")
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, "数字不合法")
    return
  }
  if (typeof value === "boolean") return
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new HttpError(400, "数组过长")
    for (const item of value) checkJson(item, depth + 1)
    return
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) checkJson(item, depth + 1)
    return
  }
  throw new HttpError(400, "包含不支持的值")
}

function isKeyField(key) {
  if (/^max_/i.test(key)) return false
  return /(^|_)(?:api_?keys?|keys?|tokens?|secret|password|passwd|authorization|cookie)$/i.test(key)
}

function sameType(value, expected) {
  if (expected === null || expected === undefined) return true
  if (Array.isArray(expected)) return Array.isArray(value)
  if (typeof expected === "number") return typeof value === "number" && Number.isFinite(value)
  if (typeof expected === "boolean") return typeof value === "boolean"
  if (typeof expected === "string") return typeof value === "string"
  if (isPlainObject(expected)) return isPlainObject(value)
  return false
}

const GROUP_SECTION_KEY = /^(?:[\w-]+:)?(?:default|\d+)$/

function validatePatch(patch, target, types, prefix = [], freeformKeys = null, options = {}) {
  if (!isPlainObject(patch)) throw new HttpError(400, "patch 必须是对象")
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(target || {}, key)) {
      if (options.allowNewGroupKeys && !prefix.length && GROUP_SECTION_KEY.test(key) && isPlainObject(value)) {
        checkJson(value)
        continue
      }
      throw new HttpError(400, `不存在的配置项：${[...prefix, key].join(".")}`)
    }
    const full = [...prefix, key]
    const expected = target[key]
    const info = types[full.join(".")] || {}

    if (isKeyField(key) && (typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number")))) {
      checkJson(value)
      continue
    }
    if (isPlainObject(expected)) {
      if (!isPlainObject(value)) throw new HttpError(400, `${full.join(".")} 必须是对象`)

      if (freeformKeys?.has(key) || !Object.keys(expected).length) {
        checkJson(value)
        continue
      }
      validatePatch(value, expected, types, full, freeformKeys, options)
      continue
    }
    if (expected === null || expected === undefined) {
      checkJson(value)
      continue
    }
    if (!sameType(value, expected)) throw new HttpError(400, `${full.join(".")} 类型不匹配`)
    if (Array.isArray(expected)) {
      if (info.itemType === "object") {
        if (!value.every(isPlainObject)) throw new HttpError(400, `${full.join(".")} 必须是对象数组`)
        checkJson(value)
      } else if (info.itemType && info.itemType !== "mixed") {
        if (!value.every(item => typeof item === info.itemType)) throw new HttpError(400, `${full.join(".")} 数组元素类型不匹配`)
        checkJson(value)
      } else {
        checkJson(value)
      }
    } else {
      checkJson(value)
    }
  }
}

function actualKeyIn(container, key) {
  if (YAML.isMap(container)) {
    for (const item of container.items) {
      if (YAML.isScalar(item.key) && String(item.key.value) === String(key)) return item.key.value
    }
  }
  return /^\d+$/.test(String(key)) ? Number(key) : key
}

function applyPatch(doc, patch, prefix = [], freeformKeys = null) {
  for (const [key, value] of Object.entries(patch)) {
    const parent = prefix.length ? doc.getIn(prefix, true) : doc.contents
    const actual = actualKeyIn(parent, key)
    const full = [...prefix, actual]
    const existing = doc.getIn(full, true)

    const replace = !!freeformKeys?.has(key) || (YAML.isMap(existing) && existing.items.length === 0)
    if (isPlainObject(value) && !replace && YAML.isMap(existing)) applyPatch(doc, value, full, freeformKeys)
    else doc.setIn(full, value)
  }
}

function validateRemovals(remove, described, entry) {
  if (remove == null) return []
  if (!Array.isArray(remove)) throw new HttpError(400, "remove 必须是数组")
  if (!remove.length) return []
  if (!entry.core || entry.name !== "core:group") throw new HttpError(400, "该配置不支持删除配置项")
  const keys = []
  for (const key of remove) {
    if (typeof key !== "string" || key === "default" || !GROUP_SECTION_KEY.test(key)) throw new HttpError(400, `无法删除：${String(key)}`)
    if (!Object.prototype.hasOwnProperty.call(described.effective, key)) continue
    keys.push(key)
  }
  return keys
}

function applyRemovals(doc, keys) {
  for (const key of keys) {
    const actual = actualKeyIn(doc.contents, key)
    doc.deleteIn([actual])
  }
}

async function writeConfig(name, patch, remove = null) {
  const entry = entryFor(name)
  const described = describe(entry)
  const freeformKeys = new Set(described.jsonKeys || [])
  validatePatch(patch, described.effective, described.types, [], freeformKeys, { allowNewGroupKeys: entry.core && entry.name === "core:group" })
  if (entry.core && entry.name === "core:aigc") validateMcpServers(patch?.mcp?.servers)
  const removals = validateRemovals(remove, described, entry)
  let doc
  if (fs.existsSync(entry.targetFile)) doc = parseDoc(readText(entry.targetFile))
  else if (entry.defaultFile && fs.existsSync(entry.defaultFile)) doc = parseDoc(readText(entry.defaultFile))
  else doc = parseDoc("{}")
  applyPatch(doc, patch, [], freeformKeys)
  applyRemovals(doc, removals)
  await writeFileAtomic(path.resolve(entry.targetFile), String(doc))
  if (entry.core) delete cfg.config[`config.${entry.name.slice(5)}`]
  invalidateDiscovery()
  return await getConfig(name)
}

export async function saveConfig(name, patch, remove = null) {
  const entry = entryFor(name)
  if (entry.special === "miao-help") return saveMiaoHelp(entry, patch)
  return writeConfig(name, patch, remove)
}

export async function saveRaw(name, content) {
  if (typeof content !== "string") throw new HttpError(400, "content 必须是字符串")
  if (content.length > MAX_STRING) throw new HttpError(413, "内容过大")
  const entry = entryFor(name)
  if (entry.special === "miao-help") return saveMiaoHelpRaw(entry, content)
  const doc = parseDoc(content)
  if (!YAML.isMap(doc.contents)) throw new HttpError(400, "根节点必须是对象")
  await writeFileAtomic(path.resolve(entry.targetFile), content.endsWith("\n") ? content : `${content}\n`)
  if (entry.core) delete cfg.config[`config.${entry.name.slice(5)}`]
  invalidateDiscovery()
  return await getConfig(name)
}
