import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import memory from "../../lib/ai_core/memory/conversation-history.js"
import store from "../../lib/ai_core/memory/sqlite-store.js"
import { HISTORY_TURN } from "../../lib/ai_core/memory/persist.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const originals = {
  countAllTurns: store.countAllTurns,
  recentMessages: store.recentMessages,
  lastMessage: store.lastMessage,
  transaction: store.transaction,
  insertMany: store.insertMany,
  contextRows: store.contextRows,
  hasContext: store.hasContext,
  replaceContext: store.replaceContext,
  appendContextMessages: store.appendContextMessages,
  clearUser: store.clearUser,
  clearContext: store.clearContext,
  clearContextMessages: store.clearContextMessages,
  clearAll: store.clearAll,
  clearAllChunked: store.clearAllChunked,
  clearAllContext: store.clearAllContext,
  clearAllContextChunked: store.clearAllContextChunked,
  clearOrphanContext: store.clearOrphanContext,
  clearOrphanContextChunked: store.clearOrphanContextChunked,
  clearExpiredContextChunked: store.clearExpiredContextChunked,
  deleteTurnsBefore: store.deleteTurnsBefore,
  deleteTurnsBeforeChunked: store.deleteTurnsBeforeChunked,
}
after(() => {
  Object.assign(store, originals)
})

let rows = []
let context = []
let inserted = []

function useRows(count) {
  rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    turn: i + 1,
    role: "user",
    content: `第${i + 1}轮`,
    created_at: Date.now(),
    payload: "{}",
  }))
}

function mockStore() {
  store.countAllTurns = () => new Set(rows.map(r => r.turn)).size
  store.recentMessages = (_sid, rounds) => rows.filter(row => row.turn > rows.length - rounds)
  store.lastMessage = () => (rows.length ? { turn: rows[rows.length - 1].turn, role: "user" } : null)
  store.transaction = fn => fn()
  store.insertMany = records => {
    inserted.push(...records)
    for (const r of records) rows.push({ ...r, id: rows.length + 1 })
  }
  store.contextRows = () => context
  store.hasContext = () => context.length > 0
  store.clearContextMessages = () => {
    context = context.filter(row => row.role === "summary")
  }
  store.clearExpiredContext = () => {
    const cutoff = Date.now() - 30 * 86400000
    const before = context.length
    const latest = Math.max(0, ...rows.filter(row => row.created_at >= cutoff).map(row => row.turn))
    context = context.filter(row => row.role === "summary" || row.turn >= latest)
    return before - context.length
  }
  store.replaceContext = (_sid, summary, records) => {
    context = []
    if (summary) context.push({ turn: 0, seq: 0, role: "summary", content: summary, payload: "{}" })
    context.push(...records)
  }
  store.appendContextMessages = (_sid, records) => {
    const next = Math.max(0, ...context.map(r => r.turn)) + 1
    context.push(...records.map((r, seq) => ({ ...r, turn: next, seq })))
  }
  store.clearUser = () => {
    rows = []
  }
  store.clearContext = () => {
    context = []
  }
  store.clearAll = () => {
    rows = []
  }
  store.clearAllChunked = async () => {
    rows = []
  }
  store.clearAllContext = () => {
    context = []
  }
  store.clearAllContextChunked = async () => {
    context = []
  }
  store.clearOrphanContext = () => {
    if (!rows.length) context = []
    return context.length
  }
  store.clearOrphanContextChunked = async () => {
    if (!rows.length) context = []
    return context.length
  }
  store.clearExpiredContextChunked = async () => {
    const cutoff = Date.now() - 30 * 86400000
    const before = context.length
    const latest = Math.max(0, ...rows.filter(row => row.created_at >= cutoff).map(row => row.turn))
    context = context.filter(row => row.role === "summary" || row.turn >= latest)
    return before - context.length
  }
  store.deleteTurnsBefore = () => 0
  store.deleteTurnsBeforeChunked = async () => 0
}

beforeEach(() => {
  rows = []
  context = []
  inserted = []
  mockStore()
})

