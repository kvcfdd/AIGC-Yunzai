import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/BlockUserTool.js"

function makeCtx({ userId = "111", isMaster = false, blacklist = [] } = {}) {
  const writes = []
  const config = {
    aigc: { qq_blacklist: [...blacklist] },
    setConfig(name, key, value) {
      writes.push({ name, key, value })
      this.aigc[key] = [...value]
    },
  }
  return { ctx: { event: { user_id: userId, self_id: "999", isMaster }, config }, writes }
}

test("block_user: 管理员可屏蔽/解除其他账号", async () => {
  const { ctx, writes } = makeCtx({ isMaster: true, blacklist: ["111"] })

  const blocked = await registry.execute("block_user", { action: "block", user_id: "222" }, ctx)
  assert.match(blocked.result, /已屏蔽用户 222/)
  assert.deepEqual(writes.at(-1), { name: "aigc", key: "qq_blacklist", value: ["111", "222"] })

  const unblocked = await registry.execute("block_user", { action: "unblock", user_id: "111" }, ctx)
  assert.match(unblocked.result, /已解除屏蔽用户 111/)
  assert.deepEqual(ctx.config.aigc.qq_blacklist, ["222"])
})

test("block_user: 普通用户只能控制自己", async () => {
  const { ctx } = makeCtx({ userId: "111", isMaster: false })

  const denied = await registry.execute("block_user", { action: "block", user_id: "222" }, ctx)
  assert.match(denied.error, /权限不足/)

  const self = await registry.execute("block_user", { action: "block" }, ctx)
  assert.match(self.result, /已屏蔽用户 111/)
})

test("block_user: 重复操作、非法动作与渐进式注册", async () => {
  const { ctx } = makeCtx({ userId: "111", blacklist: ["111"] })

  assert.match((await registry.execute("block_user", { action: "block" }, ctx)).result, /已在屏蔽列表/)
  assert.match((await registry.execute("block_user", { action: "unblock" }, ctx)).result, /已解除屏蔽/)
  assert.match((await registry.execute("block_user", { action: "unblock" }, ctx)).result, /未被屏蔽/)
  assert.match((await registry.execute("block_user", { action: "nope" }, ctx)).error, /action must be/)
  assert.match((await registry.execute("block_user", { action: "block", user_id: "999" }, ctx)).error, /bot 自身/)

  assert.equal(registry.tools.has("block_user"), true)
  assert.equal(registry.isNative("block_user"), false)
  assert.ok(registry.catalog().some(item => item.name === "block_user"))
})
