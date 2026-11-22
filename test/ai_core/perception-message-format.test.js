import test from "node:test"
import assert from "node:assert/strict"
import { extractMsgText, formatHistoryTime } from "../../lib/ai_core/perception/message-format.js"

test("extractMsgText: 文本/@/图片/文件占位", () => {
  const msg = {
    message: [
      { type: "text", text: "hi " },
      { type: "at", qq: "123" },
      { type: "image", url: "http://x/a.png" },
      { type: "file", name: "a.pdf", url: "http://x/a.pdf" },
    ],
  }
  assert.equal(
    extractMsgText(msg, () => "名字", { withUrl: false }),
    "hi @名字[图片][文件: a.pdf]",
  )
  assert.equal(extractMsgText(msg, () => "名字", { withUrl: true }).includes("http://x/a.png"), true)
})

test("formatHistoryTime: 空值", () => {
  assert.equal(formatHistoryTime(0), "")
})
