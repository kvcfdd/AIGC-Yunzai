import test from "node:test"
import assert from "node:assert/strict"
import { createClient } from "../lib/redis/index.js"
import { pruneStats } from "../lib/ai_core/memory/retention.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

test("sweep 分批清理过期键，且预算为 0 时不做任何工作", () => {
  const client = createClient(":memory:")
  for (let i = 0; i < 1200; i++) client.set(`sweep:k${i}`, "v", { EX: -1 })

  assert.equal(client.sweep(0), 0)
  assert.equal(client.sweep(1000), 1200)
  assert.deepEqual(client.keys("sweep:*"), [])
  client.close()
})

test("del 批量删除并只统计真实存在的键", () => {
  const client = createClient(":memory:")
  const keys = []
  for (let i = 0; i < 40; i++) {
    client.set(`bulk:${i}`, "v")
    keys.push(`bulk:${i}`)
  }
  client.set("bulk:expired", "v", { EX: -1 })
  keys.push("bulk:expired", "bulk:missing")

  assert.equal(client.del(keys), 40)
  assert.deepEqual(client.keys("bulk:*"), [])
  client.close()
})

test("pruneStats 游标扫描并分批删除过期统计键", async () => {
  const client = createClient(":memory:")
  const now = new Date(2026, 10, 26, 12).getTime()
  for (let i = 0; i < 40; i++) client.set(`Yz:count:user:${i}:2020:01`, "1")
  for (let i = 0; i < 20; i++) client.set(`Yz:count:group:${i}:2026:11`, "1")
  for (let i = 0; i < 20; i++) client.set(`aigc:token:2020-01-0${(i % 9) + 1}:k${i}`, "1")
  client.set("aigc:token:2026-11-20:k", "1")

  assert.equal(await pruneStats(client, 30, now), 60)
  assert.equal(client.get("Yz:count:user:0:2020:01"), null)
  assert.equal(client.get("aigc:token:2020-01-01:k0"), null)
  assert.equal(client.get("Yz:count:group:0:2026:11"), "1")
  assert.equal(client.get("aigc:token:2026-11-20:k"), "1")
  client.close()
})
