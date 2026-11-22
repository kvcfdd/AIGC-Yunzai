import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import cfg from "../../lib/config/config.js"
import { initSchema } from "../../lib/ai_core/memory/schema.js"
import { ConversationStore } from "../../lib/ai_core/memory/sqlite-store.js"
import * as summaryStore from "../../lib/ai_core/memory/summary-store.js"
import { buildDailyTranscript, DAY_SHIFT_MS, dayRange, isSummaryEnabled, lastCompleteDay, resolveSummaryConfig, summarizeDaily } from "../../lib/ai_core/memory/daily-summary.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

test.after(() => {
  for (const watcher of Object.values(cfg.watcher || {})) watcher.close?.()
})

const sid = { self_id: "9", user_id: "1" }
const noEmbed = { aigc: { embeddings: { enable: false } } }

test("memory daily: 总结写入、关键词检索、时间检索与删除", async () => {
  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const row = summaryStore.insertSummary(db, {
    sid,
    day: "2026-11-07",
    summary: "用户喜欢喝奶茶，周末去上海。",
    chats: [{ type: "私聊", name: "" }],
  })
  assert.equal(row.day, "2026-11-07")
  assert.equal(row.is_empty, 0)

  const hits = await summaryStore.searchSummaries(sid, "奶茶", { database: db, config: noEmbed })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].day, "2026-11-07")

  const timeOnly = await summaryStore.searchSummaries(sid, "", {
    database: db,
    config: noEmbed,
    startMs: new Date(2026, 10, 1).getTime(),
    endMs: new Date(2026, 10, 8).getTime(),
  })
  assert.equal(timeOnly.length, 1)

  const span = summaryStore.span(sid, { database: db })
  assert.equal(span.first, "2026-11-07")
  assert.equal(span.days, 1)

  assert.equal(await summaryStore.clearUserSummaries(sid, { database: db }), 1)
  assert.equal(summaryStore.getSummary(db, sid, "2026-11-07"), null)
  assert.equal((await summaryStore.searchSummaries(sid, "奶茶", { database: db, config: noEmbed })).length, 0)
  db.close()
})

test("memory daily: 总结向量化与语义检索", async () => {
  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const config = {
    aigc: {
      embeddings: { enable: true, model_config: "emb", adapter: "gemini", retrieval: { min_similarity: 0.5 } },
      models: [{ name: "emb", model: "m", base_url: "https://example.com", api_keys: "k", dimensions: 3 }],
    },
  }
  const embed = texts => texts.map(text => (text.includes("奶茶") ? [1, 0, 0] : text.includes("旅行") ? [0, 1, 0] : [0, 0, 1]))
  const a = summaryStore.insertSummary(db, { sid, day: "2026-11-05", summary: "用户喜欢喝奶茶" })
  const b = summaryStore.insertSummary(db, { sid, day: "2026-11-06", summary: "用户计划去旅行" })
  assert.equal(await summaryStore.embedSummary(db, a, { config, embed }), true)
  assert.equal(await summaryStore.embedSummary(db, b, { config, embed }), true)

  const hits = await summaryStore.searchSummaries(sid, "奶茶", { database: db, config, embed })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].day, "2026-11-05")
  db.close()
})

test("memory daily: 用户消息日期按 10 分钟偏移归日", () => {
  const db = new Database(":memory:")
  initSchema(db)
  const insert = db.prepare("INSERT INTO aigc_message (self_id, user_id, turn, role, content, created_at, payload) VALUES (?, ?, ?, 'user', 'x', ?, '{}')")
  insert.run("9", "1", 1, new Date(2026, 10, 6, 23, 40).getTime())
  insert.run("9", "1", 2, new Date(2026, 10, 6, 23, 55).getTime())
  insert.run("9", "1", 3, new Date(2026, 10, 7, 0, 5).getTime())
  // 23:55 同时属于 11-06 与 11-07
  insert.run("9", "2", 1, new Date(2026, 10, 6, 23, 55).getTime())

  const store = new ConversationStore()
  store._db = db
  assert.deepEqual(
    store.userMessageDays({ self_id: "9", user_id: "1" }, 600).map(row => row.day),
    ["2026-11-06", "2026-11-07"],
  )
  assert.deepEqual(
    store.userMessageDays({ self_id: "9", user_id: "2" }, 600).map(row => row.day),
    ["2026-11-06", "2026-11-07"],
  )
  db.close()
})

