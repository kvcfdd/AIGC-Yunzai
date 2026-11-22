import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_RETENTION_DAYS, pruneStats } from "../../lib/ai_core/memory/retention.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

function fakeRedis(initial) {
  const data = new Set(initial)
  return {
    data,
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, "")
      return [...data].filter(key => key.startsWith(prefix))
    },
    async del(...keys) {
      const list = keys.flat()
      for (const key of list) data.delete(key)
      return list.length
    },
  }
}

test("pruneStats: 默认保留 30 天", () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30)
})

test("pruneStats: 按日期删除消息统计与 token 统计键", async () => {
  const now = new Date(2026, 10, 10, 12).getTime()
  const redis = fakeRedis(["Yz:count:receive:msg:total:2026:10:10", "Yz:count:receive:msg:total:2026:10:20", "Yz:count:send:msg:bot:9:2026:09", "Yz:count:send:msg:bot:9:2026:10", "Yz:count:receive:msg:total:2025", "Yz:count:receive:msg:total:2026", "Yz:count:receive:msg:total:total", "Yz:count:send:msg:user:1234:total", "aigc:token:2026-10-10:9:main:1:-", "aigc:token:2026-10-20:9:main:1:-"])

  const removed = await pruneStats(redis, 30, now)
  assert.equal(removed, 4)
  assert.deepEqual([...redis.data].sort(), ["Yz:count:receive:msg:total:2026", "Yz:count:receive:msg:total:2026:10:20", "Yz:count:receive:msg:total:total", "Yz:count:send:msg:bot:9:2026:10", "Yz:count:send:msg:user:1234:total", "aigc:token:2026-10-20:9:main:1:-"])
})

test("pruneStats: 0 表示不限制；无效日期不删除", async () => {
  const redis = fakeRedis(["Yz:count:receive:msg:total:2020:01:01", "aigc:token:2020-01-01:9:main:1:-"])
  assert.equal(await pruneStats(redis, 0), 0)
  assert.equal(redis.data.size, 2)

  const invalid = fakeRedis(["Yz:count:receive:msg:total:2026:13:01", "Yz:count:receive:msg:total:2026:02:30"])
  assert.equal(await pruneStats(invalid, 30, new Date(2026, 11, 31).getTime()), 0)
  assert.equal(invalid.data.size, 2)
})
