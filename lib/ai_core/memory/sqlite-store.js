import cfg from "../../config/config.js"
import db, { DEFAULT_FILE } from "../../db.js"
import { initSchema, migrateContextCreatedAt, dropLegacyMessageFtsTriggers } from "./schema.js"

/** 查询列 —— 与 conversation-history.js 的行→消息还原一一对应 */
const COLS = "id, turn, role, content, created_at, payload"

/** 维护任务分页 —— 保证单条查询/删除有上界 */
const SESSION_PAGE = 200
const TURN_PAGE = 500

/** 对话上下文存取 —— 只负责 db 句柄、语句缓存与 SQL。
 *  消息语义(轮次分配、payload 打包)在 conversation-history.js。
 *  常规读写同步: better-sqlite3 是同步的, Node 单线程, 所以一批消息的
 *  「读上一轮 → 插入」不会交错。大表维护用 async *Chunked 分批让出事件循环 */
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
    dropLegacyMessageFtsTriggers(d)
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

  /** 有用户发言的用户分页 —— 每日总结按游标遍历，避免一次取出全部会话 */
  usersWithMessagesPage(after, limit = SESSION_PAGE) {
    const size = Math.max(1, Math.floor(Number(limit) || SESSION_PAGE))
    if (!after) return this._stmt("SELECT DISTINCT self_id, user_id FROM aigc_message WHERE role = 'user' ORDER BY self_id, user_id LIMIT ?").all(size)
    return this._stmt("SELECT DISTINCT self_id, user_id FROM aigc_message WHERE role = 'user' AND (self_id, user_id) > (?, ?) ORDER BY self_id, user_id LIMIT ?").all(after.self_id, after.user_id, size)
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

  /** 分批版 clearOrphanContext —— 按会话分页，逐会话整段删除，页间让出事件循环 */
  async clearOrphanContextChunked() {
    const db = this._getDb()
    const first = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_context ORDER BY self_id, user_id LIMIT ?")
    const next = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_context WHERE (self_id, user_id) > (?, ?) ORDER BY self_id, user_id LIMIT ?")
    const hasMessages = db.prepare("SELECT 1 FROM aigc_message WHERE self_id = ? AND user_id = ? LIMIT 1")
    const remove = db.prepare("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ?")
    let total = 0
    let cursor = null
    for (;;) {
      const sessions = cursor ? next.all(cursor.self_id, cursor.user_id, SESSION_PAGE) : first.all(SESSION_PAGE)
      if (!sessions.length) break
      for (const { self_id, user_id } of sessions) {
        if (hasMessages.get(self_id, user_id)) continue
        total += remove.run(self_id, user_id).changes
      }
      cursor = sessions[sessions.length - 1]
      await new Promise(resolve => setImmediate(resolve))
    }
    return total
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

  /** 分批版 clearExpiredContext —— 逐会话清理过期摘要与非摘要轮次，页间让出事件循环。
   *  删除轮次时再按 created_at 过滤：清理期间若压缩任务重排了轮次，
   *  编号相同但时间新的行不会被误删。返回删除的非摘要行数 */
  async clearExpiredContextChunked(cutoffMs) {
    const db = this._getDb()
    const first = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_context ORDER BY self_id, user_id LIMIT ?")
    const next = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_context WHERE (self_id, user_id) > (?, ?) ORDER BY self_id, user_id LIMIT ?")
    const hasExpired = db.prepare("SELECT 1 FROM aigc_context WHERE self_id = ? AND user_id = ? AND role != 'summary' AND created_at < ? LIMIT 1")
    const removeSummary = db.prepare("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ? AND role = 'summary'")
    const pick = db.prepare("SELECT turn FROM aigc_context WHERE self_id = ? AND user_id = ? AND role != 'summary' AND turn > ? GROUP BY turn HAVING MAX(created_at) < ? ORDER BY turn LIMIT ?")
    const removeTurn = db.prepare("DELETE FROM aigc_context WHERE self_id = ? AND user_id = ? AND turn = ? AND role != 'summary' AND created_at < ?")
    let total = 0
    let cursor = null
    for (;;) {
      const sessions = cursor ? next.all(cursor.self_id, cursor.user_id, SESSION_PAGE) : first.all(SESSION_PAGE)
      if (!sessions.length) break
      for (const { self_id, user_id } of sessions) {
        if (hasExpired.get(self_id, user_id, cutoffMs)) removeSummary.run(self_id, user_id)
        let lastTurn = -1
        for (;;) {
          const turns = pick.all(self_id, user_id, lastTurn, cutoffMs, TURN_PAGE)
          if (!turns.length) break
          for (const { turn } of turns) total += removeTurn.run(self_id, user_id, turn, cutoffMs).changes
          lastTurn = turns[turns.length - 1].turn
          await new Promise(resolve => setImmediate(resolve))
          if (turns.length < TURN_PAGE) break
        }
      }
      cursor = sessions[sessions.length - 1]
      await new Promise(resolve => setImmediate(resolve))
    }
    return total
  }

  clearUser(sid) {
    this._stmt("DELETE FROM aigc_message WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id)
  }

  clearAll() {
    this._stmt("DELETE FROM aigc_message").run()
  }

  /** 分批清空历史表 —— 每批之间让出事件循环，避免大表删除阻塞 WS 心跳 */
  async clearAllChunked(batch = 1000) {
    return this._deleteBatched("aigc_message", "id", batch)
  }

  /** 分批清空实际上下文表 */
  async clearAllContextChunked(batch = 1000) {
    return this._deleteBatched("aigc_context", "rowid", batch)
  }

  async _deleteBatched(table, key, batch) {
    const size = Math.max(1, Math.floor(Number(batch) || 1000))
    const st = this._stmt(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} LIMIT ?)`)
    let total = 0
    for (;;) {
      const n = st.run(size).changes
      total += n
      if (!n) break
      await new Promise(resolve => setImmediate(resolve))
    }
    return total
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

  /** 分批版 deleteTurnsBefore —— 先收集过期轮次，再按 rowid 水位分批删除并让出事件循环。
   *  水位上限取调用开始时的 MAX(rowid)：清理期间新写入的消息不在快照内，不会被误删；每批从上次结束的
   *  rowid 继续，避免重复全表扫描 */
  async deleteTurnsBeforeChunked(cutoffMs, batch = 1000) {
    const db = this._getDb()
    const size = Math.max(1, Math.floor(Number(batch) || 1000))
    const temp = "_yz_expired_turns"
    const maxRowid = db.prepare("SELECT MAX(rowid) AS rid FROM aigc_message").get()?.rid || 0
    db.exec(`DROP TABLE IF EXISTS ${temp}`)
    db.exec(`CREATE TEMP TABLE ${temp} (self_id TEXT NOT NULL, user_id TEXT NOT NULL, turn INTEGER NOT NULL, PRIMARY KEY (self_id, user_id, turn)) WITHOUT ROWID`)
    try {
      const first = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_message ORDER BY self_id, user_id LIMIT ?")
      const next = db.prepare("SELECT DISTINCT self_id, user_id FROM aigc_message WHERE (self_id, user_id) > (?, ?) ORDER BY self_id, user_id LIMIT ?")
      const pick = db.prepare("SELECT turn FROM aigc_message WHERE self_id = ? AND user_id = ? AND turn > ? GROUP BY turn HAVING MAX(created_at) < ? ORDER BY turn LIMIT ?")
      const insert = db.prepare(`INSERT OR IGNORE INTO ${temp} (self_id, user_id, turn) VALUES (?, ?, ?)`)
      const insertTurns = db.transaction(rows => {
        for (const [self_id, user_id, turn] of rows) insert.run(self_id, user_id, turn)
      })
      let pending = []
      const flush = () => {
        if (!pending.length) return
        insertTurns(pending)
        pending = []
      }
      let cursor = null
      for (;;) {
        const sessions = cursor ? next.all(cursor.self_id, cursor.user_id, SESSION_PAGE) : first.all(SESSION_PAGE)
        if (!sessions.length) break
        for (const { self_id, user_id } of sessions) {
          let lastTurn = -1
          for (;;) {
            const turns = pick.all(self_id, user_id, lastTurn, cutoffMs, TURN_PAGE)
            if (!turns.length) break
            for (const { turn } of turns) pending.push([self_id, user_id, turn])
            lastTurn = turns[turns.length - 1].turn
            if (pending.length >= 500) {
              flush()
              await new Promise(resolve => setImmediate(resolve))
            }
            if (turns.length < TURN_PAGE) break
          }
        }
        flush()
        cursor = sessions[sessions.length - 1]
        await new Promise(resolve => setImmediate(resolve))
      }
      flush()

      const select = db.prepare(`SELECT m.rowid AS rid FROM aigc_message m CROSS JOIN ${temp} t
         WHERE m.self_id = t.self_id AND m.user_id = t.user_id AND m.turn = t.turn
           AND m.rowid > ? AND m.rowid <= ?
         ORDER BY m.rowid LIMIT ?`)
      const remove = db.prepare("DELETE FROM aigc_message WHERE rowid IN (SELECT value FROM json_each(?))")
      let removed = 0
      let lastRowid = 0
      for (;;) {
        const rids = select.all(lastRowid, maxRowid, size).map(row => row.rid)
        if (!rids.length) break
        removed += remove.run(JSON.stringify(rids)).changes
        lastRowid = rids[rids.length - 1]
        await new Promise(resolve => setImmediate(resolve))
      }
      return removed
    } finally {
      try {
        db.exec(`DROP TABLE IF EXISTS ${temp}`)
      } catch {}
    }
  }
}

export default new ConversationStore()
