import test from "node:test"
import assert from "node:assert/strict"
import { buildMessageParams, convertMessages, parseMessage } from "../../lib/ai_core/llm/anthropic/adapter.js"
import { markAnimatedFrames } from "../../lib/ai_core/media/animated.js"
import { STATUS_BAR } from "../../lib/ai_core/llm/message-builders.js"

const tools = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }]

test("anthropic: 消息转换与工具结果分组", () => {
  const out = convertMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi", time: Date.now(), chat_type: "私聊", images: ["data:image/png;base64,abc"] },
    {
      role: "assistant",
      content: "calling",
      reasoning_parts: [{ text: "think", signature: "sig" }],
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", images: ["data:image/png;base64,xyz"] },
  ])

  assert.equal(out.system, "sys")
  assert.equal(out.messages[0].role, "user")
  assert.equal(
    out.messages[0].content.some(b => b.type === "image"),
    true,
  )
  assert.equal(out.messages[1].role, "assistant")
  assert.equal(
    out.messages[1].content.some(b => b.type === "thinking"),
    true,
  )
  assert.equal(
    out.messages[1].content.some(b => b.type === "tool_use"),
    true,
  )
  assert.equal(out.messages[2].role, "user")
  const tr = out.messages[2].content[0]
  assert.equal(tr.type, "tool_result")
  assert.equal(tr.tool_use_id, "c1")
  assert.equal(
    tr.content.some(b => b.type === "image"),
    true,
  )
})

test("anthropic: runtime_context 作为 user 最后一个 block", () => {
  const out = convertMessages([{ role: "user", content: "hi", runtime_context: "<Real_time_status>x</Real_time_status>" }])
  const last = out.messages[0].content.at(-1)
  assert.equal(last.type, "text")
  assert.equal(last.text, "<Real_time_status>x</Real_time_status>")
})

test("anthropic: 连续同角色合并 + tool_result 在前", () => {
  const out = convertMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f" },
    { role: "user", content: "next" },
  ])
  assert.equal(out.messages[0].content.length, 2)
  assert.deepEqual(
    out.messages[0].content.map(b => b.text),
    ["a", "b"],
    "连续 user 保留为两个独立 text 组件",
  )
  assert.equal(out.messages[1].role, "assistant")
  assert.equal(out.messages[2].content[0].type, "tool_result")
  assert.equal(out.messages[2].content[1].type, "text")
  assert.equal(out.messages[2].content[1].text, "next", "工具结果后的 user 文本是独立组件")
})

