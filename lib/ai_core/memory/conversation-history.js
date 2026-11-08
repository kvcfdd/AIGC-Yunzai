import log from "../helpers/log.js"
import store from "./sqlite-store.js"
import { contextWindowSize } from "./context-window.js"
import { estimateContextTokens } from "../core/tool-compaction.js"
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

/** 历史统计缓存：aigc:history:<bot>:<user>
 *  { turns, tokens, last_turn } 总量 + { window_start } 当前累计窗口起点 + { pending, pending_budget } 待裁剪标记。
 *  缓存缺失/失效时从持久记录重建一次，状态字段（窗口/标记）保留。 */
const STAT_PREFIX = "aigc:history:"
const statKey = sid => `${STAT_PREFIX}${sid.self_id}:${sid.user_id}`
const statClient = () => (typeof globalThis.redis?.hGetAll === "function" ? globalThis.redis : null)

/** 读取历史统计与裁剪状态 */
async function loadStat(sid) {
  const redis = statClient()
  const key = statKey(sid)
  let cached = null
  if (redis) {
    try {
      cached = await redis.hGetAll(key)
    } catch (err) {
      log.warn(`历史统计缓存读取失败: ${err.message}`)
    }
  }

  const state = {
    windowStart: Number(cached?.window_start) || 0,
    pending: cached?.pending != null && Number(cached.pending) > 0,
    pendingBudget: Math.floor(Number(cached?.pending_budget) || 0),
  }

  if (cached?.turns != null) {
    const turns = Number(cached.turns)
    const tokens = Number(cached.tokens)
    const lastTurn = Number(cached.last_turn)
    const last = store.lastMessage(sid)
    if (turns > 0 && Number.isFinite(tokens) && lastTurn === (last?.turn ?? 0)) return { turns, tokens, lastTurn, ...state }
  }

  const rows = store.recentMessages(sid, store.countAllTurns(sid))
  let turns = 0
  let tokens = 0
  let lastTurn = 0
  let turn = null
  for (const row of rows) {
    if (row.turn !== turn) {
      turn = row.turn
      turns++
    }
    lastTurn = row.turn
    tokens += estimateContextTokens([rowToMessage(row)])
  }
  if (redis && turns) {
    try {
      await redis.hSet(key, { turns, tokens, last_turn: lastTurn })
    } catch (err) {
      log.warn(`历史统计缓存写入失败: ${err.message}`)
    }
  }
  return { turns, tokens, lastTurn, ...state }
}

/** 应用一次轮次裁剪：记录窗口起点并清除待裁剪标记 */
async function setWindowStart(sid, windowStart) {
  const redis = statClient()
  if (!redis) return
  const key = statKey(sid)
  try {
    await redis.hSet(key, { window_start: windowStart })
    await redis.hDel(key, "pending")
    await redis.hDel(key, "pending_budget")
  } catch (err) {
    log.warn(`历史裁剪状态写入失败: ${err.message}`)
  }
}

/** 落盘后增量更新统计；缓存不存在时留给下次读取重建 */
async function bumpStat(sid, msgs, turn) {
  const redis = statClient()
  if (!redis) return
  const key = statKey(sid)
  try {
    if ((await redis.hGet(key, "turns")) == null) return
    await redis.hIncrBy(key, "turns", 1)
    await redis.hIncrBy(key, "tokens", estimateContextTokens(msgs))
    await redis.hSet(key, { last_turn: turn })
  } catch (err) {
    log.warn(`历史统计缓存更新失败: ${err.message}`)
  }
}

/** 删除/清理会话时同步失效缓存 */
async function clearStat(sid) {
  const redis = statClient()
  if (!redis) return
  try {
    await redis.del(statKey(sid))
  } catch (err) {
    log.warn(`历史统计缓存清理失败: ${err.message}`)
  }
}

async function clearAllStats() {
  const redis = statClient()
  if (!redis) return
  try {
    const keys = await redis.keys(`${STAT_PREFIX}*`)
    if (keys?.length) await redis.del(...keys)
  } catch (err) {
    log.warn(`历史统计缓存清理失败: ${err.message}`)
  }
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
    await bumpStat(sid, msgs, turn)
    return { turn }
  },

  /** 一轮对话原子落盘。旁听等无需持久化的场景传 persist=false。
   *  落盘前把媒体编码转为文本标记，并删除媒体字段。 */
  async appendRound(sid, msgs, { persist = true } = {}) {
    if (!persist || !msgs?.length) return
    for (const m of msgs) prepareForPersist(m)
    return this.appendMessages(sid, msgs)
  },

  /** 轮末达到软阈值时标记下一次请求裁剪 */
  async markHistoryTrim(self_id, user_id, budget) {
    const redis = statClient()
    if (!redis) return
    try {
      await redis.hSet(statKey(this.sessionKey(self_id, user_id)), { pending: 1, pending_budget: Math.floor(Number(budget) || 0) })
    } catch (err) {
      log.warn(`历史裁剪标记失败: ${err.message}`)
    }
  },

  /** 默认携带全部历史。
   *  传数字：按锯齿窗口裁剪到最近 limit 轮。
   *  传 { maxTokens, keepTokens, minTurns }：有轮末标记时按标记预算裁剪到最近若干轮（至少 minTurns 轮），
   *  之后窗口从该起点继续累计；无状态但历史已超软阈值时先裁一次。只选窗口，不删除记录。 */
  async getMessages(self_id, user_id, limit) {
    const sid = this.sessionKey(self_id, user_id)

    if (limit && typeof limit === "object") {
      const maxTokens = Math.floor(Number(limit.maxTokens) || 0)
      if (maxTokens > 0) {
        const { turns, tokens, lastTurn, windowStart, pending, pendingBudget } = await loadStat(sid)
        if (!turns) return []
        const minTurns = Math.max(Math.floor(Number(limit.minTurns) || 0), 1)
        const avgTokens = tokens / turns
        let start = windowStart
        if (avgTokens > 0 && pending) {
          const keepRounds = Math.max(minTurns, Math.floor(pendingBudget / avgTokens))
          start = Math.max(1, lastTurn - keepRounds + 1)
          await setWindowStart(sid, start)
        } else if (!start && avgTokens > 0 && tokens > maxTokens) {
          const keepTokens = Math.floor(Number(limit.keepTokens) || 0)
          const keepRounds = Math.max(minTurns, Math.floor(keepTokens / avgTokens))
          start = Math.max(1, lastTurn - keepRounds + 1)
          await setWindowStart(sid, start)
        }
        return store.messagesFromTurn(sid, start).map(rowToMessage)
      }
    }

    const total = store.countAllTurns(sid)
    const n = Number(limit)
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
    await clearStat(sid)
    await clearUserSummaries(sid).catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  async clearAll() {
    store.clearAll()
    await clearAllStats()
    await clearAllSummaries().catch(err => log.warn(`清理每日记忆失败: ${err.message}`))
  },

  /** 清理超过保留期的轮次，返回删除行数 */
  async pruneOld(days) {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) return 0
    const deleted = store.deleteTurnsBefore(Date.now() - n * 86400000)
    if (deleted) await clearAllStats()
    return deleted
  },
}
