import test from "node:test"
import assert from "node:assert/strict"
import registry from "../../lib/ai_core/tools/tool-registry.js"
import "../../lib/ai_core/tools/builtin/UserInfoTool.js"

function makeCtx({ userId = "111", isGroup = false, groupId = null, friendInfo = null, memberInfo = null, master = { 9: ["111"] } } = {}) {
  const member = memberInfo
    ? { getInfo: async () => memberInfo }
    : {
        getInfo: async () => {
          throw new Error("not found")
        },
      }
  return {
    event: { self_id: "9", user_id: userId, isGroup, group_id: groupId, group: isGroup ? { pickMember: () => member } : undefined },
    config: { master },
    bot: { pickFriend: () => ({ getInfo: async () => friendInfo }) },
  }
}

test("user_info: 默认查当前用户并可识别 master", async () => {
  const ctx = makeCtx({ friendInfo: { nickname: "Alice", sex: "female", age: 20, birthday_month: 1, birthday_day: 2, qqLevel: 50 } })
  const result = await registry.execute("user_info", {}, ctx)
  assert.match(result.result, /QQ: 111/)
  assert.match(result.result, /身份: master/)
  assert.match(result.result, /昵称: Alice/)
  assert.match(result.result, /性别: 女/)
  assert.match(result.result, /QQ等级: 50/)
})

test("user_info: 群成员信息与 master 别名", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: null, memberInfo: { card: "小明", title: "头衔", role: "admin", nickname: "Bob" } })
  const result = await registry.execute("user_info", { qq: "master" }, ctx)
  assert.match(result.result, /群名片: 小明/)
  assert.match(result.result, /群身份: 群管理员/)
  assert.match(result.result, /昵称: Bob/)
})

test("user_info: self 与 bot 别名", async () => {
  const ctx = makeCtx({ friendInfo: { nickname: "Alice", sex: "female" } })
  ctx.bot[9] = { nickname: "小云", avatar: "https://example.com/a.png" }

  assert.match((await registry.execute("user_info", { qq: "self" }, ctx)).result, /QQ: 111/)
  const bot = await registry.execute("user_info", { qq: "bot" }, ctx)
  assert.match(bot.result, /QQ: 9/)
  assert.match(bot.result, /昵称: 小云/)
  assert.match(bot.result, /头像: https:\/\/example.com\/a.png/)
})

test("user_info: 查不到用户时报错", async () => {
  const ctx = makeCtx({ friendInfo: null })
  assert.match((await registry.execute("user_info", { qq: "222" }, ctx)).error, /未找到用户/)
})
