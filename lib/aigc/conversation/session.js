import store from "../store.js"
import { dateStr } from "./dates.js"

const PREFIX = "conv"
const MAX_ROUNDS = 15 // 会话保留轮次
const TOOL_FULL_ROUNDS = 7 // 工具消息完整保留的最近轮数
const TOOL_MAX_CHARS = 200 // 更早轮次工具消息的截断长度

/** 按 user 起头拆轮次: 新轮只在 user 消息且上一条非 user 时开启；
 *  打断合并产生的连续 user 消息并入同一轮，不与 LLM 输出配对成多轮 */
function splitRounds(messages) {
  const rounds = []
  let current = []
  for (const msg of messages) {
    if (msg.role === "system") continue
    if (msg.role === "user" && current.length > 0 && current[current.length - 1].role !== "user") {
      rounds.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) rounds.push(current)
  return rounds
}

export default {
  sessionKey(self_id, user_id, date) {
    return `${PREFIX}:${self_id}:${user_id}:${date || dateStr()}`
  },

  async getSession(key) {
    const session = await store.get(key)
    return session || null
  },

  async saveSession(key, session) {
    await store.set(key, session)
  },

  /** 批量追加消息，用于整轮对话原子落盘 */
  async appendMessages(sessionKey, msgs) {
    if (!msgs.length) return
    let session = await this.getSession(sessionKey)
    if (!session) session = { messages: [], createdAt: Date.now() }
    for (const m of msgs) {
      const msg = { role: m.role }
      if (m.content !== undefined) msg.content = m.content
      for (const [k, v] of Object.entries(m)) {
        if (k !== "role" && k !== "content") msg[k] = v
      }
      session.messages.push(msg)
    }
    await this.saveSession(sessionKey, session)
  },

  async getMessages(self_id, user_id, maxRounds = MAX_ROUNDS) {
    const prefix = `${PREFIX}:${self_id}:${user_id}:`
    const keys = await store.keys(prefix)
    if (!keys.length) return []

    // 取实际存在的最近 2 个日期键
    const recentKeys = keys.sort().slice(-2)
    const all = []
    for (const key of recentKeys) {
      const session = await this.getSession(key)
      if (session?.messages?.length) all.push(...session.messages)
    }
    if (!all.length) return []

    // 按 user 起头拆轮次，只取最近 maxRounds 轮
    const rounds = splitRounds(all)

    // 工具消息最新 TOOL_FULL_ROUNDS 轮完整保留，更早轮次截断到 TOOL_MAX_CHARS 字
    const fullStart = Math.max(0, rounds.length - TOOL_FULL_ROUNDS)
    rounds.forEach((round, i) => {
      if (i < fullStart) {
        for (const m of round) {
          if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_MAX_CHARS) {
            m.content = m.content.slice(0, TOOL_MAX_CHARS) + "..."
          }
        }
      }
    })

    // 最近 maxRounds 轮完整返回；媒体已不落盘编码，无需降级
    return rounds.slice(-maxRounds).flat()
  },

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
  },

  async clearSession(self_id, user_id) {
    const prefix = `${PREFIX}:${self_id}:${user_id}:`
    await store.delByPrefix(prefix)
    await store.del(this.interactionKey(self_id, user_id))
  },

  async clearAll() {
    await store.delByPrefix(`${PREFIX}:`)
    await store.delByPrefix(`iact:`)
  },

  /** 按轮次裁剪到指定轮数: 最近 maxRounds 轮完整保留(含工具调用记录)，更早轮次直接丢弃
   *  媒体落盘已是 [xx](路径) 标记且缓存文件长存，无需降级替换，标记原样保留 */
  trimTo(session, maxRounds = MAX_ROUNDS) {
    const hasSystem = session.messages[0]?.role === "system"
    const systemMsg = hasSystem ? [session.messages[0]] : []
    let rest = hasSystem ? session.messages.slice(1) : session.messages.slice()

    // 最近 maxRounds 轮完整保留，更早轮次丢弃
    session.messages = [...systemMsg, ...splitRounds(rest).slice(-maxRounds).flat()]
  },

  /** 将对话消息提取为纯 QA 文本
   *  opts: { userLabel, aiLabel, toolLabel } — 自定义角色标识；默认 user/"我"/工具 */
  extractQA(messages, opts = {}) {
    const { userLabel, aiLabel, toolLabel } = opts
    const user = userLabel ?? "user"
    const ai = aiLabel ?? "我"
    const tool = toolLabel ?? "工具"
    const MAX_TOOL_TEXT = 50 // 单个工具结果展示上限，避免超长结果撑爆总结输入
    const lines = []
    for (const m of messages) {
      if (m.role === "system") continue
      if (m.role === "tool") {
        let text = m.content || ""
        if (typeof text !== "string") text = JSON.stringify(text)
        if (m.images?.length) text += " [图片]"
        if (m.videos?.length) text += " [视频]"
        if (m.audios?.length) text += " [语音]"
        if (m.files?.length) text += " [文件]"
        if (!text) continue
        if (text.length > MAX_TOOL_TEXT) text = text.slice(0, MAX_TOOL_TEXT) + "..."
        lines.push(`${tool}${m.name ? `(${m.name})` : ""}: ${text}`)
        continue
      }
      if (m.role === "user" || m.role === "assistant") {
        let text = m.content || ""
        if (m.tool_calls?.length && !text) {
          text = `[调用工具: ${m.tool_calls
            .map(tc => tc.function?.name)
            .filter(Boolean)
            .join(", ")}]`
        }
        if (m.images?.length) text += " [图片]"
        if (m.videos?.length) text += " [视频]"
        if (m.audios?.length) text += " [语音]"
        if (m.files?.length) text += " [文件]"
        if (!text) continue
        lines.push(`${m.role === "user" ? user : ai}: ${text}`)
      }
    }
    return lines.join("\n")
  },
}
