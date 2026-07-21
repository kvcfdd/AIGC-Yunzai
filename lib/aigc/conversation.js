import store from "./store.js"

const PREFIX = "conv"
const MEM_PREFIX = "mem"
const MAX_MEMORIES = 10
const MAX_MEMORY_CHARS = 200

function dateStr(date) {
  const d = date || new Date()
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function yesterdayStr() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return dateStr(d)
}

/** 会话管理，LevelDB 持久化，按日期分键 */
class ConversationManager {
  sessionKey(self_id, user_id, date) {
    return `${PREFIX}:${self_id}:${user_id}:${date || dateStr()}`
  }

  async _read(key) {
    const session = await store.get(key)
    return session || null
  }

  async _write(key, session) {
    await store.set(key, session)
  }

  async addMessage(sessionKey, role, content, extra = {}) {
    let session = await this._read(sessionKey)
    if (!session) session = { messages: [], createdAt: Date.now() }

    const msg = { role, ...extra }
    if (content !== undefined) msg.content = content
    session.messages.push(msg)
    await this._write(sessionKey, session)
    return session
  }

  /** 批量追加消息，用于整轮对话原子落盘 */
  async appendMessages(sessionKey, msgs) {
    if (!msgs.length) return
    let session = await this._read(sessionKey)
    if (!session) session = { messages: [], createdAt: Date.now() }
    for (const m of msgs) {
      const msg = { role: m.role }
      if (m.content !== undefined) msg.content = m.content
      for (const [k, v] of Object.entries(m)) {
        if (k !== "role" && k !== "content") msg[k] = v
      }
      session.messages.push(msg)
    }
    await this._write(sessionKey, session)
  }

  /** 设置/替换 system 消息 */
  async setSystem(sessionKey, prompt) {
    let session = await this._read(sessionKey)
    if (!session) session = { messages: [], createdAt: Date.now() }

    if (session.messages[0]?.role === "system") {
      session.messages[0].content = prompt
    } else {
      session.messages.unshift({ role: "system", content: prompt })
    }
    await this._write(sessionKey, session)
  }

  async getMessages(self_id, user_id, maxRounds = 10, keepImagesRounds = 5) {
    const prefix = `${PREFIX}:${self_id}:${user_id}:`
    const keys = await store.keys(prefix)
    if (!keys.length) return []

    // 取实际存在的最近 2 个日期键
    const recentKeys = keys.sort().slice(-2)
    const all = []
    for (const key of recentKeys) {
      const session = await this._read(key)
      if (session?.messages?.length) all.push(...session.messages)
    }
    if (!all.length) return []

    // 按 user 起头拆轮次，只取最近 maxRounds 轮
    const rounds = []
    let current = []
    for (const msg of all) {
      if (msg.role === "system") continue
      if (msg.role === "user" && current.length > 0) {
        rounds.push(current)
        current = []
      }
      current.push(msg)
    }
    if (current.length > 0) rounds.push(current)

    const selected = rounds.slice(-maxRounds)
    const fullStart = Math.max(0, selected.length - keepImagesRounds)
    const result = []
    for (let i = 0; i < selected.length; i++) {
      if (i >= fullStart) {
        result.push(...selected[i])
      } else {
        const userMsg = selected[i].find(m => m.role === "user")
        if (userMsg) {
          const trimmed = { ...userMsg }
          if (trimmed.images?.length) trimmed.content = (trimmed.content || "").replace(/\[图片\]/g, "[图片已过期]")
          delete trimmed.images
          result.push(trimmed)
        }
        for (let j = selected[i].length - 1; j >= 0; j--) {
          const m = selected[i][j]
          if (m.role === "assistant" && m.content) {
            result.push({ role: "assistant", content: m.content })
            break
          }
        }
      }
    }
    return result
  }

  /** 删除指定日期之前、且已有记忆总结的对话键 */
  async deleteOlderThan(self_id, user_id, date) {
    const prefix = `${PREFIX}:${self_id}:${user_id}:`
    const keys = await store.keys(prefix)
    const memEntry = await store.get(this.memoryKey(self_id, user_id))
    const summarized = new Set(memEntry?.entries?.map(e => e.date) || [])
    for (const key of keys) {
      const keyDate = key.split(":").pop()
      if (keyDate < date && summarized.has(keyDate)) {
        await store.del(key)
      }
    }
  }

  async clearSession(self_id, user_id) {
    const prefix = `${PREFIX}:${self_id}:${user_id}:`
    await store.delByPrefix(prefix)
    await store.del(this.interactionKey(self_id, user_id))
  }

  /** 清除记忆 */
  async clearMemory(self_id, user_id) {
    await store.del(this.memoryKey(self_id, user_id))
  }

  async clearAll() {
    await store.delByPrefix(`${PREFIX}:`)
    await store.delByPrefix(`iact:`)
  }

  /** 清除所有用户的记忆 */
  async clearAllMemories() {
    await store.delByPrefix(`${MEM_PREFIX}:`)
  }

