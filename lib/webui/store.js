import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import cfg from "../config/config.js"
import { writeFileAtomic } from "../ai_core/tools/workspace.js"

const CORE_DIR = "config/default_config"
const USER_DIR = "config/config"
const PLUGIN_DIR = "config"
const PLUGIN_ROOT = "plugins"
const DATA_ROOT = "data"
const CORE_ORDER = ["bot", "group", "other", "server", "renderer", "db", "aigc", "gsuid", "maint_task"]
const CORE_LABELS = { bot: "机器人", group: "群聊", other: "主人与其他", server: "服务器", renderer: "渲染器", db: "数据库", aigc: "AIGC", gsuid: "GSUID", maint_task: "维护任务", pm2: "PM2" }
const BUILTIN_PLUGINS = new Set(["adapter", "system", "other", "example"])
const MIAO_HELP_TARGET = path.join(PLUGIN_ROOT, "miao-plugin", "config", "help.js")
const MIAO_HELP_DEFAULT = path.join(PLUGIN_ROOT, "miao-plugin", "config", "help_default.js")
const MIAO_HELP_COMMENTS = {
  "helpCfg.title": "帮助标题",
  "helpCfg.subTitle": "帮助副标题",
  "helpCfg.colCount": "帮助表格列数，可选 2-5",
  "helpCfg.colWidth": "单列宽度",
  "helpCfg.theme": "皮肤选择，可填 all、皮肤名或皮肤名列表",
  "helpCfg.themeExclude": "排除皮肤，列表",
  "helpCfg.bgBlur": "背景毛玻璃效果",
}
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

