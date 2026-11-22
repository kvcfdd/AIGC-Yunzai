import test from "node:test"
import assert from "node:assert/strict"
import { buildTurnTrace } from "../../lib/ai_core/output/turn-trace.js"

const messages = [
  { role: "user", content: "查一下" },
  {
    role: "assistant",
    content: "我先搜一下",
    reasoning_content: "需要先搜索",
    tool_calls: [{ function: { name: "web_search", arguments: '{"query":"x"}' } }],
  },
  { role: "tool", name: "web_search", content: "搜索结果" },
  { role: "assistant", content: "最终答复", reasoning_content: "信息够了" },
]

test("turn-trace: 包含思考/工具调用/工具结果/中间输出", () => {
  const text = buildTurnTrace(messages).join("\n")
  assert.match(text, /^需要先搜索\n/)
  assert.match(text, /【调用工具】web_search\n\{"query":"x"\}/)
  assert.match(text, /【工具结果】web_search\n搜索结果/)
  assert.match(text, /【中间输出】\n我先搜一下/)
  assert.match(text, /\n信息够了$/)
  assert.doesNotMatch(text, /【思考】/)
})

test("turn-trace: 不重复转发用户输入与最终答复正文", () => {
  const text = buildTurnTrace(messages).join("\n")
  assert.doesNotMatch(text, /最终答复/)
  assert.doesNotMatch(text, /查一下/)
})

test("turn-trace: 按顺序逐轮输出思考与工具过程，末尾追加 token 汇总", () => {
  const nodes = buildTurnTrace(messages, {
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, reasoning_tokens: 5, cached_tokens: 50 },
  })
  assert.equal(nodes.length, 4)
  assert.equal(nodes[0], "需要先搜索")
  assert.match(nodes[1], /^【调用工具】web_search/)
  assert.match(nodes[1], /【中间输出】/)
  assert.match(nodes[1], /【工具结果】web_search/)
  assert.equal(nodes[2], "信息够了")
  assert.equal(nodes[3], "Token: 输入100 | 输出20 | 思考5 | 总消耗120 | 缓存命中50(50%)")
  assert.doesNotMatch(nodes[3], /key:/)
})

test("turn-trace: 中间输出为 no_reply 时不转发", () => {
  const nodes = buildTurnTrace([
    { role: "assistant", content: "no_reply", tool_calls: [{ function: { name: "f", arguments: "{}" } }] },
    { role: "tool", name: "f", content: "ok" },
    { role: "assistant", content: "done" },
  ])
  assert.doesNotMatch(nodes.join("\n"), /中间输出/)
  assert.doesNotMatch(nodes.join("\n"), /no_reply/)
})

test("turn-trace: 已即时发送的中间输出不再重复", () => {
  const sent = {
    role: "assistant",
    content: "我先搜一下",
    reasoning_content: "需要先搜索",
    tool_calls: [{ function: { name: "web_search", arguments: '{"query":"x"}' } }],
  }
  Object.defineProperty(sent, "interim_sent", { value: true, enumerable: false })
  const text = buildTurnTrace([sent, { role: "tool", name: "web_search", content: "搜索结果" }, { role: "assistant", content: "最终答复" }]).join("\n")

  assert.doesNotMatch(text, /【中间输出】/)
  assert.doesNotMatch(text, /我先搜一下/)
  assert.match(text, /需要先搜索/)
  assert.match(text, /【调用工具】web_search/)
  assert.match(text, /【工具结果】web_search\n搜索结果/)
})

test("turn-trace: 无思考无工具时仅转发 token 汇总", () => {
  const nodes = buildTurnTrace(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ],
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  )
  assert.equal(nodes.length, 1)
  assert.match(nodes[0], /^Token: 输入1 \| 输出1 \| 思考0 \| 总消耗2 \| 缓存命中0\(0%\)$/)
})

test("turn-trace: 失败工具结果与空轨迹", () => {
  const nodes = buildTurnTrace([
    { role: "assistant", tool_calls: [{ function: { name: "media" } }] },
    { role: "tool", name: "media", content: "boom", is_error: true },
  ])
  assert.match(nodes.join("\n"), /【工具结果】media（失败）\nboom/)
  assert.deepEqual(buildTurnTrace([]), [])
})

test("turn-trace: 思维链按上限截断，含省略号不超过上限", () => {
  const [node] = buildTurnTrace(
    [
      { role: "assistant", reasoning_content: "x".repeat(30), content: "y", tool_calls: [] },
      { role: "assistant", content: "final" },
    ],
    { thinkingChars: 10 },
  )
  assert.equal(node.length, 10)
  assert.ok(node.endsWith("..."))
})

test("turn-trace: 思维链默认保留 2000 字", () => {
  const [node] = buildTurnTrace([
    { role: "assistant", reasoning_content: "x".repeat(3000) },
    { role: "assistant", content: "final" },
  ])
  assert.equal(node.length, 2000)
  assert.ok(node.endsWith("..."))
})

test("turn-trace: 默认工具结果最多 200 字", () => {
  const [node] = buildTurnTrace([
    { role: "tool", name: "web_search", content: "y".repeat(500) },
    { role: "assistant", content: "final" },
  ])
  const body = node.split("\n")[1]
  assert.equal(body.length, 200)
  assert.ok(body.endsWith("..."))
})