test("memory daily: 转录保留群聊/私聊标识与工具调用轨迹", () => {
  const now = new Date(2026, 10, 7, 12, 30).getTime()
  const { transcript, chats } = buildDailyTranscript([
    { turn: 1, role: "user", content: "群里说的话", created_at: now, payload: JSON.stringify({ chat_type: "群聊", group_name: "测试群" }) },
    { turn: 1, role: "assistant", content: null, created_at: now, payload: "{}" },
    { turn: 1, role: "tool", content: "SECRET RESULT", created_at: now, payload: JSON.stringify({ name: "web_search", is_error: false }) },
    { turn: 1, role: "assistant", content: "群回复", created_at: now, payload: "{}" },
    { turn: 2, role: "user", content: "定时注入", created_at: now, payload: JSON.stringify({ chat_type: "私聊", inject_source: "schedule" }) },
    { turn: 2, role: "assistant", content: "注入回复", created_at: now, payload: "{}" },
    { turn: 3, role: "user", content: "私聊说的话 [图片](data/aigc/chat/x.png)", created_at: now, payload: JSON.stringify({ chat_type: "私聊" }) },
    { turn: 4, role: "user", content: "子代理结果", created_at: now, payload: JSON.stringify({ chat_type: "私聊", inject_source: "agent" }) },
  ])
  assert.match(transcript, /\[群聊: 测试群\] 用户: 群里说的话/)
  assert.match(transcript, /\[群聊: 测试群\] 工具: web_search/)
  assert.match(transcript, /\[群聊: 测试群\] 助手: 群回复/)
  assert.match(transcript, /\[私聊\] 自动唤醒\(定时任务\): 定时注入/)
  assert.match(transcript, /\[私聊\] 助手: 注入回复/)
  assert.match(transcript, /\[私聊\] 用户: 私聊说的话 \[图片\]/)
  assert.match(transcript, /\[私聊\] 自动唤醒\(子代理\): 子代理结果/)
  assert.doesNotMatch(transcript, /SECRET RESULT|data\/aigc/)
  assert.deepEqual(chats, [
    { type: "群聊", name: "测试群" },
    { type: "私聊", name: "" },
  ])
})

test("memory daily: 配置解析、10 分钟窗口与任务幂等", async () => {
  assert.equal(isSummaryEnabled({}), false)
  assert.equal(isSummaryEnabled({ aigc: { memory: { enable: true } } }), true)
  assert.deepEqual(resolveSummaryConfig({}), { modelConfig: "", adapter: "" })

  const now = new Date(2026, 10, 8, 0, 5).getTime()
  assert.equal(lastCompleteDay(now), "2026-11-07")
  assert.equal(lastCompleteDay(new Date(2026, 10, 7, 23, 55).getTime()), "2026-11-06")
  assert.deepEqual(dayRange("2026-11-07"), [new Date(2026, 10, 6, 23, 50).getTime(), new Date(2026, 10, 8, 0, 0).getTime()])

  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const config = {
    aigc: {
      model_config: "main",
      adapter: "gemini",
      models: [{ name: "main", model: "m", base_url: "https://x", api_keys: "k" }],
      embeddings: { enable: false },
      memory: { enable: true },
    },
  }
  const messageStore = {
    usersWithMessages: () => [{ self_id: "9", user_id: "1" }],
    userMessageDays: () => [{ day: "2026-11-07" }],
    messagesForDay: () => [
      { turn: 1, role: "user", content: "我喜欢喝奶茶，周末打算和朋友们一起去上海玩两天，顺便看看外滩的夜景和豫园的小吃。", created_at: now - 86400000, payload: JSON.stringify({ chat_type: "私聊" }) },
      { turn: 1, role: "assistant", content: "记住了，周末去上海，注意天气，可以提前订好酒店和外滩附近的餐厅。", created_at: now - 86400000, payload: "{}" },
    ],
  }
  let calls = 0
  const provider = { chat: async () => ({ content: ++calls ? "用户喜欢喝奶茶。[私聊]" : "" }) }
  const first = await summarizeDaily({ config, provider, now, database: db, messageStore })
  assert.equal(first.summaries, 1)
  const row = summaryStore.getSummary(db, sid, "2026-11-07")
  assert.match(row.summary, /奶茶/)
  const second = await summarizeDaily({ config, provider, now, database: db, messageStore })
  assert.equal(second.summaries, 0)
  assert.equal(calls, 1)
  db.close()
})

