import store from "./store.js"

const PREFIX = "mem"
const MAX_PER_USER = 30
const MAX_VALUE_LEN = 100

function normalizeKey(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, "_")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "_"
}

/** 用户长期记忆，LevelDB 持久化。key 自动规范化为小写下划线，value 限长。 */
class MemoryManager {
  async set(user_id, key, value) {
    const nk = normalizeKey(key)
    const nv = String(value).trim().slice(0, MAX_VALUE_LEN)
    if (!nv) return false

    const existing = await this._keys(user_id)
    if (!existing.includes(nk) && existing.length >= MAX_PER_USER) {
      throw new Error(`Memory limit reached (${MAX_PER_USER} entries). Use forget to remove old memories first.`)
    }

    await store.set(`${PREFIX}:${user_id}:${nk}`, nv)
    return true
  }

  async get(user_id, key) {
    return store.get(`${PREFIX}:${user_id}:${normalizeKey(key)}`)
  }

  async del(user_id, key) {
    return store.del(`${PREFIX}:${user_id}:${normalizeKey(key)}`)
  }

  async _keys(user_id) {
    const prefix = `${PREFIX}:${user_id}:`
    const raw = await store.keys(prefix)
    return raw.map(k => k.replace(prefix, "")).filter(Boolean)
  }

  async getAll(user_id) {
    const keys = await this._keys(user_id)
    if (!keys.length) return {}

    const result = {}
    for (const k of keys) {
      const val = await store.get(`${PREFIX}:${user_id}:${k}`)
      if (val !== null) result[k] = val
    }
    return result
  }

  async clear(user_id) {
    await store.delByPrefix(`${PREFIX}:${user_id}:`)
  }

  async clearAll() {
    await store.delByPrefix(`${PREFIX}:`)
  }

  /** 将记忆格式化为系统提示词上下文 */
  async toContext(user_id) {
    const mems = await this.getAll(user_id)
    if (!Object.keys(mems).length) return ""
    const lines = ["\n<user_memory>"]
    for (const [k, v] of Object.entries(mems)) lines.push(`- ${k}: ${v}`)
    lines.push("</user_memory>")
    return lines.join("\n")
  }
}

export default new MemoryManager()
