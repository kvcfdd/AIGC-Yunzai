import store from "../store.js"
import { WEEKDAYS } from "../helpers/time.js"

const MEM_PREFIX = "mem"
const MAX_MEMORIES = 10
const MAX_MEMORY_CHARS = 200

export default {
  /** 记忆管理，LevelDB 持久化，按 self_id:user_id 分键 */
  memoryKey(self_id, user_id) {
    return `${MEM_PREFIX}:${self_id}:${user_id}`
  },

  /** 检查指定日期是否已有记忆 */
  async hasMemoryForDate(self_id, user_id, date) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    return entry?.entries?.some(e => e.date === date) ?? false
  },

  /** 获取格式化记忆文本，注入 system prompt */
  async getMemories(self_id, user_id) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    if (!entry?.entries?.length) return ""
    return entry.entries
      .map(e => {
        const [y, m, d] = e.date.split("-").map(Number)
        const w = WEEKDAYS[new Date(y, m - 1, d).getDay()]
        return `[${e.date} ${w}] ${e.summary}`
      })
      .join("\n")
  },

  /** 获取原始记忆条目数组 [{ date, summary }] */
  async getMemoryEntries(self_id, user_id) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    return entry?.entries?.length ? entry.entries : null
  },

  /** 新增一条记忆，自动截断到 200 字、最多保留 10 条 */
  async addMemory(self_id, user_id, date, summary) {
    const key = this.memoryKey(self_id, user_id)
    const entry = (await store.get(key)) || { entries: [] }
    const trimmed = summary.length > MAX_MEMORY_CHARS ? summary.slice(0, MAX_MEMORY_CHARS) : summary
    entry.entries.push({ date, summary: trimmed })
    if (entry.entries.length > MAX_MEMORIES) {
      entry.entries = entry.entries.slice(-MAX_MEMORIES)
    }
    entry.updatedAt = Date.now()
    await store.set(key, entry)
  },

  /** 清除记忆 */
  async clearMemory(self_id, user_id) {
    await store.del(this.memoryKey(self_id, user_id))
  },

  /** 清除所有用户的记忆 */
  async clearAllMemories() {
    await store.delByPrefix(`${MEM_PREFIX}:`)
  },
}
