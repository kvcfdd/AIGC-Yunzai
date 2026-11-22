import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { ConversationStore } from "../../lib/ai_core/memory/sqlite-store.js"
import { initSchema } from "../../lib/ai_core/memory/schema.js"

test("sqlite context retention removes expired turns but keeps recent context", () => {
  const db = new Database(":memory:")
  initSchema(db)
  const store = new ConversationStore()
  store._db = db
  const sid = { self_id: "s", user_id: "u" }
  const insertMessage = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, 'user', ?, ?, '{}')")
  const insertContext = db.prepare("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, 0, ?, ?, '{}', ?)")
  const now = Date.now()
  insertMessage.run("s", "u", 1, "old", now - 40 * 86400000)
  insertMessage.run("s", "u", 2, "recent", now)
  insertContext.run("s", "u", 0, "summary", "archived", 0)
  insertContext.run("s", "u", 1, "user", "old context", now - 40 * 86400000)
  insertContext.run("s", "u", 2, "user", "recent context", now)

  store.deleteTurnsBefore(now - 30 * 86400000)
  store.clearOrphanContext()
  store.clearExpiredContext(now - 30 * 86400000)

  const rows = store.contextRows(sid)
  assert.deepEqual(
    rows.map(row => row.content),
    ["recent context"],
  )
  assert.equal(rows[0].created_at, now)
  db.close()
})
