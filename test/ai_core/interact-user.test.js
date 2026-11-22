import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/InteractUserTool.js"

globalThis.segment = { image: url => ({ type: "image", url }) }

function makeCtx({ userId = "111", isGroup = false, groupId = null, friend = null, member = null } = {}) {
  const replies = []
  return {
    replies,
    ctx: {
      event: {
        self_id: "9",
        user_id: userId,
        isGroup,
        group_id: groupId,
        reply: async seg => replies.push(seg),
        ...(isGroup ? { group: { pickMember: () => member } } : {}),
      },
      bot: { pickFriend: () => friend },
    },
  }
}

test("interact_user: 点赞", async () => {
  const calls = []
  const { ctx } = makeCtx({ friend: { thumbUp: async n => calls.push(n), poke: async () => calls.push("poke") } })
  const result = await registry.execute("interact_user", { action: "like" }, ctx)
  assert.match(result.result, /已给用户 111 点赞/)
  assert.deepEqual(calls, [1])
})

test("interact_user: 群内戳一戳", async () => {
  const calls = []
  const { ctx } = makeCtx({ isGroup: true, groupId: "100", member: { poke: async () => calls.push("poke") } })
  const result = await registry.execute("interact_user", { action: "poke", target_qq: "222" }, ctx)
  assert.match(result.result, /已戳一戳用户 222/)
  assert.deepEqual(calls, ["poke"])
})

test("interact_user: 表情包与冷却", async () => {
  const { ctx, replies } = makeCtx()
  const result = await registry.execute("interact_user", { action: "sticker" }, ctx)
  assert.match(result.result, /表情包已发送/)
  assert.equal(replies.length, 1)
  assert.match((await registry.execute("interact_user", { action: "sticker" }, ctx)).error, /太频繁/)
})

test("interact_user: 未知动作与渐进式注册", async () => {
  const { ctx } = makeCtx()
  assert.match((await registry.execute("interact_user", { action: "nope" }, ctx)).error, /未知的互动/)
  assert.equal(registry.tools.has("interact_user"), true)
  assert.equal(registry.isNative("interact_user"), false)
  assert.ok(registry.catalog().some(item => item.name === "interact_user"))
})
