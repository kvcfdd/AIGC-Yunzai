import test from "node:test"
import assert from "node:assert/strict"
import { getDashboard, buildDateRange, formatDay, parseDay } from "../../lib/webui/dashboard.js"

class FakeRedis {
  constructor() {
    this.data = new Map()
  }
  set(key, value) {
    this.data.set(key, value)
  }
  get(key) {
    const value = this.data.get(key)
    return typeof value === "string" ? value : null
  }
  hGetAll(key) {
    const value = this.data.get(key)
    return value && typeof value === "object" ? value : {}
  }
  keys(pattern) {
    const prefix = String(pattern).replace(/\*$/, "")
    return [...this.data.keys()].filter(key => key.startsWith(prefix))
  }
}

function seed() {
  const redis = new FakeRedis()
  redis.set("Yz:count:receive:msg:bot:100:2026:11:01", "12")
  redis.set("Yz:count:send:msg:bot:100:2026:11:01", "7")
  redis.set("Yz:count:receive:msg:bot:100:2026:11:02", "8")
  redis.set("Yz:count:send:msg:bot:100:2026:11:02", "3")
  redis.set("Yz:count:receive:msg:total:2026:11:01", "30")
  redis.set("Yz:count:send:msg:total:2026:11:01", "20")
  redis.set("Yz:count:receive:msg:total:2026:11:02", "40")
  redis.set("Yz:count:send:msg:total:2026:11:02", "10")

  redis.set("aigc:token:2026-11-01:100:main:200:300", { input: "100", output: "20", cache_hit: "30" })
  redis.set("aigc:token:2026-11-01:100:memory:200:300", { input: "10", output: "5", cache_hit: "0" })
  redis.set("aigc:token:2026-11-02:100:main:200:300", { input: "50", output: "10", cache_hit: "20" })
  redis.set("aigc:token:2026-11-02:200:main:200:300", { input: "999", output: "999", cache_hit: "999" })
  return redis
}

test("dashboard: 日期工具", () => {
  assert.equal(formatDay(new Date(2026, 10, 2)), "2026-11-02")
  assert.equal(formatDay(parseDay("2026-11-02")), "2026-11-02")
  assert.equal(parseDay("2026-02-30"), null)
  assert.deepEqual(buildDateRange(parseDay("2026-11-03"), parseDay("2026-11-01")), ["2026-11-01", "2026-11-02", "2026-11-03"])
  assert.equal(buildDateRange(parseDay("2026-10-01"), parseDay("2026-11-02"), 7).length, 7)
  assert.equal(buildDateRange(parseDay("2026-01-01"), parseDay("2026-03-01")).length, 30)
})

test("dashboard: 按 bot 汇总消息与 Token", async () => {
  const redis = seed()
  const data = await getDashboard({ bots: {} }, { from: "2026-11-01", to: "2026-11-02", bot: "100" }, { redis, cpuUsage: 12.34 })

  assert.equal(data.range.days, 2)
  assert.equal(data.messages.totals.received, 20)
  assert.equal(data.messages.totals.sent, 10)
  assert.deepEqual(
    data.messages.series.map(item => [item.date, item.received, item.sent]),
    [
      ["2026-11-01", 12, 7],
      ["2026-11-02", 8, 3],
    ],
  )

  assert.equal(data.tokens.totals.input, 160)
  assert.equal(data.tokens.totals.output, 35)
  assert.equal(data.tokens.totals.cacheHit, 50)
  assert.equal(data.tokens.totals.total, 195)
  assert.deepEqual(
    data.tokens.channels.map(item => item.channel),
    ["main", "memory"],
  )
  assert.equal(data.tokens.channels[0].total, 180)
  assert.equal(data.tokens.channels[1].total, 15)
  assert.equal(data.system.cpu.usage, 12.3)
})

test("dashboard: 不选 bot 时使用 total 统计键", async () => {
  const redis = seed()
  const data = await getDashboard({ bots: {} }, { from: "2026-11-01", to: "2026-11-02" }, { redis, cpuUsage: 0 })
  assert.equal(data.messages.totals.received, 70)
  assert.equal(data.messages.totals.sent, 30)
  // 不选 bot 时包含全部 token 键
  assert.equal(data.tokens.totals.input, 1159)
})

test("dashboard: 机器人列表", async () => {
  const bot = {
    bots: {
      100: { adapter: { name: "OneBotv11" }, uin: 100, nickname: "小助手" },
      200: { adapter: { name: "GSUIDClient" }, info: { user_id: 200, nickname: "另一个" } },
      stdin: { adapter: { id: "stdin", name: "标准输入" }, uin: "stdin", nickname: "标准输入" },
    },
  }
  const data = await getDashboard(bot, { from: "2026-11-02", to: "2026-11-02" }, { redis: new FakeRedis(), cpuUsage: 0 })
  assert.deepEqual(
    data.system.bots.map(item => [item.self_id, item.nickname, item.adapter]),
    [
      ["100", "小助手", "OneBotv11"],
      ["200", "另一个", "GSUIDClient"],
    ],
  )
})