test("anthropic: redacted_thinking 原样回传", () => {
  const r = parseMessage({ content: [{ type: "redacted_thinking", data: "enc" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
  assert.deepEqual(r.reasoning_parts, [{ text: "", signature: null, redacted: "enc" }])
})

test("anthropic: 空 thinking signature 保留，历史 thinking 丢弃", () => {
  const out = convertMessages([
    { role: "user", content: "old" },
    { role: "assistant", content: "old-answer", reasoning_parts: [{ text: "old-think", signature: "OLD" }] },
    { role: "user", content: "new" },
    { role: "assistant", content: null, reasoning_parts: [{ text: "", signature: "NEW" }], tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
  ])
  assert.equal(
    out.messages[1].content.some(b => b.type === "thinking"),
    false,
  )
  assert.equal(
    out.messages[3].content.some(b => b.type === "thinking" && b.thinking === "" && b.signature === "NEW"),
    true,
  )
})

test("anthropic: turn_start 作为当前轮边界，插话前的本轮 thinking 仍回放", () => {
  const out = convertMessages([
    { role: "user", content: "old" },
    { role: "assistant", content: "old-answer", reasoning_parts: [{ text: "old-think", signature: "OLD" }] },
    { role: "user", content: "new", turn_start: true },
    { role: "assistant", content: null, reasoning_parts: [{ text: "new-think", signature: "NEW" }], tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f" },
    { role: "user", content: "插话" },
    { role: "assistant", content: "done" },
  ])

  const assistants = out.messages.filter(m => m.role === "assistant")
  assert.equal(
    assistants[0].content.some(b => b.type === "thinking"),
    false,
    "历史 thinking 丢弃",
  )
  assert.equal(
    assistants[1].content.some(b => b.type === "thinking" && b.signature === "NEW"),
    true,
    "插话前的本轮 thinking 保留",
  )

  const merged = out.messages.find(m => m.role === "user" && m.content.some(b => b.type === "tool_result"))
  assert.equal(merged.content[0].type, "tool_result")
  assert.equal(merged.content[1].type, "text")
  assert.equal(merged.content[1].text, "插话")
})

test("anthropic: 工具结果里的 status_bar 是独立组件，user 插话在其后", () => {
  const out = convertMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", [STATUS_BAR]: "<status_bar>\n剩余次数: 2\n</status_bar>" },
    { role: "user", content: "插话" },
  ])

  const user = out.messages.find(m => m.role === "user" && m.content.some(b => b.type === "tool_result"))
  assert.equal(user.content[0].type, "tool_result")
  assert.deepEqual(
    user.content[0].content.map(b => b.text),
    ["ok", "<status_bar>\n剩余次数: 2\n</status_bar>"],
  )
  assert.equal(user.content[1].type, "text")
  assert.equal(user.content[1].text, "插话")
})

test("anthropic: tool_result is_error", () => {
  const out = convertMessages([{ role: "tool", content: "bad", tool_call_id: "c1", is_error: true }])
  assert.equal(out.messages[0].content[0].is_error, true)
})

test("anthropic: cache_control 断点（历史 + 请求末尾）", () => {
  const out = convertMessages([
    { role: "user", content: "old", cache_break: true },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "next" },
  ])
  assert.deepEqual(out.messages[0].content.at(-1).cache_control, { type: "ephemeral" })
  assert.deepEqual(out.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" })
})

test("anthropic: system 缓存断点", () => {
  const { params } = buildMessageParams(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    {},
    { model: "m" },
  )
  assert.deepEqual(params.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }])
})

test("anthropic: 请求参数", () => {
  const { params } = buildMessageParams([{ role: "user", content: "hi" }], { tools, tool_choice: "none", max_output_tokens: 123 }, { model: "claude-test", extra_body: { temperature: 0.2 } })
  assert.equal(params.model, "claude-test")
  assert.equal(params.max_tokens, 123)
  assert.equal(params.temperature, 0.2)
  assert.equal(params.tools[0].input_schema.type, "object")
  assert.deepEqual(params.tool_choice, { type: "none" })
})

test("anthropic: 响应解析", () => {
  const r = parseMessage({
    content: [
      { type: "thinking", thinking: "think", signature: "sig" },
      { type: "text", text: "ok" },
      { type: "tool_use", id: "c1", name: "f", input: { a: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  })
  assert.equal(r.content, "ok")
  assert.equal(r.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(r.reasoning_content, "think")
  assert.deepEqual(r.reasoning_parts, [{ text: "think", signature: "sig" }])
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 })
  assert.equal(r.finishReason, "tool_use")
})

test("anthropic: 思考 token 映射", () => {
  const r = parseMessage({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 7 } },
  })
  assert.equal(r.usage.reasoning_tokens, 7)
})

test("anthropic: extra_body 不能开启 stream", () => {
  const { params } = buildMessageParams([{ role: "user", content: "hi" }], {}, { model: "m", extra_body: { stream: true } })
  assert.equal(params.stream, false)
})

test("anthropic: 文件路径提示也可作为缓存断点", () => {
  const out = convertMessages([{ role: "user", content: "", file_paths: ["/tmp/a.pdf"], cache_break: true }])
  assert.match(out.messages[0].content.at(-1).text, /\/tmp\/a\.pdf/)
  assert.deepEqual(out.messages[0].content.at(-1).cache_control, { type: "ephemeral" })
})

test("anthropic: 开启音视频但适配器不支持时明确报错", () => {
  assert.throws(() => convertMessages([{ role: "user", content: "x", audios: ["data:audio/wav;base64,AAA"] }]), /不支持音频输入/)
  assert.throws(() => convertMessages([{ role: "user", content: "x", videos: ["data:video/mp4;base64,AAA"] }]), /不支持视频输入/)
})

test("anthropic: 任意图片 mime 按实际类型发送", () => {
  const out = convertMessages([{ role: "user", content: "x", images: ["data:image/heic;base64,AAA"] }])
  assert.ok(out.messages[0].content.some(b => b.type === "image" && b.source.media_type === "image/heic"))
})

test("anthropic: 动图帧数组带同一张动图说明", () => {
  const frames = markAnimatedFrames(["data:image/webp;base64,AAA", "data:image/webp;base64,BBB"])
  const out = convertMessages([{ role: "user", content: "x", images: [frames] }])
  const blocks = out.messages[0].content
  assert.ok(blocks.some(b => b.type === "text" && b.text.includes("不是 2 张独立图片")))
  assert.equal(blocks.filter(b => b.type === "image").length, 2)
})

test("anthropic: GIF 转成的视频占位为 [视频]", () => {
  const out = convertMessages([{ role: "user", content: "x", images: ["data:video/mp4;base64,AAA"] }])
  assert.equal(
    out.messages[0].content.some(b => b.type === "text" && b.text === "[视频]"),
    true,
  )
})
