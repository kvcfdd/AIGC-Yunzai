import fs from "node:fs"
import YAML from "yaml"

/**
 * 把 default_config 中新增的配置项合并进用户配置
 * 只添加用户配置里不存在的键；已有值一律保留
 * 用 parseDocument 读写以保留 YAML 注释
 * @param {string} defaultFile 默认配置文件路径
 * @param {string} userFile    用户配置文件路径
 * @returns {boolean} 是否写入了文件
 */
export function mergeDefaultConfig(defaultFile, userFile) {
  let defDoc
  let userDoc
  try {
    defDoc = YAML.parseDocument(fs.readFileSync(defaultFile, "utf8"))
    userDoc = YAML.parseDocument(fs.readFileSync(userFile, "utf8"))
  } catch {
    return false
  }
  if (defDoc.errors.length || userDoc.errors.length) return false

  let changed = false
  if (userDoc.contents == null) {
    if (defDoc.contents == null) return false
    userDoc.contents = defDoc.contents
    changed = true
  } else {
    changed = mergeNode(userDoc.contents, defDoc.contents)
  }
  if (!changed) return false

  return writeAtomic(userFile, String(userDoc))
}

/** 递归补键；返回是否有改动 */
function mergeNode(userNode, defNode) {
  if (!YAML.isMap(userNode) || !YAML.isMap(defNode)) return false

  let changed = false
  for (const pair of defNode.items) {
    const key = pair.key?.value
    if (key === undefined) continue

    if (!userNode.has(key)) {
      // 直接复用默认文档的节点，键/值上的注释一并带过来
      userNode.items.push(new YAML.Pair(pair.key, pair.value))
      changed = true
      continue
    }

    const userValue = userNode.get(key, true)
    if (YAML.isMap(userValue) && YAML.isMap(pair.value)) {
      if (mergeNode(userValue, pair.value)) changed = true
    }
  }
  return changed
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`
  let mode
  try {
    mode = fs.statSync(file).mode
  } catch {}

  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    try {
      fs.writeFileSync(file, content, "utf8")
      return true
    } catch {
      return false
    }
  }
}