test("冷启动时带原表最近 10 轮，不足 10 轮则全部，并播种上下文表", async () => {
  useRows(3)
  const { messages, summary } = await memory.getMessages("s", "u")
  assert.equal(messages.length, 3)
  assert.equal(summary, "")
  assert.deepEqual(
    messages.map(m => m[HISTORY_TURN]),
    [1, 2, 3],
  )
  assert.equal(context.length, 3, "冷启动后播种实际上下文表")
  const again = await memory.getMessages("s", "u")
  assert.equal(again.messages.length, 3)
  assert.equal(again.messages[0].content, "第1轮")
})

test("冷启动时原表超过 10 轮只带最近 10 轮并播种", async () => {
  useRows(12)
  const { messages, summary } = await memory.getMessages("s", "u")
  assert.equal(summary, "")
  assert.equal(messages.length, 10)
  assert.equal(messages[0].content, "第3轮")
  assert.deepEqual(
    messages.map(m => m[HISTORY_TURN]),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  )
  assert.equal(context.length, 10, "冷启动后播种实际上下文表")
  const again = await memory.getMessages("s", "u")
  assert.equal(again.messages.length, 10)
  assert.equal(again.messages[0].content, "第3轮")
})

test("保存上下文后按摘要 + 最近轮次读取", async () => {
  useRows(12)
  const messages = rows.slice(2).map((row, i) => ({
    role: "user",
    content: row.content,
    [HISTORY_TURN]: i + 3,
  }))
  await memory.saveContextHistory("s", "u", messages, "旧摘要")
  const loaded = await memory.getMessages("s", "u")
  assert.equal(loaded.summary, "旧摘要")
  assert.equal(loaded.messages.length, 10)
  assert.deepEqual(
    loaded.messages.map(m => m[HISTORY_TURN]),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  )
  assert.equal(loaded.messages[0].content, "第3轮")
})

test("落盘：完整版本写历史表，压缩版本写上下文表", async () => {
  context = [{ turn: 0, seq: 0, role: "summary", content: "摘要", payload: "{}" }]
  const full = [
    { role: "user", content: "问题" },
    { role: "tool", content: "x".repeat(9000) },
    { role: "assistant", content: "回答" },
  ]
  const compacted = [
    { role: "user", content: "问题" },
    { role: "tool", content: "x".repeat(1000) },
    { role: "assistant", content: "回答" },
  ]
  await memory.appendRound({ self_id: "s", user_id: "u" }, full, { contextMsgs: compacted })

  assert.equal(inserted.length, 3, "历史表写入完整一轮")
  const omitted = 9000 - 4089 - 1024
  assert.equal(inserted[1].content.length, 4089 + `...(已省略${omitted}字符)...`.length + 1024, "历史表工具结果按落盘上限裁剪")
  const contextMessages = context.filter(r => r.role !== "summary")
  assert.equal(contextMessages.length, 3)
  assert.equal(contextMessages[1].content.length, 1000, "上下文表保留实际发送的压缩版本")
  assert.equal(contextMessages[0].turn, 1)
})

test("上下文未激活时只写历史表", async () => {
  await memory.appendRound({ self_id: "s", user_id: "u" }, [{ role: "user", content: "hi" }])
  assert.equal(inserted.length, 1)
  assert.equal(context.length, 0)
})

test("session tokens 写入、读取与清除", () => {
  assert.equal(memory.getSessionTokens("s", "u"), 0)
  memory.setSessionTokens("s", "u", 12345)
  assert.equal(memory.getSessionTokens("s", "u"), 12345)
  memory.setSessionTokens("s", "u", 0)
  assert.equal(memory.getSessionTokens("s", "u"), 0)
})

test("同一会话的下一轮会等待轮末压缩完成", async () => {
  let resolve
  const pending = new Promise(r => {
    resolve = r
  })
  const tracked = memory.beginCompaction("s", "u", pending)
  let done = false
  const wait = memory.awaitCompaction("s", "u").then(() => (done = true))
  assert.equal(done, false)
  resolve()
  await Promise.all([tracked, wait])
  assert.equal(done, true)
})

