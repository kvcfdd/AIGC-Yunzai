import cfg from "../config/config.js"
import store from "./store.js"

const PREFIX = "conv"

/** 会话管理，LevelDB 持久化，按消息轮数自动裁剪 */
class ConversationManager {
  /** 生成会话键: conv:self_id:user_id，每用户全局一份对话记录 */
  sessionKey(self_id, user_id, group_id = "") {
    return `${PREFIX}:${self_id}:${user_id}`
  }

  async _read(key) {
    const session = await store.get(key)
    return session || null
  }

  async _write(key, session) {
    this._trim(session)
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

  /** 批量追加消息，一次读写一次裁剪。用于整轮对话原子落盘 */
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

  async getMessages(sessionKey) {
    const session = await this._read(sessionKey)
    if (!session) return []
    this._trim(session)
    return [...session.messages]
  }

  async clearSession(sessionKey) {
    await store.del(sessionKey)
  }

  async clearAll() {
    await store.delByPrefix(`${PREFIX}:`)
  }

  /** 按轮次裁剪：每轮从 user 到下一次 user 前为一个完整回答轮次。
   *  config max_history 控制总保留轮数，最近 10 轮（或全部，若总数更少）完整保留，更早的轮次只保留 user 问 + 最后一轮 assistant 答。 */
  _trim(session) {
    const maxHistory = cfg.aigc?.max_history || 30

    const hasSystem = session.messages[0]?.role === "system"
    const systemMsg = hasSystem ? [session.messages[0]] : []
    let rest = hasSystem ? session.messages.slice(1) : session.messages.slice()

    // 按 user 起头拆分为轮次
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

    // 只保留最近 maxHistory 个完整轮次
    if (rounds.length > maxHistory) {
      rounds.splice(0, rounds.length - maxHistory)
    }

    const keepFull = Math.min(5, rounds.length)
    const fullStart = rounds.length - keepFull
    const processed = []

    for (let i = 0; i < rounds.length; i++) {
      if (i >= fullStart) {
        // 最新 keepFull 轮完整保留
        processed.push(...rounds[i])
      } else {
        // 老轮次：只保留 user 问 + 最终 assistant 答，图片 base64 过大移除
        const userMsg = rounds[i].find(m => m.role === "user")
        if (userMsg) {
          const trimmed = { ...userMsg }
          delete trimmed.images
          processed.push(trimmed)
        }

        // 从后往前取最后一个有 content 的 assistant 消息（即该轮的最终回复）
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
}

export default new ConversationManager()
