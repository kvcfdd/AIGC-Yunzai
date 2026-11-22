import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/ScheduleTaskTool.js"

function makeSchedule(overrides = {}) {
  const calls = []
  return {
    calls,
    create: args => {
      calls.push(["create", args])
      return { id: 7, next_run_at: Date.now() + 60_000, ...args }
    },
    list: args => {
      calls.push(["list", args])
      return []
    },
    get: id => ({ id, self_id: "9", user_id: "1", group_id: null, prompt: "p", cron: null, at: Date.now() + 60_000 }),
    remove: id => calls.push(["remove", id]),
    ...overrides,
  }
}

function makeCtx(schedule, { userId = "1", isMaster = false, groupId = null } = {}) {
  return {
    event: { self_id: "9", user_id: userId, isGroup: !!groupId, group_id: groupId, isMaster },
    schedule,
  }
}

test("schedule_task: 创建/列表/删除", async () => {
  const schedule = makeSchedule()
  const ctx = makeCtx(schedule)

  assert.match((await registry.execute("schedule_task", { action: "create", prompt: "提醒喝水", at: "2099-01-01 09:30" }, ctx)).result, /已创建定时任务 #7/)
  assert.deepEqual(schedule.calls[0], ["create", { self_id: "9", user_id: "1", group_id: null, prompt: "提醒喝水", cron: undefined, at: "2099-01-01 09:30" }])
  assert.match((await registry.execute("schedule_task", { action: "list" }, ctx)).result, /当前没有定时任务/)
  assert.match((await registry.execute("schedule_task", { action: "delete", id: 7 }, ctx)).result, /已删除定时任务 #7/)
})

test("schedule_task: 列表按用户归属，master 可跨用户", async () => {
  const rows = [{ id: 3, prompt: "喝水", cron: "0 9 * * *", next_run_at: Date.now() + 60_000 }]
  let listArgs
  const schedule = makeSchedule({
    list: args => {
      listArgs = args
      return args.all ? rows : []
    },
  })

  const ctx = makeCtx(schedule, { groupId: "100" })
  assert.match((await registry.execute("schedule_task", { action: "list" }, ctx)).result, /当前没有定时任务/)
  assert.deepEqual(listArgs, { self_id: "9", user_id: "1", all: false })

  assert.match((await registry.execute("schedule_task", { action: "list", all: true }, makeCtx(schedule, { isMaster: true }))).result, /#3/)
  assert.match((await registry.execute("schedule_task", { action: "list", all: true }, ctx)).result, /当前没有定时任务/)
})

test("schedule_task: 删除权限按用户归属", async () => {
  // 在另一个群创建的任务，自己仍然可以删除
  const crossGroup = makeSchedule({ get: id => ({ id, self_id: "9", user_id: "1", group_id: "100" }) })
  assert.match((await registry.execute("schedule_task", { action: "delete", id: 5 }, makeCtx(crossGroup, { groupId: "200" }))).result, /已删除定时任务 #5/)

  const otherTask = makeSchedule({ get: id => ({ id, self_id: "9", user_id: "2", group_id: null }) })
  assert.match((await registry.execute("schedule_task", { action: "delete", id: 5 }, makeCtx(otherTask))).error, /只能删除自己的/)
  assert.match((await registry.execute("schedule_task", { action: "delete", id: 5 }, makeCtx(otherTask, { isMaster: true }))).result, /已删除定时任务 #5/)
})

test("schedule_task: 参数校验与渐进式注册", async () => {
  const schedule = makeSchedule()
  const ctx = makeCtx(schedule)

  assert.match((await registry.execute("schedule_task", { action: "nope" }, ctx)).error, /不支持的操作/)
  assert.match((await registry.execute("schedule_task", { action: "delete", id: 0 }, ctx)).error, /有效的任务 id/)
  assert.match((await registry.execute("schedule_task", { action: "create", prompt: "x" }, { ...ctx, schedule: undefined })).error, /不支持定时任务/)
  assert.match((await registry.execute("schedule_task", { action: "create", prompt: "x" }, { ...ctx, event: undefined })).error, /无法确定当前会话/)

  assert.equal(registry.tools.has("schedule_task"), true)
  assert.equal(registry.isNative("schedule_task"), false)
  assert.ok(registry.catalog().some(item => item.name === "schedule_task"))
})
