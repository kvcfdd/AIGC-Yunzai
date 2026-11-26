import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { initSchema, dropLegacyMessageFtsTriggers } from "../../lib/ai_core/memory/schema.js"
import { ConversationStore } from "../../lib/ai_core/memory/sqlite-store.js"
import * as summaryStore from "../../lib/ai_core/memory/summary-store.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const sid = { self_id: "9", user_id: "1" }
const noEmbed = { aigc: { embeddings: { enable: false } } }

function makeStore() {
  const db = new Database(":memory:")
  initSchema(db)
  const store = new ConversationStore()
  store._db = db
  return { db, store }
}

test("clearAllChunked / clearAllContextChunked 分批清空两张表", async () => {
  const { db, store } = makeStore()
  const insertMessage = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, 'user', 'x', ?, '{}')")
  const insertContext = db.prepare("INSERT INTO aigc_context (self_id, user_id, turn, seq, role, content, payload, created_at) VALUES (?, ?, ?, 0, 'user', 'x', '{}', ?)")
  const now = Date.now()

  db.transaction(() => {
    for (let i = 0; i < 4500; i++) insertMessage.run("s", String(i % 7), i, now)
    for (let i = 0; i < 250; i++) insertContext.run("s", "u", i, now)
  })()

  assert.equal(await store.clearAllChunked(500), 4500)
  assert.equal(db.prepare("SELECT count(*) AS n FROM aigc_message").get().n, 0)
  assert.equal(await store.clearAllContextChunked(100), 250)
  assert.equal(db.prepare("SELECT count(*) AS n FROM aigc_context").get().n, 0)
  db.close()
})