  /** 按轮次裁剪到指定轮数: 最近 maxRounds 轮完整保留，更早轮次压缩为纯 QA */
  trimTo(session, maxRounds = 5) {
    const hasSystem = session.messages[0]?.role === "system"
    const systemMsg = hasSystem ? [session.messages[0]] : []
    let rest = hasSystem ? session.messages.slice(1) : session.messages.slice()

    const rounds = []
    let current = []
    for (const msg of rest) {
      if (msg.role === "user" && current.length > 0) {
        rounds.push(current)
        current = []
      }
      current.push(msg)
    }
    if (current.length > 0) rounds.push(current)

    const totalRounds = rounds.length
    const fullStart = Math.max(0, totalRounds - maxRounds)
    const processed = []

    for (let i = 0; i < totalRounds; i++) {
      if (i >= fullStart) {
        // 最近 maxRounds 轮完整保留
        processed.push(...rounds[i])
      } else {
        // 老轮次压缩：只保留 user 问 + 最终 assistant 答，去图片/视频，占位标记为已过期
        const userMsg = rounds[i].find(m => m.role === "user")
        if (userMsg) {
          const trimmed = { ...userMsg }
          if (trimmed.images?.length) trimmed.content = (trimmed.content || "").replace(/\[图片\]/g, "[图片已过期]")
          delete trimmed.images
          processed.push(trimmed)
        }

        for (let j = rounds[i].length - 1; j >= 0; j--) {
          const m = rounds[i][j]
          if (m.role === "assistant" && m.content) {
            processed.push({ role: "assistant", content: m.content })
            break
          }
        }
      }
    }

    session.messages = [...systemMsg, ...processed]
  }
  /** 记忆管理，LevelDB 持久化，按 self_id:user_id 分键 */
  memoryKey(self_id, user_id) {
    return `${MEM_PREFIX}:${self_id}:${user_id}`
  }

  /** 检查指定日期是否已有记忆 */
  async hasMemoryForDate(self_id, user_id, date) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    return entry?.entries?.some(e => e.date === date) ?? false
  }

  /** 获取格式化记忆文本，注入 system prompt */
  async getMemories(self_id, user_id) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    if (!entry?.entries?.length) return ""
    const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    return entry.entries
      .map(e => {
        const [y, m, d] = e.date.split("-").map(Number)
        const w = WEEKDAY[new Date(y, m - 1, d).getDay()]
        return `[${e.date} ${w}] ${e.summary}`
      })
      .join("\n")
  }

  /** 获取原始记忆条目数组 [{ date, summary }] */
  async getMemoryEntries(self_id, user_id) {
    const entry = await store.get(this.memoryKey(self_id, user_id))
    return entry?.entries?.length ? entry.entries : null
  }

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
  }

  /** 记录当天活跃用户，避免凌晨全表扫描 */
  async addActiveUser(date, self_id, user_id) {
    const key = `active:${date}`
    const entry = (await store.get(key)) || { users: [] }
    const uid = `${self_id}:${user_id}`
    if (!entry.users.includes(uid)) {
      entry.users.push(uid)
      await store.set(key, entry)
    }
  }

  /** 获取指定日期有对话记录的所有用户 */
  async scanUsersForDate(date) {
    const entry = await store.get(`active:${date}`)
    return entry?.users || []
  }

  /** 清理指定日期的活跃用户记录 */
  async clearActiveUsersForDate(date) {
    await store.del(`active:${date}`)
  }

  /** 获取所有活跃日期 */
  async scanAllActiveDates() {
    const keys = await store.keys("active:")
    return keys
      .map(k => k.slice(7)) // "active:2026-07-06" → "2026-07-06"
      .sort()
  }

  /** Interactions API 有状态模式 — 存储/读取/清除 interaction_id */
  interactionKey(self_id, user_id) {
    return `iact:${self_id}:${user_id}`
  }

  async getInteractionId(self_id, user_id) {
    const raw = await store.get(this.interactionKey(self_id, user_id))
    return raw?.id || null
  }

  async setInteractionId(self_id, user_id, id) {
    await store.set(this.interactionKey(self_id, user_id), { id, updatedAt: Date.now() })
  }

  async clearInteractionId(self_id, user_id) {
    await store.del(this.interactionKey(self_id, user_id))
  }

  /** 将对话消息提取为纯 QA 文本 */
  extractQA(messages) {
    const lines = []
    for (const m of messages) {
      if (m.role === "system") continue
      if (m.tool_calls) continue
      if (m.role === "tool") continue
      if (m.role === "user" || m.role === "assistant") {
        let text = m.content || ""
        if (m.images?.length) text += " [图片]"
        if (m.file) text += " [文件]"
        if (!text) continue
        lines.push(`${m.role === "user" ? "用户" : "AI助手"}: ${text}`)
      }
    }
    return lines.join("\n")
  }
}

export default new ConversationManager()
export { dateStr, yesterdayStr }
