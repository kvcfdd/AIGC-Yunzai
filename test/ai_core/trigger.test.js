import test from "node:test"
import assert from "node:assert/strict"
import { evaluateTrigger } from "../../lib/ai_core/perception/trigger.js"

globalThis.Bot = { gml: new Map(), pickMember: () => null }
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

const scheduler = { abortAmbient: () => false, hasActive: () => false, lastFinishedAt: () => 0 }
const privateEvent = {
  self_id: "1",
  user_id: "2",
  isPrivate: true,
  message: [{ type: "text", text: "hi" }],
  msg: "hi",
  isMaster: false,
}

test("trigger: 总开关关闭", async () => {
  const r = await evaluateTrigger({ event: privateEvent, scheduler, aigc: { enable: false } })
  assert.equal(r.accepted, false)
})

test("trigger: 私聊正常触发", async () => {
  const r = await evaluateTrigger({ event: privateEvent, scheduler, aigc: { enable: true, private_chat_enable: true } })
  assert.equal(r.accepted, true)
  assert.equal(r.isAmbient, false)
  assert.equal(r.userMsg, "hi")
})

test("trigger: 私聊关闭与黑名单", async () => {
  assert.equal((await evaluateTrigger({ event: privateEvent, scheduler, aigc: { enable: true, private_chat_enable: false } })).accepted, false)
  assert.equal((await evaluateTrigger({ event: privateEvent, scheduler, aigc: { enable: true, qq_blacklist: ["2"] } })).accepted, false)
})

test("trigger: 前缀过滤，注入消息绕过", async () => {
  const aigc = { enable: true, prefix_filter: ["hi"] }
  assert.equal((await evaluateTrigger({ event: privateEvent, scheduler, aigc })).accepted, false)
  assert.equal((await evaluateTrigger({ event: { ...privateEvent, _injected: true }, scheduler, aigc })).accepted, true)
})

test("trigger: 群旁听概率与 at 触发", async () => {
  const group = {
    self_id: "1",
    user_id: "2",
    isGroup: true,
    group_id: "g",
    atBot: false,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
  }

  // 0% = 关闭
  assert.equal((await evaluateTrigger({ event: group, scheduler, aigc: { enable: true, proactive_group_chat: { probability: 0 } } })).accepted, false)

  // 100% = 每条消息必触发
  const ambient = await evaluateTrigger({ event: group, scheduler, aigc: { enable: true, proactive_group_chat: { probability: 100 } } })
  assert.equal(ambient.accepted, true)
  assert.equal(ambient.isAmbient, true)

  // 50% 概率用 Math.random 打桩验证
  const originalRandom = Math.random
  try {
    Math.random = () => 0.9
    assert.equal((await evaluateTrigger({ event: group, scheduler, aigc: { enable: true, proactive_group_chat: { probability: 50 } } })).accepted, false)

    Math.random = () => 0.1
    const hit = await evaluateTrigger({ event: group, scheduler, aigc: { enable: true, proactive_group_chat: { probability: 50 } } })
    assert.equal(hit.accepted, true)
    assert.equal(hit.isAmbient, true)
  } finally {
    Math.random = originalRandom
  }

  // @ 触发不受旁听概率影响
  const at = await evaluateTrigger({ event: { ...group, atBot: true }, scheduler, aigc: { enable: true, proactive_group_chat: { probability: 0 } } })
  assert.equal(at.accepted, true)
  assert.equal(at.isAmbient, false)
})

test("trigger: 群关键词命中触发旁听，概率为 0 也可触发", async () => {
  const group = {
    self_id: "1",
    user_id: "2",
    isGroup: true,
    group_id: "g",
    atBot: false,
    message: [{ type: "text", text: "芳州今天来吗" }],
    msg: "芳州今天来吗",
  }
  const aigc = { enable: true, proactive_group_chat: { keywords: ["芳州"], probability: 0 } }

  // 未命中关键词且概率为 0 → 不触发
  const miss = await evaluateTrigger({ event: { ...group, message: [{ type: "text", text: "早上好" }], msg: "早上好" }, scheduler, aigc })
  assert.equal(miss.accepted, false)

  // 命中关键词 → 旁听
  const hit = await evaluateTrigger({ event: group, scheduler, aigc })
  assert.equal(hit.accepted, true)
  assert.equal(hit.isAmbient, true)
})

test("trigger: 群内有进行中的对话时不触发旁听", async () => {
  const group = {
    self_id: "1",
    user_id: "2",
    isGroup: true,
    group_id: "g",
    atBot: false,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
  }
  const busyScheduler = { abortAmbient: () => false, hasActive: () => true }
  const aigc = { enable: true, proactive_group_chat: { keywords: ["芳州"], probability: 100 } }

  // 概率触发与关键词触发都需等待群内对话结束
  assert.equal((await evaluateTrigger({ event: group, scheduler: busyScheduler, aigc })).accepted, false)
  const keywordGroup = { ...group, message: [{ type: "text", text: "芳州今天来吗" }], msg: "芳州今天来吗" }
  assert.equal((await evaluateTrigger({ event: keywordGroup, scheduler: busyScheduler, aigc })).accepted, false)
})

test("trigger: 群对话结束后的静默期内不触发旁听", async () => {
  const group = {
    self_id: "1",
    user_id: "2",
    isGroup: true,
    group_id: "g",
    atBot: false,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
  }
  const aigc = { enable: true, proactive_group_chat: { keywords: ["芳州"], probability: 100 } }
  const coolingScheduler = { abortAmbient: () => false, hasActive: () => false, lastFinishedAt: () => Date.now() - 5_000 }

  // 结束后 10 秒内：概率与关键词都不触发
  assert.equal((await evaluateTrigger({ event: group, scheduler: coolingScheduler, aigc })).accepted, false)
  const keywordGroup = { ...group, message: [{ type: "text", text: "芳州今天来吗" }], msg: "芳州今天来吗" }
  assert.equal((await evaluateTrigger({ event: keywordGroup, scheduler: coolingScheduler, aigc })).accepted, false)

  // 超过 10 秒后恢复
  const idleScheduler = { ...coolingScheduler, lastFinishedAt: () => Date.now() - 15_000 }
  assert.equal((await evaluateTrigger({ event: group, scheduler: idleScheduler, aigc })).accepted, true)
})

test("trigger: @ 优先于旁听，群内有进行中请求也照常触发", async () => {
  const group = {
    self_id: "1",
    user_id: "2",
    isGroup: true,
    group_id: "g",
    atBot: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
  }
  let aborted = 0
  const busyScheduler = {
    abortAmbient: () => {
      aborted++
      return true
    },
    hasActive: () => true,
  }
  const at = await evaluateTrigger({ event: group, scheduler: busyScheduler, aigc: { enable: true, proactive_group_chat: { probability: 0 } } })
  assert.equal(at.accepted, true)
  assert.equal(at.isAmbient, false)
  assert.equal(aborted, 1)
})
