import log from "../helpers/log.js"
import store from "./sqlite-store.js"
import { contextWindowSize } from "./context-window.js"
import { estimateContextTokens, selectRecentTurnCount } from "../core/tool-compaction.js"
import { prepareForPersist } from "./persist.js"
import { clearAllSummaries, clearUserSummaries } from "./summary-store.js"

/** 落盘时无条件丢弃的媒体字段 —— _persistRound 已把它们转成文本标记 */
const MEDIA_KEYS = new Set(["images", "image_paths", "videos", "video_paths", "audios", "audio_paths", "files", "file_paths"])

/** 行 → 消息对象。payload 原样展开，任何字段都不做解释/改名/解析 ——
 *  tool_calls[].function.arguments 是 JSON 字符串，一旦被「规范化」成对象，
 *  回放时会带着空参数发出且不报错 */
function rowToMessage(row) {
  let payload = {}
  try {
    payload = JSON.parse(row.payload) || {}
  } catch {
    log.warn(`对话记录附加字段解析失败 (id=${row.id})，已忽略`)
  }
  return { role: row.role, content: row.content, ...payload }
}

/** 按轮次分组并估算每轮 token；rows 按 turn,id 升序 */
function turnsWithTokens(rows) {
  const turns = []
  for (const row of rows) {
    if (turns.at(-1)?.turn !== row.turn) turns.push({ turn: row.turn, tokens: 0, rows: [] })
    const turn = turns.at(-1)
    turn.rows.push(row)
    turn.tokens += estimateContextTokens([rowToMessage(row)])
  }
  return turns
}

/** 消息 → 行记录。role/content 升列，其余原样进 payload */
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
    created_at: Number(m.time) || Date.now(),
    payload: JSON.stringify(payload),
  }
}

/** 对话上下文管理，SQLite 持久化，按用户与时间组织，轮次写入时物化
 *  方法按职责拆分于子模块，经原型合并保持 this 互调 */
export default {
  /** 会话标识 —— 统一转字符串: 框架有时给 number 有时给 string */
  sessionKey(self_id, user_id) {
    return { self_id: String(self_id), user_id: String(user_id) }
  },

  /** 整轮原子落盘 —— 只追加，旧轮次永不删除。
   *  一批消息共用一个轮次：工具执行中的插话 user 出现在 tool 之后，也不会拆轮 */
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
   *  落盘前把媒体编码转为文本标记，并删除媒体字段。 */
  async appendRound(sid, msgs, { persist = true } = {}) {
    if (!persist || !msgs?.length) return
    for (const m of msgs) prepareForPersist(m)
    return this.appendMessages(sid, msgs)
  },

  /** 默认携带全部历史。
   *  传数字：按锯齿窗口裁剪到最近 maxRounds 轮。
   *  传 { tokenBudget, minTurns }：从最新轮次向前累计，保留估算 token 不超过预算的轮次，至少 minTurns 轮。 */
  async getMessages(self_id, user_id, maxRounds) {
    const sid = this.sessionKey(self_id, user_id)
    const total = store.countAllTurns(sid)
    if (!total) return []

    if (maxRounds && typeof maxRounds === "object") {
      const turns = turnsWithTokens(store.recentMessages(sid, total))
      const keep = selectRecentTurnCount(
        turns.map(t => t.tokens),
        maxRounds.tokenBudget,
        maxRounds.minTurns,
      )
      if (!keep) return []
      return turns
        .slice(turns.length - keep)
        .flatMap(t => t.rows)
        .map(rowToMessage)
    }

    const n = Number(maxRounds)
    const windowSize = Number.isFinite(n) && n > 0 ? contextWindowSize(total, Math.floor(n)) : total
    if (!windowSize) return []

    const rows = store.recentMessages(sid, windowSize)
    if (!rows.length) return []

    // 历史原文原样返回，不做任何媒体标记改写
    return rows.map(rowToMessage)
  },

  async clearSession(self_id, user_id) {
    const sid = this.sessionKey(self_id, user_id)
    store.clearUser(sid)
    await clearUserSummaries(sid).catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  async clearAll() {
    store.clearAll()
    await clearAllSummaries().catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  /** 清理超过保留期的轮次，返回删除行数 */
  async pruneOld(days) {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) return 0
    return store.deleteTurnsBefore(Date.now() - n * 86400000)
  },
}
