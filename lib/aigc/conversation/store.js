import db from "../../db.js"
import { initSchema } from "./schema.js"

const FILE = "data/db/aigc.db"

/** 查询列 —— 与 session.js 的行→消息还原一一对应 */
const COLS = "id, turn, role, content, created_at, payload"

/** LIKE 转义: 把 % _ \ 变成字面量，配合 ESCAPE '\' 使用，
 *  否则用户搜 "100%" 会让关键词变成通配全匹配 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, c => "\\" + c)
}

/** 关键词分词上限 —— 模型给出长句时避免拼出过多 LIKE 子句 */
const MAX_KEYWORD_TERMS = 5

/** 关键词 → 词项: 按空白切分后过滤空串。
 *  空串必须滤掉 —— 连续或首尾空格会产生空词，其模式 "%" 会退化成通配全匹配。
 *  中文没有词边界，切出的每个词仍按子串匹配，不做整词匹配 */
function keywordTerms(keyword) {
  return String(keyword).split(/\s+/).filter(Boolean).slice(0, MAX_KEYWORD_TERMS)
}

/** 对话上下文存取 —— 只负责 db 句柄、语句缓存与 SQL。
 *  消息语义(轮次分配、payload 打包、截断、媒体标记过期)在 session.js。
 *  方法一律同步: better-sqlite3 是同步的, Node 单线程, 所以一批消息的
 *  「读上一轮 → 插入」不会交错 */
class ConversationStore {
  constructor() {
    this._db = null
    this._stmts = new Map()
    this._tx = null
  }

  _getDb() {
    if (this._db) return this._db
    const d = db.open(FILE)
    initSchema(d)
    this._db = d
    return d
  }

  /** 预处理语句缓存 */
  _stmt(sql) {
    this._getDb()
    let st = this._stmts.get(sql)
    if (!st) {
      st = this._db.prepare(sql)
      this._stmts.set(sql, st)
    }
    return st
  }

  /** 事务包装: 一批消息的「读上一轮 → 插入」必须在同一事务内 */
  transaction(fn) {
    this._getDb()
    this._tx ??= this._db.transaction(f => f())
    return this._tx(fn)
  }

  /** 该用户最后一条消息的轮次与角色 —— 写入时据此续接轮次 */
  lastMessage(sid) {
    return this._stmt("SELECT turn, role FROM message WHERE self_id = ? AND user_id = ? ORDER BY turn DESC, id DESC LIMIT 1").get(sid.self_id, sid.user_id) || null
  }

  insertMany(records) {
    const st = this._stmt("INSERT INTO message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
    for (const r of records) st.run(r.self_id, r.user_id, r.turn, r.role, r.content, r.created_at, r.payload)
  }

  hasHistory(sid) {
    return !!this._stmt("SELECT 1 FROM message WHERE self_id = ? AND user_id = ? LIMIT 1").get(sid.self_id, sid.user_id)
  }

  /** 最近 N 轮的完整消息，按 (轮次, id) 正序。
   *  索引 (self_id, user_id, turn) 隐含以 rowid 结尾，故此排序无需额外排序步骤。
   *  无记录时 MAX(turn) 为 NULL ⇒ 无行 ⇒ 空数组 */
  recentMessages(sid, rounds) {
    return this._stmt(`SELECT ${COLS} FROM message WHERE self_id = ? AND user_id = ? AND turn > (SELECT MAX(turn) FROM message WHERE self_id = ? AND user_id = ?) - ? ORDER BY turn, id`).all(sid.self_id, sid.user_id, sid.self_id, sid.user_id, rounds)
  }

  clearUser(sid) {
    this._stmt("DELETE FROM message WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id)
  }

  clearAll() {
    this._stmt("DELETE FROM message").run()
  }

  /** 删除已整体过期的轮次，返回删除行数 */
  deleteTurnsBefore(cutoffMs) {
    return this._stmt(
      `DELETE FROM message
        WHERE (self_id, user_id, turn) IN (
          SELECT self_id, user_id, turn FROM message
           GROUP BY self_id, user_id, turn
          HAVING MAX(created_at) < ?
        )`,
    ).run(cutoffMs).changes
  }

  /** 检索条件 —— 片段由固定字符串拼出，值一律绑定 */
  _filters({ startMs, endMs, keyword }) {
    const clauses = []
    const params = []
    if (startMs != null) {
      clauses.push("created_at >= ?")
      params.push(startMs)
    }
    if (endMs != null) {
      clauses.push("created_at <= ?")
      params.push(endMs)
    }
    if (keyword) {
      const terms = keywordTerms(keyword)
      // 纯空白关键词视为未给 —— 否则词项为空，会退化成不带关键词的全量范围检索
      if (terms.length) {
        // 只匹配用户发言与助手回复，工具结果不参与：
        // 1) 匹配是全文而渲染 tool 行只取前 200 字，命中点靠后时模型看不到自己命中的内容，属假命中
        // 2) 工具结果是库中最肥的文本，噪声命中会挤掉真正相关的轮次
        // 原先靠排除 chat_history 回显防自我命中，限定 user/assistant 后被蕴含（回显是 tool 行），
        // 连带 json_valid + COALESCE 那串陷阱一并消失
        clauses.push("role IN ('user','assistant')")
        // 词间 AND 且限定在同一行内: 原先要求各词连续出现，中文里几乎必然查空；
        // 拆成每词一个子串条件后只要求同时出现，召回严格更宽
        for (const term of terms) {
          clauses.push("content LIKE ? ESCAPE '\\'")
          params.push(`%${escapeLike(term)}%`)
        }
      }
    }
    return { where: clauses.length ? clauses.join(" AND ") : "1", params }
  }

  /** 检索命中的整轮消息。
   *  按轮过滤而非按行: 跨午夜的一轮(用户 23:59、助手 00:00)在任一天的范围内
   *  都整轮取回，按行过滤会把问题和答案拆开递出去 */
  queryTurns(sid, opts) {
    const { where, params } = this._filters(opts)
    return this._stmt(
      `SELECT ${COLS} FROM message
        WHERE self_id = ? AND user_id = ?
          AND turn IN (SELECT DISTINCT turn FROM message
                        WHERE self_id = ? AND user_id = ? AND ${where}
                        ORDER BY turn DESC LIMIT ?)
        ORDER BY turn, id`,
    ).all(sid.self_id, sid.user_id, sid.self_id, sid.user_id, ...params, opts.limit)
  }

  /** 命中的轮数 —— 用于「命中 N 轮，仅返回最新 M 轮」提示 */
  countTurns(sid, opts) {
    const { where, params } = this._filters(opts)
    return this._stmt(`SELECT COUNT(DISTINCT turn) AS n FROM message WHERE self_id = ? AND user_id = ? AND ${where}`).get(sid.self_id, sid.user_id, ...params).n
  }

  /** 该用户记录的时间跨度与总轮数 —— 未命中时告诉模型「实际存在什么」 */
  span(sid) {
    const row = this._stmt("SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(DISTINCT turn) AS turns FROM message WHERE self_id = ? AND user_id = ?").get(sid.self_id, sid.user_id)
    return row?.turns ? row : null
  }
}

export default new ConversationStore()
