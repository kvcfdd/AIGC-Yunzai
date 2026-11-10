import cfg from "../../config/config.js"
import db, { DEFAULT_FILE } from "../../db.js"
import { initSchema, migrateContextCreatedAt } from "./schema.js"

/** 查询列 —— 与 conversation-history.js 的行→消息还原一一对应 */
const COLS = "id, turn, role, content, created_at, payload"

/** 对话上下文存取 —— 只负责 db 句柄、语句缓存与 SQL。
 *  消息语义(轮次分配、payload 打包)在 conversation-history.js。
 *  方法一律同步: better-sqlite3 是同步的, Node 单线程, 所以一批消息的
 *  「读上一轮 → 插入」不会交错 */
export class ConversationStore {
  constructor() {
    this._db = null
    this._stmts = new Map()
    this._tx = null
  }

  _getDb() {
    if (this._db?.open) return this._db
    this._stmts.clear()
    this._tx = null
    const d = db.open(cfg.db?.storage || DEFAULT_FILE)
    initSchema(d)
    migrateContextCreatedAt(d)
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
    return this._stmt("SELECT turn, role FROM aigc_message WHERE self_id = ? AND user_id = ? ORDER BY turn DESC, id DESC LIMIT 1").get(sid.self_id, sid.user_id) || null
  }

  /** 已落盘的不同轮次总数 —— 上下文锯齿窗口计算 */
  countAllTurns(sid) {
    return this._stmt("SELECT COUNT(DISTINCT turn) AS n FROM aigc_message WHERE self_id = ? AND user_id = ?").get(sid.self_id, sid.user_id)?.n || 0
  }