function readYaml(file) {
  const text = file ? readText(file) : ""
  if (!text.trim()) return undefined
  try {
    return YAML.parse(text)
  } catch {
    return undefined
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

  for (const name of new Set([...listYaml(CORE_DIR), ...listYaml(USER_DIR)])) {
    const defaultFile = path.join(CORE_DIR, `${name}.yaml`)
    const userFile = path.join(USER_DIR, `${name}.yaml`)
    const hasDefault = fs.existsSync(defaultFile)
    const hasUser = fs.existsSync(userFile)
    if (!hasDefault && !hasUser) continue
    add({
      name: `core:${name}`,
      label: CORE_LABELS[name] || titleCase(name),
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

  for (const name of listYaml(PLUGIN_DIR)) {
    if (name === "config" || name === "default_config") continue
    const file = path.join(PLUGIN_DIR, `${name}.yaml`)
    if (!fs.existsSync(file)) continue
    const plugin = matchPlugin(name, plugins)
    add({
      name: `root:${name}`,
      label: CORE_LABELS[name] || (plugin ? pluginLabel(plugin) : titleCase(name)),
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

  const rank = name => {
    const index = CORE_ORDER.indexOf(name)
    return index === -1 ? 99 : index
  }
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

function lineComments(text) {
  const fields = {}
  const stack = []
  let pending = []
  let blockIndent = -1
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "")
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (blockIndent >= 0) {
      if (trimmed && indent <= blockIndent) blockIndent = -1
      else continue
    }
    if (!trimmed) {
      pending = []
      continue
    }
    if (trimmed.startsWith("#")) {
      pending.push(trimmed.replace(/^#\s?/, ""))
      continue
    }
    if (trimmed.startsWith("-")) {
      pending = []
      continue
    }
    const match = /^([^:#][^:]*):(?:\s*(.*))?$/.exec(trimmed)
    if (!match) {
      pending = []
      continue
    }
    const key = match[1].trim().replace(/^["']|["']$/g, "")
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
    const path = stack.map(item => item.key).join(".")
    if (pending.length) fields[path] = pending.join(" ")
    pending = []
    const value = (match[2] || "").trim()
    if (value.startsWith("|") || value.startsWith(">")) blockIndent = indent
  }
  return fields
}

function listLike(key) {
  return /(keys?|list|whitelist|blacklist|prefix|filter|ids?)$/i.test(key)
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

function describe(entry) {
  const def = entry.defaultFile ? readYaml(entry.defaultFile) : undefined
  const user = readYaml(entry.targetFile)
  const effective = entry.core ? { ...(def || {}), ...(user || {}) } : entry.defaultFile ? deepMerge(def || {}, user || {}) : user || {}
  let comments = lineComments(readText(entry.targetFile))
  if (entry.defaultFile) comments = { ...comments, ...lineComments(readText(entry.defaultFile)) }
  const types = {}
  inferTypes(effective, "", types)
  return { ...publicConfig(entry), effective, comments, types }
}

function packageVersion(bot) {
  if (bot?.package?.version) return bot.package.version
  try {
    return JSON.parse(readText("package.json")).version || ""
  } catch {
    return ""
  }
}

export function getBotInfo(bot) {
  const first = Object.values(bot?.bots || {})[0]
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

export function getState(bot) {
  const entries = discoverConfigs()
  return {
    system: {
      online: bot?.stat?.online === 2,
      uptime: Math.floor(process.uptime()),
      bots: Object.keys(bot?.bots || {}),
      version: packageVersion(bot),
      bot: getBotInfo(bot),
      url: cfg.server?.url || "",
      authRequired: !!(cfg.server?.auth && Object.keys(cfg.server.auth).length),
      authKeys: Object.keys(cfg.server?.auth || {}),
    },
    plugins: detectPlugins(),
    configs: entries.map(publicConfig),
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
  const types = {}
  inferTypes(effective, "", types)
  return { ...publicConfig(entry), effective, comments: MIAO_HELP_COMMENTS, types, special: "miao-help", helpCfg: data.helpCfg, helpList: data.helpList, warning }
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

function sameType(value, expected) {
  if (expected === null || expected === undefined) return true
  if (Array.isArray(expected)) return Array.isArray(value)
  if (typeof expected === "number") return typeof value === "number" && Number.isFinite(value)
  if (typeof expected === "boolean") return typeof value === "boolean"
  if (typeof expected === "string") return typeof value === "string"
  if (isPlainObject(expected)) return isPlainObject(value)
  return false
}

function validatePatch(patch, target, types, prefix = []) {
  if (!isPlainObject(patch)) throw new HttpError(400, "patch 必须是对象")
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(target || {}, key)) throw new HttpError(400, `不存在的配置项：${[...prefix, key].join(".")}`)
    const full = [...prefix, key]
    const expected = target[key]
    const info = types[full.join(".")] || {}
    if (isPlainObject(expected)) {
      if (!isPlainObject(value)) throw new HttpError(400, `${full.join(".")} 必须是对象`)
      validatePatch(value, expected, types, full)
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

function applyPatch(doc, patch, prefix = []) {
  for (const [key, value] of Object.entries(patch)) {
    const full = [...prefix, key]
    if (isPlainObject(value) && YAML.isMap(doc.getIn(full, true))) applyPatch(doc, value, full)
    else doc.setIn(full, value)
  }
}

async function writeConfig(name, patch) {
  const entry = entryFor(name)
  const described = describe(entry)
  validatePatch(patch, described.effective, described.types)
  let doc
  if (fs.existsSync(entry.targetFile)) doc = parseDoc(readText(entry.targetFile))
  else if (entry.defaultFile && fs.existsSync(entry.defaultFile)) doc = parseDoc(readText(entry.defaultFile))
  else doc = parseDoc("{}")
  applyPatch(doc, patch)
  await writeFileAtomic(path.resolve(entry.targetFile), String(doc))
  if (entry.core) delete cfg.config[`config.${entry.name.slice(5)}`]
  invalidateDiscovery()
  return await getConfig(name)
}

export async function saveConfig(name, patch) {
  const entry = entryFor(name)
  if (entry.special === "miao-help") return saveMiaoHelp(entry, patch)
  return writeConfig(name, patch)
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
