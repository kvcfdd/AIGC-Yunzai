import log from "../helpers/log.js"
import store from "./sqlite-store.js"
import { CONTEXT_KEEP_TURNS } from "../core/tool-compaction.js"
import { HISTORY_CREATED_AT, HISTORY_TURN, prepareForPersist } from "./persist.js"
import { clearAllSummaries, clearUserSummaries } from "./summary-store.js"

/** 落盘时无条件丢弃的媒体字段 —— _persistRound 已把它们转成文本标记 */
const MEDIA_KEYS = new Set(["images", "image_paths", "videos", "video_paths", "audios", "audio_paths", "files", "file_paths"])

/** 行 → 消息对象。payload 原样展开，任何字段都不做解释/改名/解析 ——
 *  tool_calls[].function.arguments 是 JSON 字符串，一旦被「规范化」成对象，
 *  回放时会带着空参数发出且不报错
 *  轮次以 Symbol 挂在消息上，供上下文裁剪按轮分组；Symbol 不落库 */
function rowToMessage(row) {
  let payload = {}
  try {
    payload = JSON.parse(row.payload) || {}
  } catch {
    log.warn(`对话记录附加字段解析失败 (turn=${row.turn})，已忽略`)
  }
  const message = { role: row.role, content: row.content, ...payload }
  message[HISTORY_TURN] = row.turn
  if (row.created_at) message[HISTORY_CREATED_AT] = row.created_at
  return message
}

/** aigc_message 行记录 */
function packMessage(sid, m, turn) {
  const payload = {}
  for (const [k, v] of Object.entries(m)) {
    if (k === "role" || k === "content" || MEDIA_KEYS.has(k)) continue
    payload[k] = v
  }
  return {
    self_id: sid.self_id,
    user_id: sid.user_id,
    turn,
    role: m.role,
    content: m.content ?? null,
    created_at: Number(m[HISTORY_CREATED_AT]) || Number(m.time) || Date.now(),
    payload: JSON.stringify(payload),
  }
}

/** aigc_context 行记录 */
function packContextMessage(sid, m, turn, seq) {
  const payload = {}
  for (const [k, v] of Object.entries(m)) {
    if (k === "role" || k === "content" || MEDIA_KEYS.has(k)) continue
    payload[k] = v
  }
  return {
    self_id: sid.self_id,
    user_id: sid.user_id,
    turn,
    seq,
    role: m.role,
    content: m.content ?? null,
    payload: JSON.stringify(payload),
    created_at: Number(m[HISTORY_CREATED_AT]) || Number(m.time) || Date.now(),
  }
}

/** 按历史轮次分组；无轮次标记的消息另起一组 */
function groupByTurn(messages) {
  const groups = []
  for (const m of messages || []) {
    const turn = m?.[HISTORY_TURN]
    const last = groups.at(-1)
    if (!last || (turn == null ? last.turn != null : last.turn !== turn)) groups.push({ turn, messages: [] })
    groups.at(-1).messages.push(m)
  }
  return groups
}

/** 会话级增量 token 计数与轮末压缩锁 */
const sessionTokens = new Map()
const pendingCompactions = new Map()
const fallbackContexts = new Map()
const sessionKeyStr = (self_id, user_id) => `${String(self_id)}:${String(user_id)}`

/** 对话上下文管理，SQLite 持久化，按用户与时间组织，轮次写入时物化
 *  方法按职责拆分于子模块，经原型合并保持 this 互调 */