  insertMany(records) {
    const st = this._stmt("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
    for (const r of records) st.run(r.self_id, r.user_id, r.turn, r.role, r.content, r.created_at, r.payload)
  }

  /** 有用户发言的用户 —— 每日总结的任务来源 */
  usersWithMessages() {
    return this._stmt("SELECT DISTINCT self_id, user_id FROM aigc_message WHERE role = 'user'").all()
  }

  /** 某用户需要总结的日期 */
  userMessageDays(sid, shiftSeconds = 0) {
    return this._stmt(
      `SELECT DISTINCT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day
         FROM aigc_message WHERE self_id = ? AND user_id = ? AND role = 'user'
        UNION
       SELECT DISTINCT strftime('%Y-%m-%d', (created_at / 1000) + ?, 'unixepoch', 'localtime') AS day
         FROM aigc_message WHERE self_id = ? AND user_id = ? AND role = 'user'
        ORDER BY day`,
    ).all(sid.self_id, sid.user_id, shiftSeconds, sid.self_id, sid.user_id)
  }

  /** 某天开始的整轮 user/assistant/tool 消息；跨午夜的轮次归入开始日并整轮取回
   *  工具结果只保留调用轨迹由上层组装，这里仍整行取出 */
  messagesForDay(sid, startMs, endMs) {
    return this._stmt(
      `SELECT ${COLS} FROM aigc_message
        WHERE self_id = ? AND user_id = ?
          AND turn IN (
            SELECT turn FROM aigc_message
             WHERE self_id = ? AND user_id = ?
             GROUP BY turn
            HAVING MIN(created_at) >= ? AND MIN(created_at) < ?
          )
          AND role IN ('user','assistant','tool')
        ORDER BY turn, id`,
    ).all(sid.self_id, sid.user_id, sid.self_id, sid.user_id, startMs, endMs)
  }

  /** 最近 N 轮的完整消息，按 (轮次, id) 正序。
   *  索引 (self_id, user_id, turn) 隐含以 rowid 结尾，而 id 即 rowid，故此处无需额外排序步骤。
   *  无记录时 MAX(turn) 为 NULL ⇒ 无行 ⇒ 空数组 */
  recentMessages(sid, rounds) {
    return this._stmt(`SELECT ${COLS} FROM aigc_message WHERE self_id = ? AND user_id = ? AND turn > (SELECT MAX(turn) FROM aigc_message WHERE self_id = ? AND user_id = ?) - ? ORDER BY turn, id`).all(sid.self_id, sid.user_id, sid.self_id, sid.user_id, rounds)
  }

  /** 实际上下文：摘要行(turn=0) + 最近若干轮，按 (轮次, 序号) 正序 */
  contextRows(sid) {
    return this._stmt("SELECT turn, seq, role, content, payload, created_at FROM aigc_context WHERE self_id = ? AND user_id = ? ORDER BY turn, seq").all(sid.self_id, sid.user_id)
  }

  hasContext(sid) {
    return !!this._stmt("SELECT 1 FROM aigc_context WHERE self_id = ? AND user_id = ? LIMIT 1").get(sid.self_id, sid.user_id)
  }

  /** 整体替换实际上下文 —— 摘要 + 若干轮消息，一次事务写入 */
  replaceContext(sid, summary, records) {
    this._getDb()
    this._db.transaction(() => {
      this._stmt("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id)
      if (summary) this._stmt("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, 0, 0, 'summary', ?, '{}', 0)").run(sid.self_id, sid.user_id, summary)
      const st = this._stmt("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      for (const r of records || []) st.run(r.self_id, r.user_id, r.turn, r.seq, r.role, r.content, r.payload, r.created_at)
    })()
  }

  /** 追加一轮实际上下文 —— 轮次在上下文表内自增，与 aigc_message 的轮次解耦 */
  appendContextMessages(sid, records) {
    if (!records?.length) return
    this._getDb()
    this._db.transaction(() => {
      const next = (this._stmt("SELECT MAX(turn) AS turn FROM aigc_context WHERE self_id = ? AND user_id = ?").get(sid.self_id, sid.user_id)?.turn || 0) + 1
      const st = this._stmt("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      records.forEach((r, seq) => st.run(sid.self_id, sid.user_id, next, seq, r.role, r.content, r.payload, r.created_at))
    })()
  }

  clearContext(sid) {
    this._stmt("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id)
  }

  clearContextMessages(sid) {
    this._stmt("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ? AND role != 'summary'").run(sid.self_id, sid.user_id)
  }

  clearAllContext() {
    this._stmt("DELETE FROM aigc_context").run()
  }

  /** 清除历史表中已无任何消息的会话的实际上下文 */
  clearOrphanContext() {
    return this._stmt("DELETE FROM aigc_context WHERE NOT EXISTS (SELECT 1 FROM aigc_message m WHERE m.self_id = aigc_context.self_id AND m.user_id = aigc_context.user_id)").run().changes
  }

  clearExpiredContext(cutoffMs) {
    this._getDb()
    return this._db.transaction(() => {
      this._stmt(
        `DELETE FROM aigc_context
          WHERE role = 'summary'
            AND EXISTS (
              SELECT 1 FROM aigc_context expired
               WHERE expired.self_id = aigc_context.self_id AND expired.user_id = aigc_context.user_id
                 AND expired.role != 'summary' AND expired.created_at < ?
            )`,
      ).run(cutoffMs)
      return this._stmt(
        `DELETE FROM aigc_context
          WHERE role != 'summary'
            AND (self_id, user_id, turn) IN (
              SELECT self_id, user_id, turn FROM aigc_context
               WHERE role != 'summary'
               GROUP BY self_id, user_id, turn
              HAVING MAX(created_at) < ?
            )`,
      ).run(cutoffMs).changes
    })()
  }

  clearUser(sid) {
    this._stmt("DELETE FROM aigc_message WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id)
  }

  clearAll() {
    this._stmt("DELETE FROM aigc_message").run()
  }

  /** 删除已整体过期的轮次，返回删除行数 */
  deleteTurnsBefore(cutoffMs) {
    return this._stmt(
      `DELETE FROM aigc_message
        WHERE (self_id, user_id, turn) IN (
          SELECT self_id, user_id, turn FROM aigc_message
           GROUP BY self_id, user_id, turn
          HAVING MAX(created_at) < ?
        )`,
    ).run(cutoffMs).changes
  }
}

export default new ConversationStore()