test("clearAllChunked 在批次之间让出事件循环", async () => {
  const { db, store } = makeStore()
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES ('s', 'u', ?, 'user', 'x', ?, '{}')")
  const now = Date.now()
  db.transaction(() => {
    for (let i = 0; i < 1500; i++) insert.run(i, now)
  })()

  let done = false
  const clearing = store.clearAllChunked(500).then(() => {
    done = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false, "清除不应在单个同步块内完成")
  await clearing
  assert.equal(done, true)
  db.close()
})

test("旧版消息 FTS 触发器只摘一次且之后不再维护索引", () => {
  const db = new Database(":memory:")
  initSchema(db)
  db.exec(`
    CREATE VIRTUAL TABLE aigc_message_fts USING fts5(content, content='aigc_message', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER aigc_message_fts_ai AFTER INSERT ON aigc_message BEGIN
      INSERT INTO aigc_message_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER aigc_message_fts_ad AFTER DELETE ON aigc_message BEGIN
      INSERT INTO aigc_message_fts(aigc_message_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER aigc_message_fts_au AFTER UPDATE ON aigc_message BEGIN
      INSERT INTO aigc_message_fts(aigc_message_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO aigc_message_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES ('s', 'u', ?, 'user', ?, ?, '{}')")
  const matches = term => db.prepare(`SELECT count(*) AS n FROM aigc_message_fts WHERE aigc_message_fts MATCH ?`).get(term).n
  insert.run(1, "hello world", Date.now())
  assert.equal(matches("hello"), 1)

  assert.equal(dropLegacyMessageFtsTriggers(db), true)
  assert.equal(dropLegacyMessageFtsTriggers(db), false)

  insert.run(2, "after drop", Date.now())
  assert.equal(matches("after"), 0, "触发器摘掉后不再写入旧索引")
  assert.equal(matches("hello"), 1)
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aigc_message_fts'").get(), "FTS 表本体保留")
  db.close()
})

test("deleteTurnsBeforeChunked 只删除整轮都过期的数据", async () => {
  const { db, store } = makeStore()
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, 'user', ?, ?, '{}')")
  const now = Date.now()
  const cutoff = now - 30 * 86400000
  const old = now - 40 * 86400000

  // 同一会话：turn1 全旧（删），turn2 全新（留），turn3 新旧混合（MAX 新，整轮保留）
  insert.run("s", "u", 1, "old-a", old)
  insert.run("s", "u", 1, "old-b", old)
  insert.run("s", "u", 2, "recent", now)
  insert.run("s", "u", 3, "old-half", old)
  insert.run("s", "u", 3, "recent-half", now)
  // 另一个会话整轮过期
  insert.run("s", "v", 1, "old-v", old)

  assert.equal(await store.deleteTurnsBeforeChunked(cutoff, 1), 3)
  const left = db.prepare("SELECT self_id, user_id, turn, content FROM aigc_message ORDER BY user_id, turn, content").all()
  assert.deepEqual(
    left.map(row => [row.user_id, row.turn, row.content]),
    [
      ["u", 2, "recent"],
      ["u", 3, "old-half"],
      ["u", 3, "recent-half"],
    ],
  )
  db.close()
})

test("deleteTurnsBeforeChunked 不删除清理期间新写入的消息", async () => {
  const { db, store } = makeStore()
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES ('s', 'u', ?, 'user', ?, ?, '{}')")
  const now = Date.now()
  const cutoff = now - 30 * 86400000
  insert.run(1, "old", now - 40 * 86400000)

  // 第一批删除后让出事件循环；会话历史已空，新消息会从 turn 1 重新编号
  const clearing = store.deleteTurnsBeforeChunked(cutoff, 1)
  insert.run(1, "fresh", now)
  assert.equal(await clearing, 1)

  const left = db
    .prepare("SELECT content FROM aigc_message ORDER BY rowid")
    .all()
    .map(row => row.content)
  assert.deepEqual(left, ["fresh"], "清理期间写入的新消息不应被当成过期轮次删除")
  db.close()
})

test("deleteTurnsBeforeChunked 分页覆盖超过一页的会话", async () => {
  const { db, store } = makeStore()
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES ('s', ?, 1, 'user', ?, ?, '{}')")
  const now = Date.now()
  const old = now - 40 * 86400000
  db.transaction(() => {
    for (let i = 0; i < 260; i++) insert.run(`u${String(i).padStart(3, "0")}`, "old", old)
    insert.run("recent", "recent", now)
  })()

  assert.equal(await store.deleteTurnsBeforeChunked(now - 30 * 86400000), 260)
  const left = db.prepare("SELECT user_id, content FROM aigc_message").all()
  assert.deepEqual(left, [{ user_id: "recent", content: "recent" }])
  db.close()
})

test("usersWithMessagesPage 按会话游标分页", () => {
  const { db, store } = makeStore()
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES ('s', ?, 1, 'user', 'x', ?, '{}')")
  const now = Date.now()
  for (let i = 0; i < 260; i++) insert.run(`u${String(i).padStart(3, "0")}`, now)

  const first = store.usersWithMessagesPage(null, 200)
  assert.equal(first.length, 200)
  const second = store.usersWithMessagesPage(first[first.length - 1], 200)
  assert.equal(second.length, 60)
  assert.equal(second[0].user_id, "u200")
  db.close()
})

test("clearAllSummaries 重建后 FTS 仍可用且自增 id 不复用", async () => {
  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const ftsMatches = term => db.prepare("SELECT count(*) AS n FROM aigc_memory_day_fts WHERE aigc_memory_day_fts MATCH ?").get(`"${term}"`).n
  const old = summaryStore.insertSummary(db, { sid, day: "2026-11-01", summary: "用户喜欢喝奶茶" })
  assert.equal(summaryStore.getSummary(db, sid, "2026-11-01")?.summary, "用户喜欢喝奶茶")
  // 3 字以上才会走 FTS 分支，2 字查询只覆盖 LIKE
  assert.equal((await summaryStore.searchSummaries(sid, "喝奶茶", { database: db, config: noEmbed })).length, 1)
  assert.equal(ftsMatches("喝奶茶"), 1, "写入后触发器维护了 FTS 索引")

  assert.equal(await summaryStore.clearAllSummaries({ database: db }), 1)
  assert.equal(summaryStore.getSummary(db, sid, "2026-11-01"), null)
  assert.equal((await summaryStore.searchSummaries(sid, "喝奶茶", { database: db, config: noEmbed })).length, 0)
  assert.equal(ftsMatches("喝奶茶"), 0, "清理后旧索引不再命中")

  // 重建后触发器与索引要能继续工作，且 id 保持单调
  const fresh = summaryStore.insertSummary(db, { sid, day: "2026-11-02", summary: "用户改喝咖啡" })
  assert.ok(Number(fresh.id) > Number(old.id), "重建后自增 id 不应从 1 重来")
  assert.equal((await summaryStore.searchSummaries(sid, "喝咖啡", { database: db, config: noEmbed })).length, 1)
  assert.equal(ftsMatches("喝咖啡"), 1, "重建后的触发器继续维护索引")
  db.close()
})
