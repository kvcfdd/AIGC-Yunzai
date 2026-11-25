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

test("user_info: 查 bot_owner", async () => {
  const ctx = makeCtx({ friendInfo: { nickname: "Alice", sex: "female", age: 20, birthday_month: 1, birthday_day: 2, qqLevel: 50 } })
  const result = await registry.execute("user_info", { type: "bot_owner" }, ctx)
  assert.match(result.result, /^<user_info>[\s\S]*<\/user_info>$/)
  assert.match(result.result, /<qq>111<\/qq>/)
  assert.match(result.result, /<identity>bot_owner<\/identity>/)
  assert.match(result.result, /<nickname>Alice<\/nickname>/)
  assert.match(result.result, /<sex>女<\/sex>/)
  assert.match(result.result, /<qq_level>50<\/qq_level>/)
  assert.doesNotMatch(result.result, /<group_member|<note>/)
})

test("user_info: 查指定用户的群成员信息", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: null, memberInfo: { card: "小明", title: "头衔", role: "admin", nickname: "Bob" } })
  const result = await registry.execute("user_info", { type: "user", qq: "222" }, ctx)
  assert.match(result.result, /<qq>222<\/qq>/)
  assert.match(result.result, /<nickname>Bob<\/nickname>/)
  assert.match(result.result, /<group_member>[\s\S]*<card>小明<\/card>[\s\S]*<title>头衔<\/title>[\s\S]*<role>群管理员<\/role>[\s\S]*<\/group_member>/)
  assert.doesNotMatch(result.result, /<note>/)
})

test("user_info: 群内无成员信息时给出不在群提示", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: { nickname: "Bob" } })
  const result = await registry.execute("user_info", { type: "user", qq: "222" }, ctx)
  assert.match(result.result, /<note>用户 222 不在当前群<\/note>/)
  assert.doesNotMatch(result.result, /<group_member/)
})

test("user_info: 群内查主人不在群时给出提示", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: { nickname: "Alice" } })
  const result = await registry.execute("user_info", { type: "bot_owner" }, ctx)
  assert.match(result.result, /<qq>111<\/qq>/)
  assert.match(result.result, /<identity>bot_owner<\/identity>/)
  assert.match(result.result, /<note>用户 111 不在当前群<\/note>/)
})

test("user_info: 群内用主人 QQ 查用户时带上群信息", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: null, memberInfo: { card: "群主", role: "owner", nickname: "Alice" } })
  const result = await registry.execute("user_info", { type: "user", qq: "111" }, ctx)
  assert.match(result.result, /<identity>bot_owner<\/identity>/)
  assert.match(result.result, /<group_member>[\s\S]*<role>群主<\/role>[\s\S]*<\/group_member>/)
  assert.doesNotMatch(result.result, /<note>/)
})

test("user_info: 群成员无名片/头衔/身份时保留 group_member 标记", async () => {
  const ctx = makeCtx({ isGroup: true, groupId: "100", friendInfo: null, memberInfo: { nickname: "Bob" } })
  const result = await registry.execute("user_info", { type: "user", qq: "222" }, ctx)
  assert.match(result.result, /<group_member\/>/)
  assert.doesNotMatch(result.result, /<note>/)
})

test("user_info: 文本按 XML 转义", async () => {
  const ctx = makeCtx({ friendInfo: { nickname: "A<B&C" } })
  const result = await registry.execute("user_info", { type: "bot_owner" }, ctx)
  assert.match(result.result, /<nickname>A&lt;B&amp;C<\/nickname>/)
})

test("user_info: 查用户时 qq 必填", async () => {
  const ctx = makeCtx()
  assert.match((await registry.execute("user_info", { type: "user" }, ctx)).error, /qq 必填/)
})

test("user_info: type 校验与未配置 bot_owner", async () => {
  assert.match((await registry.execute("user_info", { type: "bot" }, makeCtx())).error, /type/)
  assert.match((await registry.execute("user_info", { type: "bot_owner" }, makeCtx({ master: {} }))).error, /未配置 bot_owner/)
})

test("user_info: 查不到用户时报错", async () => {
  const ctx = makeCtx({ friendInfo: null })
  assert.match((await registry.execute("user_info", { type: "user", qq: "222" }, ctx)).error, /未找到用户/)
})
