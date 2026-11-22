import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { recordTokenUsage, runWithUsageContext, currentUsageEvent, tokenUsageKey, formatUsageDate } from "../../lib/ai_core/llm/token-usage.js"
import { createClient } from "../../lib/redis/index.js"

globalThis.Bot = { gml: new Map(), pickMember: () => null }
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const date = new Date(2026, 10, 2, 12, 0, 0)

class FakeRedis {
  constructor() {
    this.fields = new Map()
  }
  hIncrBy(key, field, increment) {
    const k = `${key}\0${field}`
    const next = (this.fields.get(k) || 0) + increment
    this.fields.set(k, next)
    return next
  }
  get(key, field) {
    return this.fields.get(`${key}\0${field}`) ?? null
  }
}

test("token usage: 日期与键结构", () => {
  assert.equal(formatUsageDate(date), "2026-11-02")
  assert.equal(tokenUsageKey({ date, self_id: "100", channel: "main", user_id: "200", group_id: "300" }), "aigc:token:2026-11-02:100:main:200:300")
  assert.equal(tokenUsageKey({ date, self_id: "100", channel: "memory", user_id: "200" }), "aigc:token:2026-11-02:100:memory:200:-")
})

test("token usage: 同键多次调用合并累加", () => {
  const client = new FakeRedis()
  const event = { self_id: "100", user_id: "200", group_id: "300" }
  recordTokenUsage({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 }, "main", { event, client, date })
  recordTokenUsage({ prompt_tokens: 20, completion_tokens: 7, cached_tokens: 4 }, "main", { event, client, date })

  const key = "aigc:token:2026-11-02:100:main:200:300"
  assert.equal(client.get(key, "input"), 30)
  assert.equal(client.get(key, "output"), 12)
  assert.equal(client.get(key, "cache_hit"), 7)
})

test("token usage: 不同调用类型/用户/群互不合并", () => {
  const client = new FakeRedis()
  recordTokenUsage({ prompt_tokens: 1 }, "main", { event: { self_id: "1", user_id: "2", group_id: "3" }, client, date })
  recordTokenUsage({ prompt_tokens: 2 }, "ambient", { event: { self_id: "1", user_id: "2", group_id: "3" }, client, date })
  recordTokenUsage({ prompt_tokens: 4 }, "main", { event: { self_id: "1", user_id: "9", group_id: "3" }, client, date })

  assert.equal(client.get("aigc:token:2026-11-02:1:main:2:3", "input"), 1)
  assert.equal(client.get("aigc:token:2026-11-02:1:ambient:2:3", "input"), 2)
  assert.equal(client.get("aigc:token:2026-11-02:1:main:9:3", "input"), 4)
})

test("token usage: 通过 AsyncLocalStorage 归属事件", async () => {
  const client = new FakeRedis()
  const event = { self_id: "100", user_id: "200", group_id: "300" }
  assert.equal(currentUsageEvent(), null)

  await runWithUsageContext(event, async () => {
    assert.equal(currentUsageEvent(), event)
    await Promise.resolve()
    recordTokenUsage({ prompt_tokens: 2, completion_tokens: 3, cached_tokens: 1 }, "agent", { client, date })
  })

  const key = "aigc:token:2026-11-02:100:agent:200:300"
  assert.equal(client.get(key, "input"), 2)
  assert.equal(client.get(key, "output"), 3)
  assert.equal(client.get(key, "cache_hit"), 1)
})

test("token usage: 无事件/全零/无客户端时不报错", () => {
  const client = new FakeRedis()
  recordTokenUsage({ prompt_tokens: 1 }, "main", { event: null, client, date })
  assert.equal(client.get("aigc:token:2026-11-02:unknown:main:unknown:-", "input"), 1)

  recordTokenUsage({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }, "main", { event: null, client, date })
  recordTokenUsage({ prompt_tokens: 5 }, "main", { event: null, client: null, date })
  assert.equal(client.fields.size, 1)
})

test("redis: hIncrBy 原子累加", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-token-"))
  const client = createClient(path.join(dir, "data.db"))
  try {
    assert.equal(client.hIncrBy("k", "input", 5), 5)
    assert.equal(client.hIncrBy("k", "input", 3), 8)
    assert.equal(client.hGet("k", "input"), "8")
  } finally {
    client.close()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 共享 SQLite 连接可能仍持有临时文件 */
    }
  }
})
