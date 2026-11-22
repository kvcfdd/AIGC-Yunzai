import test from "node:test"
import assert from "node:assert/strict"
import { textWithContext } from "../../lib/ai_core/llm/provider-utils.js"
import { CURRENT_TURN } from "../../lib/ai_core/llm/message-builders.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

test("provider-utils: 当前轮 user 不加时间前缀，历史轮加", () => {
  const time = new Date(2024, 0, 2, 3, 4, 5).getTime()
  const history = textWithContext({ role: "user", content: "history", time, chat_type: "群聊", group_name: "测试群" })
  const current = textWithContext({ role: "user", content: "current", time, chat_type: "群聊", group_name: "测试群", [CURRENT_TURN]: true })

  assert.equal(history, "[2024-01-02 03:04:05 群聊 测试群] history")
  assert.equal(current, "current")
})
