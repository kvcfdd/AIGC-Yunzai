import cfg from "../../config/config.js"
import log from "../helpers/log.js"
import store from "./store.js"
import { expireMediaMarkers } from "../helpers/marker.js"

/** 每次请求携带的历史轮数 —— 思维链重建的历史素材同源，避免两处默认值漂移
 *  与同族的两个 context_tool_* 一致地承认 0: 0 表示不携带历史 */
export const contextRounds = () => {
  const n = Number(cfg.aigc?.context_rounds)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20
}
/** 工具结果完整保留的最近轮数 */
const toolFullRounds = () => {
  const n = Number(cfg.aigc?.context_tool_full_rounds)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7
}
/** 更早轮次工具结果的截断长度 */
const toolMaxChars = () => {
  const n = Number(cfg.aigc?.context_tool_max_chars)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200
}

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
  sessionId(self_id, user_id) {
    return { self_id: String(self_id), user_id: String(user_id) }
  },

  /** 整轮原子落盘 —— 只追加，旧轮次永不删除。
   *  轮次在此分配，规则与已删除的 splitRounds 一致:
   *  新轮只在 user 消息且上一条(已落盘或本批内)非 user 时开启，
   *  打断合并产生的连续 user 消息并入同一轮 */
  async appendMessages(sid, msgs) {
    if (!msgs?.length) return
    store.transaction(() => {
      const last = store.lastMessage(sid)
      let turn = last?.turn ?? 0
      let prevRole = last?.role ?? null

      const records = []
      for (const m of msgs) {
        if (m.role === "user" && prevRole !== "user") turn++
        records.push(packMessage(sid, m, Math.max(turn, 1)))
        prevRole = m.role
      }
      store.insertMany(records)
    })
  },

  /** 最近 maxRounds 轮消息，缺省取配置。旧轮次只是不携带，并未删除 */
  async getMessages(self_id, user_id, maxRounds) {
    const sid = this.sessionId(self_id, user_id)
    const rows = store.recentMessages(sid, maxRounds ?? contextRounds())
    if (!rows.length) return []

    const msgs = rows.map(rowToMessage)

    // 已被清理任务删除的媒体缓存 → 标记为已过期。
    // 必须先于截断: 截断点可能落在标记中间，残缺的 [图片](路径 再无正则可修，
    // 而模型会照抄这个路径去调 send_media
    const cache = new Map()
    for (const m of msgs) m.content = expireMediaMarkers(m.content, cache)

    // 最新 toolFullRounds 轮的工具结果完整保留，更早轮次的截断。
    // 用显式下标而不是靠越界返回 undefined —— 后者以 `turn >= undefined` 恒假
    // 来表达「全部截断」，任何一次比较符改动都会把整个保护反过来
    const turns = [...new Set(rows.map(r => r.turn))]
    const fullFrom = turns[Math.max(0, turns.length - toolFullRounds())]
    const limit = toolMaxChars()
    if (limit > 0) {
      for (let i = 0; i < msgs.length; i++) {
        if (fullFrom != null && rows[i].turn >= fullFrom) continue
        const c = msgs[i].content
        if (msgs[i].role === "tool" && typeof c === "string" && c.length > limit) msgs[i].content = `${c.slice(0, limit)}...`
      }
    }

    return msgs
  },

  /** 是否存在对话记录 —— 比组装全部轮次再判空便宜 */
  async hasHistory(self_id, user_id) {
    return store.hasHistory(this.sessionId(self_id, user_id))
  },

  /** 按时间/关键词检索历史，返回命中的整轮消息 */
  async searchHistory(self_id, user_id, opts = {}) {
    const sid = this.sessionId(self_id, user_id)
    const rows = store.queryTurns(sid, { ...opts, limit: opts.limit ?? 20 })
    const cache = new Map()
    return rows.map(r => {
      const msg = rowToMessage(r)
      msg.content = expireMediaMarkers(msg.content, cache)
      return { turn: r.turn, created_at: r.created_at, msg }
    })
  },

  /** 命中条件的轮数 */
  async countHistory(self_id, user_id, opts = {}) {
    return store.countTurns(this.sessionId(self_id, user_id), opts)
  },

  /** 该用户记录的时间跨度与总轮数，无记录返回 null */
  async historySpan(self_id, user_id) {
    return store.span(this.sessionId(self_id, user_id))
  },

  async clearSession(self_id, user_id) {
    store.clearUser(this.sessionId(self_id, user_id))
  },

  async clearAll() {
    store.clearAll()
  },

  /** 清理超过保留期的轮次，返回删除行数 */
  async pruneOld(days) {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) return 0
    return store.deleteTurnsBefore(Date.now() - n * 86400000)
  },
}
