import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { ConversationStore } from "../../lib/ai_core/memory/sqlite-store.js"
import { initSchema } from "../../lib/ai_core/memory/schema.js"

function makeStore() {
  const db = new Database(":memory:")
  initSchema(db)
  const store = new ConversationStore()
  store._db = db
  return { db, store }
}

test("sqlite context retention removes expired turns but keeps recent context", async () => {
  const { db, store } = makeStore()
  const sid = { self_id: "s", user_id: "u" }
  const insertMessage = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, 'user', ?, ?, '{}')")
  const insertContext = db.prepare("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, 0, ?, ?, '{}', ?)")
  const now = Date.now()
  insertMessage.run("s", "u", 1, "old", now - 40 * 86400000)
  insertMessage.run("s", "u", 2, "recent", now)
  insertContext.run("s", "u", 0, "summary", "archived", 0)
  insertContext.run("s", "u", 1, "user", "old context", now - 40 * 86400000)
  insertContext.run("s", "u", 2, "user", "recent context", now)

  await store.deleteTurnsBeforeChunked(now - 30 * 86400000)
  await store.clearOrphanContextChunked()
  await store.clearExpiredContextChunked(now - 30 * 86400000)

  const rows = store.contextRows(sid)
  assert.deepEqual(
    rows.map(row => row.content),
    ["recent context"],
  )
  assert.equal(rows[0].created_at, now)
  db.close()
})

test("sqlite context retention 分页清理超过一页的会话", async () => {
  const { db, store } = makeStore()
  const now = Date.now()
  const old = now - 40 * 86400000
  const cutoff = now - 30 * 86400000
  const insertMessage = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, 1, 'user', 'x', ?, '{}')")
  const insertContext = db.prepare("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, 0, ?, ?, '{}', ?)")

  db.transaction(() => {
    for (let i = 0; i < 260; i++) {
      const uid = `u${String(i).padStart(3, "0")}`
      insertMessage.run("s", uid, old)
      insertContext.run("s", uid, 0, "summary", "old summary", 0)
      insertContext.run("s", uid, 1, "user", "old context", old)
    }
    insertMessage.run("s", "recent", now)
    insertContext.run("s", "recent", 0, "summary", "keep summary", 0)
    insertContext.run("s", "recent", 1, "user", "keep context", now)
    // 无消息的孤儿会话：上下文应被整段清除
    insertContext.run("s", "orphan", 1, "user", "orphan", old)
  })()

  await store.clearOrphanContextChunked()
  assert.equal(store.contextRows({ self_id: "s", user_id: "orphan" }).length, 0)
  assert.equal(store.contextRows({ self_id: "s", user_id: "recent" }).length, 2)

  assert.equal(await store.clearExpiredContextChunked(cutoff), 260, "260 个过期会话的非摘要上下文都应删除")
  assert.equal(store.contextRows({ self_id: "s", user_id: "recent" }).length, 2, "近期上下文与摘要保留")
  assert.equal(store.contextRows({ self_id: "s", user_id: "u000" }).length, 0, "过期摘要也一并删除")
  db.close()
})
