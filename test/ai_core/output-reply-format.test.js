import test from "node:test"
import assert from "node:assert/strict"
import { parseReplyParts, sanitizeVoiceText, stripReplyTags, toMessageSegments, stripQuotePrefix } from "../../lib/ai_core/output/reply-format.js"

globalThis.segment = { at: qq => ({ type: "at", qq }) }
globalThis.Bot = { gml: new Map() }

test("output: 废弃 <xix> 分条，标签仅作为残留清除", () => {
  assert.deepEqual(parseReplyParts("第一条<xix>第二条"), [{ type: "text", text: "第一条第二条" }])
  assert.deepEqual(parseReplyParts("单条"), [{ type: "text", text: "单条" }])
  assert.deepEqual(parseReplyParts(""), [])
})

test("output: 开启自动分条后短回复按连续换行切分", () => {
  assert.deepEqual(parseReplyParts("第一条\n\n第二条", { maxChars: 200 }), [
    { type: "text", text: "第一条" },
    { type: "text", text: "第二条" },
  ])
  assert.deepEqual(parseReplyParts("第一条\n\n第二条"), [{ type: "text", text: "第一条\n\n第二条" }], "默认 0 关闭时不切分")
})

test("output: 自动分条跳过代码", () => {
  const fenced = "看代码：\n\n```js\nconst a = 1\n\nconst b = 2\n```"
  assert.deepEqual(parseReplyParts(fenced, { maxChars: 200 }), [{ type: "text", text: fenced }], "围栏代码块不切分")

  const plain = "const a = 1;\n\nconst b = 2;"
  assert.deepEqual(parseReplyParts(plain, { maxChars: 200 }), [{ type: "text", text: plain }], "无围栏的代码特征不切分")
})

test("output: 自动分条字符上限可配置", () => {
  const long = `${"一".repeat(100)}\n\n${"二".repeat(100)}`
  assert.equal(long.length, 202)
  assert.deepEqual(parseReplyParts(long), [{ type: "text", text: long }], "默认 0 关闭")
  assert.equal(parseReplyParts(long, { maxChars: 300 }).length, 2, "自定义上限生效")
  assert.deepEqual(parseReplyParts("一二\n\n三四", { maxChars: 4 }), [{ type: "text", text: "一二\n\n三四" }], "低于自定义上限才切分")
})

test("output: 文字与语音二选一，语音优先", () => {
  assert.deepEqual(parseReplyParts("文字<voice>语音</voice><xix>末尾"), [{ type: "voice", text: "语音" }])
})

test("output: 语音一次只发一条", () => {
  assert.deepEqual(parseReplyParts("<voice>一</voice>文字<voice>二</voice>"), [{ type: "voice", text: "一" }])
})

test("output: 不再兼容旧版 <reply> 包裹", () => {
  assert.deepEqual(parseReplyParts("<reply>一</reply><reply>二</reply>"), [{ type: "text", text: "一二" }])
})

test("output: 残留协议标签不泄漏", () => {
  assert.equal(stripReplyTags("你好<xix><reply>世界</reply>"), "你好世界")
  assert.deepEqual(parseReplyParts("<voice></voice><xix>"), [])
  assert.deepEqual(parseReplyParts("<voice></voice>文字"), [{ type: "text", text: "文字" }])
})

test("output: 语音文本清洗", () => {
  assert.equal(sanitizeVoiceText("[笑]你好😀 <xix> 世界"), "你好 世界")
  assert.equal(sanitizeVoiceText("**重点** 内容"), "重点 内容")
  assert.equal(sanitizeVoiceText("😀[滑稽]"), "")
})

test("output: 引用前缀清理", () => {
  assert.equal(stripQuotePrefix("[引用 abc] hi"), "hi")
  assert.equal(stripQuotePrefix("hi"), "hi")
})

test("output: 表情名转 face 段（含优先级与别名）", () => {
  assert.deepEqual(toMessageSegments("[微笑]hi", {}), [
    { type: "face", id: 14 },
    { type: "text", data: { text: "hi" } },
  ])
  assert.deepEqual(toMessageSegments("[害羞]", {}), [{ type: "face", id: 6 }], "同名时优先小黄脸")
  assert.deepEqual(toMessageSegments("[马到成功]", {}), [{ type: "face", id: 470 }], "规范名优先于协议端别名")
  assert.deepEqual(toMessageSegments("[端午]", {}), [{ type: "face", id: 415 }], "协议端别名可用")
})

test("output: @ 转 at 段", () => {
  const parts = toMessageSegments("hi @123", { isGroup: false })
  assert.equal(Array.isArray(parts), true)
  assert.equal(
    parts.some(p => p.type === "at" && p.qq === "123"),
    true,
  )
  assert.equal(toMessageSegments("plain", {}), "plain")
})