test("清理会话时同时清理历史表、上下文表与 token 计数", async () => {
  useRows(2)
  context = [{ turn: 0, seq: 0, role: "summary", content: "摘要", payload: "{}" }]
  memory.setSessionTokens("s", "u", 100)
  await memory.clearSession("s", "u")
  assert.equal(rows.length, 0)
  assert.equal(context.length, 0)
  assert.equal(memory.getSessionTokens("s", "u"), 0)
})

test("30 天清理后历史已空的会话同时清除实际上下文", async () => {
  rows = []
  context = [{ turn: 0, seq: 0, role: "summary", content: "摘要", payload: "{}" }]
  store.deleteTurnsBeforeChunked = async () => 1
  assert.equal(await memory.pruneOld(30), 1)
  assert.equal(context.length, 0)
})

test("30 天清理时仍有近期消息的会话清除已过期的实际上下文", async () => {
  rows = [
    { id: 1, turn: 1, role: "user", content: "旧", created_at: Date.now() - 40 * 86400000, payload: "{}" },
    { id: 2, turn: 2, role: "user", content: "近期", created_at: Date.now(), payload: "{}" },
  ]
  context = [
    { turn: 0, seq: 0, role: "summary", content: "旧摘要", payload: "{}" },
    { turn: 1, seq: 0, role: "user", content: "旧上下文", payload: "{}" },
    { turn: 2, seq: 0, role: "user", content: "近期上下文", payload: "{}" },
  ]
  store.deleteTurnsBeforeChunked = async () => 1
  assert.equal(await memory.pruneOld(30), 1)
  const loaded = await memory.getMessages("s", "u")
  assert.equal(loaded.summary, "旧摘要")
  assert.deepEqual(
    loaded.messages.map(m => m.content),
    ["近期上下文"],
  )
})

test("saveContextHistory 返回写入结果", async () => {
  assert.equal(await memory.saveContextHistory("s", "u", [{ role: "user", content: "x" }], "摘要"), true)
  store.replaceContext = () => {
    throw new Error("db down")
  }
  assert.equal(await memory.saveContextHistory("s", "u", [{ role: "user", content: "x" }], "摘要"), false)
})

test("实际上下文追加失败不影响历史表落盘，并保留摘要回退到完整历史", async () => {
  context = [
    { turn: 0, seq: 0, role: "summary", content: "摘要", payload: "{}" },
    { turn: 1, seq: 0, role: "user", content: "旧上下文", payload: "{}" },
  ]
  store.appendContextMessages = () => {
    throw new Error("busy")
  }
  const result = await memory.appendRound({ self_id: "s", user_id: "u" }, [{ role: "user", content: "hi" }])
  assert.equal(inserted.length, 1)
  assert.equal(result.contextAppendFailed, true)
  assert.equal(context.length, 1, "失败时只清理不一致消息，保留压缩摘要")
  assert.equal(context[0].role, "summary")
  store.appendContextMessages = originals.appendContextMessages
  const loaded = await memory.getMessages("s", "u")
  assert.equal(loaded.summary, "摘要")
  assert.deepEqual(
    loaded.messages.map(m => m.content),
    ["hi"],
  )
  assert.deepEqual(
    context.filter(row => row.role !== "summary").map(row => row.content),
    ["hi"],
  )
})

test("saveContextHistory 为无轮次标记的本轮消息创建独立轮次", async () => {
  const messages = [
    { role: "user", content: "旧一", [HISTORY_TURN]: 1 },
    { role: "assistant", content: "答一", [HISTORY_TURN]: 1 },
    { role: "user", content: "旧二", [HISTORY_TURN]: 2 },
    { role: "user", content: "本轮" },
    { role: "assistant", content: "本轮回复" },
  ]
  await memory.saveContextHistory("s", "u", messages, "摘要")
  assert.deepEqual(
    context.filter(row => row.role !== "summary").map(row => [row.turn, row.content]),
    [
      [1, "旧一"],
      [1, "答一"],
      [2, "旧二"],
      [3, "本轮"],
      [3, "本轮回复"],
    ],
  )
})
