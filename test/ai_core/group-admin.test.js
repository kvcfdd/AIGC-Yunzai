import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/GroupAdminTool.js"

function makeGroup({ botRole = "admin", senders = {} } = {}) {
  const calls = []
  return {
    calls,
    is_admin: botRole === "admin" || botRole === "owner",
    is_owner: botRole === "owner",
    pickMember: () => ({ role: botRole, getInfo: async () => ({ role: botRole }) }),
    kickMembers: async ids => calls.push(["kickMembers", ids]),
    kickMember: async id => calls.push(["kickMember", id]),
    muteMember: async (id, seconds) => calls.push(["muteMember", id, seconds]),
    muteAll: async enable => calls.push(["muteAll", enable]),
    setCard: async (id, card) => calls.push(["setCard", id, card]),
    sendNotice: async content => calls.push(["sendNotice", content]),
    recallMsg: async id => calls.push(["recallMsg", id]),
    getMsg: async id => ({ sender: { user_id: senders[id] ?? "222" } }),
  }
}

function makeCtx({ group = makeGroup(), role = "admin", isMaster = false, userId = "111" } = {}) {
  return {
    event: { isGroup: true, group_id: "100", self_id: "999", user_id: userId, isMaster, member: { role, is_admin: role === "admin" || role === "owner" }, group },
  }
}

test("group_admin: 群管理员踢人/禁言/全员禁言/公告", async () => {
  const group = makeGroup()
  const ctx = makeCtx({ group })

  assert.match((await registry.execute("group_admin", { action: "kick", user: ["222", 333] }, ctx)).result, /已批量踢出 2 人/)
  assert.deepEqual(group.calls.at(-1), ["kickMembers", ["222", "333"]])
  assert.match((await registry.execute("group_admin", { action: "mute", user: 222 }, ctx)).result, /禁言 300 秒/)
  assert.deepEqual(group.calls.at(-1), ["muteMember", "222", 300])
  assert.match((await registry.execute("group_admin", { action: "mute", user: "222", duration: 0 }, ctx)).result, /解除/)
  assert.match((await registry.execute("group_admin", { action: "mute_all", enable: true }, ctx)).result, /开启/)
  assert.match((await registry.execute("group_admin", { action: "send_notice", content: "hi" }, ctx)).result, /已发送/)
})

test("group_admin: 普通成员只能对自己操作", async () => {
  const group = makeGroup()
  const ctx = makeCtx({ group, role: "member" })

  assert.match((await registry.execute("group_admin", { action: "kick", user: "222" }, ctx)).error, /只能对自己/)
  assert.match((await registry.execute("group_admin", { action: "mute", user: "222" }, ctx)).error, /只能对自己/)
  assert.match((await registry.execute("group_admin", { action: "set_card", user: "222", card: "x" }, ctx)).error, /只能对自己/)

  // 被群友骂时，可以对当前用户本人禁言/踢出
  assert.match((await registry.execute("group_admin", { action: "mute", user: "111", duration: 60 }, ctx)).result, /禁言 60 秒/)
  assert.deepEqual(group.calls.at(-1), ["muteMember", "111", 60])
  assert.match((await registry.execute("group_admin", { action: "set_card", user: "111", card: "新名片" }, ctx)).result, /新名片/)
  assert.deepEqual(group.calls.at(-1), ["setCard", "111", "新名片"])
  assert.match((await registry.execute("group_admin", { action: "kick", user: "111" }, ctx)).result, /已踢出 111/)
})

test("group_admin: Bot 无管理权限时拒绝", async () => {
  const group = makeGroup({ botRole: "member" })
  const ctx = makeCtx({ group, role: "admin" })
  assert.match((await registry.execute("group_admin", { action: "mute", user: "222" }, ctx)).error, /Bot 不是群管理员/)
})

test("group_admin: 撤回自己的消息无需管理权限，别人的消息需要", async () => {
  const group = makeGroup({ senders: { m1: "111", m2: "222" } })
  const ctx = makeCtx({ group, role: "member" })

  assert.match((await registry.execute("group_admin", { action: "recall", message_id: "m1" }, ctx)).result, /已撤回/)
  assert.match((await registry.execute("group_admin", { action: "recall", message_id: "m2" }, ctx)).error, /权限不足/)

  const adminCtx = makeCtx({ group, role: "admin" })
  assert.match((await registry.execute("group_admin", { action: "recall", message_id: "m2" }, adminCtx)).result, /已撤回/)
})

test("group_admin: 参数校验、群聊限制与渐进式注册", async () => {
  const ctx = makeCtx()

  assert.match((await registry.execute("group_admin", { action: "kick" }, ctx)).error, /user/)
  assert.match((await registry.execute("group_admin", { action: "mute_all" }, ctx)).error, /enable/)
  assert.match((await registry.execute("group_admin", { action: "nope" }, ctx)).error, /不支持的操作/)
  assert.match((await registry.execute("group_admin", { action: "kick", user: "999" }, ctx)).error, /bot 自身/)

  const privateCtx = { event: { isGroup: false } }
  assert.match((await registry.execute("group_admin", { action: "kick", user: "222" }, privateCtx)).error, /仅在群聊中可用/)

  assert.equal(registry.tools.has("group_admin"), true)
  assert.equal(registry.isNative("group_admin"), false)
  assert.ok(registry.catalog().some(item => item.name === "group_admin"))
})
