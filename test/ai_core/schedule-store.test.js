import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { ScheduleStore, parseAt, validateCron } from "../../lib/ai_core/schedule/index.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

test("schedule: cron 与 at 校验", () => {
  assert.equal(validateCron("0 9 * * *"), "0 9 * * *")
  assert.throws(() => validateCron("0 9 * *"), /5 段/)
  assert.throws(() => validateCron("bad"), /5 段/)

  const at = parseAt("2099-01-01 09:30")
  assert.equal(at.getFullYear(), 2099)
  assert.equal(at.getMinutes(), 30)
  assert.throws(() => parseAt("2000-01-01 00:00"), /晚于/)
  assert.throws(() => parseAt("2027-02-30 10:00"), /有效时间/)
  assert.throws(() => parseAt("2099/01/01 10:00"), /格式/)
})

test("schedule: 创建/列出/删除", async t => {
  const database = new Database(":memory:")
  const store = new ScheduleStore()
  t.after(() => {
    store.shutdown()
    database.close()
  })
  await store.init({ inject: async () => {}, database })

  const one = store.create({ self_id: "9", user_id: "1", group_id: "100", prompt: "提醒喝水", at: "2099-01-01 09:30" })
  assert.equal(one.prompt, "提醒喝水")
  assert.ok(one.next_run_at > Date.now())

  const recurring = store.create({ self_id: "9", user_id: "1", group_id: "100", prompt: "每日提醒", cron: "0 9 * * *" })
  assert.equal(recurring.cron, "0 9 * * *")
  assert.ok(recurring.next_run_at > Date.now())

  // 群只是投递上下文，可选的私聊任务同样归属该用户
  const privateTask = store.create({ self_id: "9", user_id: "1", prompt: "私聊提醒", at: "2099-01-01 10:00" })

  assert.deepEqual(
    store.list({ self_id: "9", user_id: "1" }).map(row => row.id),
    [one.id, recurring.id, privateTask.id],
  )
  assert.deepEqual(store.list({ self_id: "9", user_id: "2" }), [])
  assert.equal(store.list({ all: true }).length, 3)

  assert.equal(store.remove(one.id), true)
  assert.equal(store.get(one.id), null)
  assert.equal(store.remove(one.id), false)
})

test("schedule: 参数约束", async t => {
  const database = new Database(":memory:")
  const store = new ScheduleStore()
  t.after(() => {
    store.shutdown()
    database.close()
  })
  await store.init({ inject: async () => {}, database })

  const base = { self_id: "9", user_id: "1", prompt: "x" }
  assert.throws(() => store.create({ ...base, prompt: " ", at: "2099-01-01 09:00" }), /prompt/)
  assert.throws(() => store.create({ ...base, at: "2099-01-01 09:00", cron: "0 9 * * *" }), /二选一/)
  assert.throws(() => store.create({ ...base }), /二选一/)
  assert.throws(() => store.create({ ...base, at: "2000-01-01 09:00" }), /晚于/)
})

test("schedule: 触发时注入 source=schedule", async t => {
  const database = new Database(":memory:")
  const injected = []
  const store = new ScheduleStore()
  const savedBot = globalThis.Bot
  globalThis.Bot = { bots: { 9: {} } }
  t.after(() => {
    if (savedBot === undefined) delete globalThis.Bot
    else globalThis.Bot = savedBot
    store.shutdown()
    database.close()
  })
  await store.init({ inject: async params => injected.push(params), database })

  const row = store.create({ self_id: "9", user_id: "1", group_id: "100", prompt: "提醒喝水", at: "2099-01-01 09:30" })
  await store._fire(row.id)

  assert.equal(injected.length, 1)
  assert.deepEqual(injected[0], { self_id: "9", user_id: "1", group_id: "100", text: "[定时任务] 提醒喝水", source: "schedule" })
  assert.equal(store.get(row.id), null, "一次性任务触发后删除")
})