export default {
  /** 会话标识 —— 统一转字符串: 框架有时给 number 有时给 string */
  sessionKey(self_id, user_id) {
    return { self_id: String(self_id), user_id: String(user_id) }
  },

  /** 上一次响应的 token 总数，进程内保存 */
  getSessionTokens(self_id, user_id) {
    return sessionTokens.get(sessionKeyStr(self_id, user_id)) || 0
  },

  setSessionTokens(self_id, user_id, tokens) {
    const key = sessionKeyStr(self_id, user_id)
    const value = Math.max(0, Math.floor(Number(tokens) || 0))
    if (value) sessionTokens.set(key, value)
    else sessionTokens.delete(key)
  },

  /** 登记轮末异步压缩；同一会话的下一轮会 await 它 */
  beginCompaction(self_id, user_id, promise) {
    const key = sessionKeyStr(self_id, user_id)
    const tracked = Promise.resolve(promise).catch(err => log.warn(`上下文压缩失败: ${err.message}`))
    pendingCompactions.set(key, tracked)
    tracked.finally(() => {
      if (pendingCompactions.get(key) === tracked) pendingCompactions.delete(key)
    })
    return tracked
  },

  awaitCompaction(self_id, user_id) {
    return pendingCompactions.get(sessionKeyStr(self_id, user_id)) || Promise.resolve()
  },

  /** 整轮原子落盘到只增不减的历史表 —— 旧轮次永不删除 */
  async appendMessages(sid, msgs) {
    if (!msgs?.length) return null
    let turn = 1
    store.transaction(() => {
      const last = store.lastMessage(sid)
      turn = (last?.turn ?? 0) + 1
      store.insertMany(msgs.map(m => packMessage(sid, m, turn)))
    })
    return { turn }
  },

  /** 一轮对话原子落盘。旁听等无需持久化的场景传 persist=false。
   *  落盘前把媒体编码转为文本标记，并删除媒体字段。
   *  contextMsgs 是实际发送给模型的版本
   *  msgs 保持完整版本写入只增不减的历史表，供定时总结使用 */
  async appendRound(sid, msgs, { persist = true, contextMsgs = msgs } = {}) {
    if (!persist || !msgs?.length) return
    const prepare = list =>
      list.map(m => {
        const copy = { ...m }
        prepareForPersist(copy)
        return copy
      })
    const fallback = fallbackContexts.has(sessionKeyStr(sid.self_id, sid.user_id))
    const fallbackSummary = fallback ? store.contextRows(sid).find(row => row.role === "summary")?.content || "" : ""
    const full = prepare(msgs)
    const result = await this.appendMessages(sid, full)
    // 实际上下文是辅助缓存，写入失败不应影响已生成回复的落盘与发送；
    // 追加失败时清空实际上下文，下一次读取回退到已包含本轮的完整历史，再由压缩重建
    let contextAppendFailed = false
    try {
      if (store.hasContext(sid)) {
        const records = (contextMsgs === msgs ? full : prepare(contextMsgs)).map((m, seq) => packContextMessage(sid, m, 0, seq))
        if (fallback) {
          const previous = store.contextRows(sid).filter(row => row.role !== "summary")
          const recent = previous.map(row => ({
            self_id: sid.self_id,
            user_id: sid.user_id,
            turn: row.turn,
            seq: row.seq,
            role: row.role,
            content: row.content,
            payload: row.payload,
            created_at: row.created_at,
          }))
          // 新记录接在已有轮次之后，避免与摘要行 (turn=0, seq=0) 主键冲突
          const nextTurn = previous.reduce((max, row) => Math.max(max, Number(row.turn) || 0), 0) + 1
          const merged = records.map((record, seq) => ({ ...record, turn: nextTurn, seq }))
          store.replaceContext(sid, fallbackSummary, [...recent, ...merged])
        } else store.appendContextMessages(sid, records)
      }
    } catch (err) {
      contextAppendFailed = true
      log.warn(`实际上下文追加失败，回退到完整历史: ${err.message}`)
      fallbackContexts.set(sessionKeyStr(sid.self_id, sid.user_id), true)
      try {
        store.clearContextMessages(sid)
      } catch (clearErr) {
        log.warn(`实际上下文消息清理失败: ${clearErr.message}`)
      }
    }
    return { ...(result || {}), contextAppendFailed }
  },

  /** 读取实际上下文：有上下文表时用摘要 + 最近若干轮；
   *  冷启动时只带原表最近 10 轮，并以这 10 轮播种上下文表，
   *  避免首次请求携带积压历史，同时立即进入两表模式 */
  async getMessages(self_id, user_id) {
    const sid = this.sessionKey(self_id, user_id)
    const key = sessionKeyStr(self_id, user_id)
    const rows = store.contextRows(sid)
    const summary = rows.find(row => row.role === "summary")?.content || ""
    if (rows.some(row => row.role !== "summary") && !fallbackContexts.has(key)) {
      return { messages: rows.filter(row => row.role !== "summary").map(rowToMessage), summary }
    }
    const total = store.countAllTurns(sid)
    if (!total) return { messages: [], summary }
    const messages = store.recentMessages(sid, Math.min(total, CONTEXT_KEEP_TURNS)).map(rowToMessage)
    // 冷启动或上下文追加失败时，用最近 10 轮重建上下文并保留已有摘要
    await this.saveContextHistory(self_id, user_id, messages, summary)
    return { messages, summary }
  },

  /** 压缩后整体替换实际上下文，历史表不受影响
   *  @returns 是否写入成功 */
  async saveContextHistory(self_id, user_id, messages, summary = "") {
    const sid = this.sessionKey(self_id, user_id)
    const key = sessionKeyStr(self_id, user_id)
    const records = []
    groupByTurn(messages).forEach((group, index) => {
      group.messages.forEach((m, seq) => records.push(packContextMessage(sid, m, index + 1, seq)))
    })
    try {
      store.replaceContext(sid, String(summary || ""), records)
      fallbackContexts.delete(key)
      return true
    } catch (err) {
      log.warn(`实际上下文写入失败: ${err.message}`)
      return false
    }
  },

  async clearSession(self_id, user_id) {
    await this.awaitCompaction(self_id, user_id)
    const sid = this.sessionKey(self_id, user_id)
    store.clearUser(sid)
    store.clearContext(sid)
    fallbackContexts.delete(sessionKeyStr(self_id, user_id))
    sessionTokens.delete(sessionKeyStr(self_id, user_id))
    await clearUserSummaries(sid).catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  async clearAll() {
    await Promise.allSettled([...pendingCompactions.values()])
    store.clearAll()
    store.clearAllContext()
    sessionTokens.clear()
    fallbackContexts.clear()
    pendingCompactions.clear()
    await clearAllSummaries().catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  /** 清理超过保留期的轮次，并删除实际上下文中已过期的轮次 */
  async pruneOld(days) {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) return 0
    await Promise.allSettled([...pendingCompactions.values()])
    const cutoff = Date.now() - n * 86400000
    const deleted = store.deleteTurnsBefore(cutoff)
    store.clearOrphanContext()
    store.clearExpiredContext(cutoff)
    return deleted
  },
}
