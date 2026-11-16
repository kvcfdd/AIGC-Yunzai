import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import tools from "../tool-registry.js"
import { WORKSPACE_ROOT, displayPath } from "../workspace.js"

const RESOURCES = path.join(WORKSPACE_ROOT, "plugins", "miao-plugin", "resources")
const GAMES = { gs: "原神", sr: "星铁", zzz: "绝区零", mc: "鸣潮" }
const CATEGORIES = { character: "角色", weapon: "武器", artifact: "套装" }
const MAX_TREE_ENTRIES = 100
const MAX_TREE_DEPTH = 4

/** 与 miao-plugin 的 Meta 查询一致：去空白、忽略大小写 */
function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
}

/** 读取 JSON；文件缺失或格式错误时返回 null */
async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

/** 动态导入 miao-plugin 的 alias.js */
async function loadAlias(file) {
  try {
    return await import(pathToFileURL(file).href)
  } catch {
    return {}
  }
}

/** 写入别名映射：同一个键只保留第一次出现的原名 */
function addAlias(map, alias, name) {
  const key = normalize(alias)
  if (key && !map.has(key)) map.set(key, name)
}

/** miao 的 { 原名: "别称1,别称2,..." } → 别称映射 */
function addAliases(map, aliases) {
  if (!aliases || typeof aliases !== "object") return
  for (const [name, value] of Object.entries(aliases)) {
    addAlias(map, name, name)
    if (typeof value !== "string") continue
    for (const alias of value.split(",")) addAlias(map, alias, name)
  }
}

async function isDirectory(file) {
  try {
    return (await fs.stat(file)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** 目录 → 相对路径列表；目录以 / 结尾，超过上限时标记 truncated */
async function listTree(root) {
  const tree = []
  let truncated = false
  const walk = async (dir, prefix, depth) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const entry of entries) {
      if (tree.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        tree.push(`${rel}/`)
        if (depth < MAX_TREE_DEPTH) await walk(path.join(dir, entry.name), rel, depth + 1)
        else truncated = true
      } else if (entry.isFile()) {
        tree.push(rel)
      }
    }
  }
  await walk(root, "", 1)
  return { tree, truncated }
}

async function resolveCharacter(game, query) {
  const base = path.join(RESOURCES, `meta-${game}`, "character")
  const data = await readJSON(path.join(base, "data.json"))
  if (!data) throw new Error(`miao-plugin 缺少 ${GAMES[game]} 角色数据`)

  const names = new Map()
  for (const [id, item] of Object.entries(data)) {
    if (!item?.name) continue
    addAlias(names, item.name, item.name)
    addAlias(names, id, item.name)
    if (item.abbr) addAlias(names, item.abbr, item.name)
  }
  const alias = await loadAlias(path.join(base, "alias.js"))
  addAliases(names, alias.alias)
  addAliases(names, alias.abbr)

  const name = names.get(normalize(query))
  if (!name) return null
  const root = path.join(base, name)
  if (!(await isDirectory(root))) return null
  return { name, root, dataFiles: [path.join(root, "data.json")] }
}

async function resolveWeapon(game, query) {
  const base = path.join(RESOURCES, `meta-${game}`, "weapon")
  const items = new Map()
  const add = (item, type) => {
    if (!item?.name) return
    const value = { name: item.name, type: item.type || type }
    addAlias(items, item.name, value)
    addAlias(items, item.id, value)
    if (item.abbr) addAlias(items, item.abbr, value)
  }

  // gs / zzz / mc 按武器类型拆分 data.json，sr 是单一 data.json
  if (game === "sr") {
    const data = await readJSON(path.join(base, "data.json"))
    for (const item of Object.values(data || {})) add(item, item.type)
  } else {
    let types = []
    try {
      types = (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      /* 缺少资源目录时按未找到处理 */
    }
    for (const type of types) {
      const data = await readJSON(path.join(base, type, "data.json"))
      for (const item of Object.values(data || {})) add(item, type)
    }
  }

  const alias = await loadAlias(path.join(base, "alias.js"))
  const aliases = new Map()
  addAliases(aliases, alias.alias || alias.aliasCfg)
  addAliases(aliases, alias.abbr)

  let item = items.get(normalize(query))
  if (!item) {
    const name = aliases.get(normalize(query))
    if (name) item = items.get(normalize(name))
  }
  if (!item?.type) return null
  const root = path.join(base, item.type, item.name)
  if (!(await isDirectory(root))) return null
  return { name: item.name, root, dataFiles: [path.join(root, "data.json")], extra: { weapon_type: item.type } }
}

async function resolveArtifact(game, query) {
  const base = path.join(RESOURCES, `meta-${game}`, "artifact")
  const data = await readJSON(path.join(base, "data.json"))
  if (!data) throw new Error(`miao-plugin 缺少 ${GAMES[game]} 套装数据`)

  const sets = new Map()
  for (const [id, item] of Object.entries(data)) {
    if (!item?.name) continue
    addAlias(sets, item.name, item.name)
    addAlias(sets, id, item.name)
  }
  const alias = await loadAlias(path.join(base, "alias.js"))
  addAliases(sets, alias.setAlias || alias.aliasCfg || alias.alias)
  addAliases(sets, alias.setAbbr || alias.artiSetAbbr)

  const name = sets.get(normalize(query))
  if (!name) return null
  // 原神套装图片在 artifact/imgs/<套装>，其他游戏在 artifact/<套装>
  const root = path.join(base, game === "gs" ? "imgs" : "", name)
  if (!(await isDirectory(root))) return null
  return { name, root, dataFiles: [path.join(base, "data.json")] }
}

tools.register({
  name: "miao_data",
  description: "Locate miao-plugin data for a game character, weapon or artifact set. Resolves miao aliases and returns the project-relative root, a path tree relative to it, and the main data files; inspect them with read/glob/grep before answering.",
  parameters: {
    type: "object",
    properties: {
      game: { type: "string", enum: Object.keys(GAMES), description: "gs = 原神, sr = 星铁, zzz = 绝区零, mc = 鸣潮." },
      type: { type: "string", enum: Object.keys(CATEGORIES), description: "character = 角色, weapon = 武器, artifact = 套装/圣遗物/遗器/驱动盘." },
      name: { type: "string", description: "Character, weapon or artifact set name. miao-plugin aliases are supported, e.g. 雷神, 绝缘套, 阿莫斯." },
    },
    required: ["game", "type", "name"],
  },
  execute: async args => {
    const game = String(args?.game ?? "").trim()
    const type = String(args?.type ?? "").trim()
    const query = String(args?.name ?? "").trim()
    if (!GAMES[game]) throw new Error(`game 必须是 ${Object.keys(GAMES).join(" / ")} 之一`)
    if (!CATEGORIES[type]) throw new Error(`type 必须是 ${Object.keys(CATEGORIES).join(" / ")} 之一`)
    if (!query) throw new Error("name 不能为空")

    const resolved = type === "character" ? await resolveCharacter(game, query) : type === "weapon" ? await resolveWeapon(game, query) : await resolveArtifact(game, query)
    if (!resolved) throw new Error(`未找到${GAMES[game]}的${CATEGORIES[type]}: ${query}`)

    const { tree, truncated } = await listTree(resolved.root)
    const dataFiles = []
    for (const file of resolved.dataFiles) if (await isFile(file)) dataFiles.push(displayPath(file))
    return {
      game,
      type,
      query,
      name: resolved.name,
      ...(resolved.extra || {}),
      root: displayPath(resolved.root),
      tree,
      data_files: dataFiles,
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
