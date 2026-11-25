import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} } }

const { SystemPromptBuilder } = await import("../../lib/ai_core/perception/system-prompt.js")

async function setup(t) {
  // 记忆目录固定为 <cwd>/data/aigc/memory；测试切到临时目录隔离
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-mention-"))
  const prev = process.cwd()
  process.chdir(dir)
  t.after(async () => {
    process.chdir(prev)
    await fs.rm(dir, { recursive: true, force: true })
  })
}

function makeEvent({ members = {}, at = ["222"] } = {}) {
  const message = [
    { type: "at", qq: "9" },
    { type: "text", text: " 你们觉得 " },
  ]
  for (const qq of at) message.push({ type: "at", qq }, { type: "text", text: " " })
  message.push({ type: "text", text: "咋样" })

  return {
    isGroup: true,
    isMaster: false,
    self_id: "9",
    user_id: "111",
    group_id: "100",
    group_name: "测试群",
    sender: { card: "Alice", nickname: "Alice" },
    message,
    group: {
      pickMember: qq => members[String(qq)] || null,
    },
  }
}

function makeBuilder(event, master = { 9: ["222"] }) {
  return new SystemPromptBuilder({
    event,
    skills: { list: async () => [] },
    tools: { catalog: () => [] },
    config: { aigc: { system_prompt: "persona" }, master },
  })
}

test("mentioned users: 当前发言人后注入被 @ 用户信息与画像", async t => {
  await setup(t)
  const userDir = path.join(process.cwd(), "data/aigc/memory/users")
  await fs.mkdir(userDir, { recursive: true })
  await fs.writeFile(path.join(userDir, "222.md"), "# 用户画像\n<!-- 注释 -->\n- 喜欢猫\n- 讨厌香菜\n", "utf8")

  const event = makeEvent({ members: { 222: { card: "小明", nickname: "Bob", role: "admin", title: "头衔" } } })
  const runtime = await makeBuilder(event).buildRuntimeContext(false, {})

  assert.match(runtime, /<mentioned name="小明" qq="222" role="群管理员,bot_owner">喜欢猫；讨厌香菜<\/mentioned>/)
  assert.ok(runtime.indexOf("当前发言人:") < runtime.indexOf("<mentioned "))
  assert.doesNotMatch(runtime, /<mentioned_users>/)
  assert.doesNotMatch(runtime, /qq="9"/)
  assert.doesNotMatch(runtime, /qq="111"/)
})

test("mentioned users: 无画像时只展示用户信息", async t => {
  await setup(t)
  const event = makeEvent({ members: { 222: { card: "小明", role: "member" } } })
  const runtime = await makeBuilder(event, { 9: [] }).buildRuntimeContext(false, {})
  assert.match(runtime, /<mentioned name="小明" qq="222" role="群成员"\/>/)
})

test("mentioned users: 不限制被 @ 人数", async t => {
  await setup(t)
  const qqs = ["201", "202", "203", "204", "205"]
  const members = {}
  for (const qq of qqs) members[qq] = { card: `用户${qq}`, role: "member" }

  const runtime = await makeBuilder(makeEvent({ members, at: qqs }), { 9: [] }).buildRuntimeContext(false, {})
  for (const qq of qqs) assert.match(runtime, new RegExp(`<mentioned name="用户${qq}" qq="${qq}" role="群成员"/>`))
})

test("mentioned users: 旁听模式与私聊不注入", async t => {
  await setup(t)
  const event = makeEvent({ members: { 222: { card: "小明", role: "member" } } })

  assert.doesNotMatch(await makeBuilder(event).buildRuntimeContext(true, {}), /<mentioned /)

  delete event.isGroup
  event.isPrivate = true
  assert.doesNotMatch(await makeBuilder(event).buildRuntimeContext(false, {}), /<mentioned /)
})