test("memory daily: [无重要记忆] 识别为空总结", async () => {
  const now = new Date(2026, 10, 8, 0, 5).getTime()
  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const config = {
    aigc: {
      model_config: "main",
      adapter: "gemini",
      models: [{ name: "main", model: "m", base_url: "https://x", api_keys: "k" }],
      embeddings: { enable: false },
      memory: { enable: true },
    },
  }
  const messageStore = {
    usersWithMessages: () => [{ self_id: "9", user_id: "1" }],
    userMessageDays: () => [{ day: "2026-11-07" }],
    messagesForDay: () => [{ turn: 1, role: "user", content: "这是一段足够长的用户发言，用来触发每日总结流程，内容需要明显超过五十个字符才能生成记忆，所以这里再多写一些具体细节和安排。", created_at: now - 86400000, payload: JSON.stringify({ chat_type: "私聊" }) }],
  }
  const res = await summarizeDaily({ config, provider: { chat: async () => ({ content: "[无重要记忆]" }) }, now, database: db, messageStore })
  assert.equal(res.summaries, 1)
  const row = summaryStore.getSummary(db, sid, "2026-11-07")
  assert.equal(row.is_empty, 1)
  assert.match(row.summary, /无重要记忆/)
  db.close()
})

test("memory daily: 从旧到新逐天总结，过短记录跳过", async () => {
  const now = new Date(2026, 10, 8, 0, 5).getTime()
  const db = new Database(":memory:")
  summaryStore.ensureSchema(db)
  const config = {
    aigc: {
      model_config: "main",
      adapter: "gemini",
      models: [{ name: "main", model: "m", base_url: "https://x", api_keys: "k" }],
      embeddings: { enable: false },
      memory: { enable: true },
    },
  }
  const longRows = [{ turn: 1, role: "user", content: "这是一段足够长的用户发言，用来触发每日总结流程，内容需要明显超过五十个字符才能生成记忆，所以这里再多写一些具体细节和安排。", created_at: now - 86400000, payload: JSON.stringify({ chat_type: "私聊" }) }]
  const days = ["2026-11-05", "2026-11-06", "2026-11-07"]
  const observedDays = []
  const messageStore = {
    usersWithMessages: () => [{ self_id: "9", user_id: "1" }],
    userMessageDays: () => days.map(day => ({ day })),
    messagesForDay: (sid, startMs) => {
      observedDays.push(summaryStore.dayKey(startMs + DAY_SHIFT_MS))
      return longRows
    },
  }
  const provider = { chat: async () => ({ content: "用户说明了当天的安排。" }) }
  const res = await summarizeDaily({ config, provider, now, database: db, messageStore })
  assert.equal(res.summaries, 3)
  assert.deepEqual(observedDays, days)

  const emptyDb = new Database(":memory:")
  summaryStore.ensureSchema(emptyDb)
  let shortCalls = 0
  const shortStore = {
    usersWithMessages: () => [{ self_id: "9", user_id: "1" }],
    userMessageDays: () => [{ day: "2026-11-07" }],
    messagesForDay: () => [{ turn: 1, role: "user", content: "嗯", created_at: now - 86400000, payload: JSON.stringify({ chat_type: "私聊" }) }],
  }
  const short = await summarizeDaily({ config, provider: { chat: async () => (shortCalls++, { content: "x" }) }, now, database: emptyDb, messageStore: shortStore })
  assert.equal(short.summaries, 0)
  assert.equal(shortCalls, 0)
  db.close()
  emptyDb.close()
})
