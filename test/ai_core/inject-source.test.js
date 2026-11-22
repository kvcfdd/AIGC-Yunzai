import test from "node:test"
import assert from "node:assert/strict"
import { INJECT_SOURCE, createInjectedEvent, normalizeInjectSource } from "../../lib/ai_core/perception/injected-event.js"
import { buildUserMessageMeta, CURRENT_TURN } from "../../lib/ai_core/llm/message-builders.js"
import { SystemPromptBuilder } from "../../lib/ai_core/perception/system-prompt.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, cyan: s => s, red: s => s }
globalThis.Bot = { bots: { 9: {} }, prepareEvent: e => e }

/** 关闭持久记忆，避免测试读取 data/aigc/memory */
function makeBuilder(event) {
  return new SystemPromptBuilder({
    event,
    skills: { list: async () => [] },
    tools: {},
    config: { aigc: { memory: { persistent: { enable: false } } }, master: {} },
  })
}

const privateEvent = { self_id: "9", user_id: "1", isGroup: false, isPrivate: true, sender: { nickname: "u" }, _injected: true }

test("inject: 来源归一化", () => {
  assert.equal(normalizeInjectSource("schedule"), INJECT_SOURCE.SCHEDULE)
  assert.equal(normalizeInjectSource(" agent "), INJECT_SOURCE.AGENT)
  assert.equal(normalizeInjectSource(""), INJECT_SOURCE.GENERIC)
  assert.equal(normalizeInjectSource(null), INJECT_SOURCE.GENERIC)
  assert.equal(normalizeInjectSource(123), INJECT_SOURCE.GENERIC)
  assert.equal(normalizeInjectSource("x".repeat(64)), "x".repeat(32))
})

test("inject: 合成事件带来源标记", async () => {
  const schedule = await createInjectedEvent({ self_id: "9", user_id: "1", text: "提醒喝水", source: INJECT_SOURCE.SCHEDULE }, {})
  assert.equal(schedule._injected, true)
  assert.equal(schedule._inject_source, INJECT_SOURCE.SCHEDULE)

  const generic = await createInjectedEvent({ self_id: "9", user_id: "1", text: "提醒喝水" }, {})
  assert.equal(generic._inject_source, INJECT_SOURCE.GENERIC)
})

test("inject: 来源随 user 消息元数据落盘", () => {
  const meta = buildUserMessageMeta({ isGroup: false })
  assert.equal(meta.inject_source, undefined)
  assert.equal(meta[CURRENT_TURN], true)
  assert.equal(
    Object.entries(meta).some(([key]) => key === "current_turn"),
    false,
    "当前轮标记是 Symbol，不进入 payload",
  )
  assert.equal(buildUserMessageMeta({ isGroup: true, group_name: "G", _injected: true, _inject_source: INJECT_SOURCE.SCHEDULE }).inject_source, "schedule")
  assert.equal(buildUserMessageMeta({ _injected: true }).inject_source, "inject")
})

test("inject: 私聊 runtime context 按来源提示", async () => {
  const schedule = await makeBuilder({ ...privateEvent, _inject_source: INJECT_SOURCE.SCHEDULE }).buildRuntimeContext(false)
  assert.match(schedule, /^<Real_time_status>/)
  assert.match(schedule, /<\/Real_time_status>$/)
  assert.match(schedule, /<trigger_context mode="schedule">/)
  assert.match(schedule, /<current_time>.+<\/current_time>/)
  assert.match(schedule, /<chat_context>/)
  assert.match(schedule, /你的信息: QQ: 9/)
  assert.match(schedule, /当前发言人: u\(QQ: 1\)/)
  assert.match(schedule, /定时任务/)
  assert.doesNotMatch(schedule, /后台 Agent/)
  assert.ok(schedule.indexOf("定时任务") < schedule.indexOf("<chat_context>"), "时间/提示在记忆头部，chat_context 之前")
  assert.doesNotMatch(schedule.slice(schedule.indexOf("<chat_context>")), /定时任务/, "chat_context 内不再包含注入提示")

  const agent = await makeBuilder({ ...privateEvent, _inject_source: INJECT_SOURCE.AGENT }).buildRuntimeContext(false)
  assert.match(agent, /后台 Agent/)
  assert.doesNotMatch(agent, /定时任务/)
})

test("inject: 群聊 runtime context 按来源提示并保留 @ 指令", async () => {
  const groupEvent = { self_id: "9", user_id: "1", isGroup: true, group_id: "100", group_name: "G", sender: { card: "u" }, member: { role: "member" }, _injected: true }
  const schedule = await makeBuilder({ ...groupEvent, _inject_source: INJECT_SOURCE.SCHEDULE }).buildRuntimeContext(false)
  assert.match(schedule, /定时任务/)
  assert.match(schedule, /@1/)
  assert.ok(schedule.indexOf("定时任务") < schedule.indexOf("<chat_context>"), "时间/提示在记忆头部，chat_context 之前")
  assert.doesNotMatch(schedule.slice(schedule.indexOf("<chat_context>")), /定时任务/, "chat_context 内不再包含注入提示")

  const agent = await makeBuilder({ ...groupEvent, _inject_source: INJECT_SOURCE.AGENT }).buildRuntimeContext(false)
  assert.match(agent, /后台 Agent/)
  assert.match(agent, /@1/)
  assert.doesNotMatch(agent, /定时任务/)
})

test("inject: 旁听提示在记忆头部，chat_context 只保留环境", async () => {
  const groupEvent = { self_id: "9", user_id: "1", isGroup: true, group_id: "100", group_name: "G", sender: { card: "u" }, member: { role: "member" } }
  const ctx = await makeBuilder(groupEvent).buildRuntimeContext(true)

  assert.match(ctx, /^<Real_time_status>\n  <trigger_context mode="ambient">/)
  assert.match(ctx, /后台静默旁听/)
  assert.ok(ctx.indexOf("后台静默旁听") < ctx.indexOf("<chat_context>"))
  assert.doesNotMatch(ctx.slice(ctx.indexOf("<chat_context>")), /后台静默旁听/)
  assert.match(ctx, /群信息: G\(ID: 100\)/)
  assert.doesNotMatch(ctx, /当前发言人/, "旁听不注入个人画像")
})
