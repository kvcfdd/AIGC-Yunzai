import test from "node:test"
import assert from "node:assert/strict"
import { buildResponseParams, convertMessages, parseResponse } from "../../lib/ai_core/llm/responses/adapter.js"
import { markAnimatedFrames } from "../../lib/ai_core/media/animated.js"
import { STATUS_BAR } from "../../lib/ai_core/llm/message-builders.js"

const tools = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }]

test("responses: 消息转换", () => {
  const out = convertMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi", time: Date.now(), chat_type: "私聊", images: ["data:image/png;base64,abc"], file_paths: ["/tmp/a.pdf"] },
    { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f" },
  ])

  assert.equal(out.instructions, "sys")
  assert.equal(out.input[0].role, "user")
  assert.equal(
    out.input[0].content.some(p => p.type === "input_image"),
    true,
  )
  assert.equal(
    out.input[0].content.some(p => p.type === "input_file"),
    false,
  )
  assert.ok(out.input[0].content.some(p => p.type === "input_text" && p.text.includes("/tmp/a.pdf")))
  assert.equal(out.input[1].role, "assistant")
  assert.equal(out.input[2].type, "function_call")
  assert.equal(out.input[2].call_id, "c1")
  assert.equal(out.input[3].type, "function_call_output")
  assert.equal(out.input[3].output, "ok")
})

test("responses: runtime_context 作为 user 最后一段", () => {
  const out = convertMessages([{ role: "user", content: "hi", runtime_context: "<Real_time_status>x</Real_time_status>" }])
  assert.deepEqual(out.input[0].content.at(-1), { type: "input_text", text: "<Real_time_status>x</Real_time_status>" })
})

test("responses: 连续 user 消息合并", () => {
  const out = convertMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ])
  assert.equal(out.input.length, 1)
  assert.equal(out.input[0].content.filter(p => p.type === "input_text").length, 2)
})

test("responses: 回传原始 output items", () => {
  const items = [
    { type: "message", id: "msg1", role: "assistant", content: [{ type: "output_text", text: "calling" }], status: "completed" },
    { type: "function_call", id: "fc1", call_id: "call1", name: "f", arguments: '{"a":1}' },
    { type: "reasoning", id: "rs1", encrypted_content: "enc", summary: [] },
    { type: "web_search_call", id: "ws1" },
  ]
  const out = convertMessages([{ role: "assistant", content: "calling", response_items: items }])
  assert.deepEqual(
    out.input,
    items.filter(i => i.type !== "web_search_call"),
  )
})

test("responses: 工具结果里的 status_bar 是独立 part，user 插话在其后", () => {
  const { input } = convertMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", [STATUS_BAR]: "<status_bar>\n剩余次数: 2\n</status_bar>" },
    { role: "user", content: "插话" },
  ])

  const output = input.find(item => item.type === "function_call_output")
  assert.ok(Array.isArray(output.output))
  assert.deepEqual(
    output.output.map(part => part.text),
    ["ok", "<status_bar>\n剩余次数: 2\n</status_bar>"],
  )
  const user = input.find(item => item.role === "user")
  assert.equal(user.content[0].text, "插话")
})

test("responses: 工具结果媒体直接放入 function_call_output", () => {
  const out = convertMessages([{ role: "tool", content: "ok", tool_call_id: "c1", name: "f", images: ["data:image/png;base64,abc"] }])
  const item = out.input.find(x => x.type === "function_call_output")
  assert.equal(Array.isArray(item.output), true)
  assert.equal(
    item.output.some(p => p.type === "input_image"),
    true,
  )
})

test("responses: 空工具结果与截断函数调用", () => {
  const out = convertMessages([{ role: "tool", content: "", tool_call_id: "c1" }])
  assert.equal(out.input[0].output, "")

  const r = parseResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", id: "fc1", call_id: "c1", name: "f", arguments: "{", status: "incomplete" }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
  assert.equal(r.tool_calls, undefined)
  assert.equal(r.failed, true)
  assert.equal(r.blocked, false)
  assert.equal(r.response_items, undefined, "未完成的 function_call 不能进入回放")
})

test("responses: 回放前清洗引用前缀", () => {
  const out = convertMessages([
    {
      role: "assistant",
      content: "hi",
      response_items: [{ type: "message", content: [{ type: "output_text", text: "[引用1] hi" }], status: "completed" }],
    },
  ])
  assert.equal(out.input[0].content[0].text, "hi")
})

test("responses: extra_body.include 必须是数组", () => {
  assert.throws(() => buildResponseParams([{ role: "user", content: "x" }], {}, { model: "m", extra_body: { include: "reasoning.encrypted_content" } }), /include 必须是数组/)
})

test("responses: failed 与 content_filter 区分", () => {
  const failed = parseResponse({ status: "failed", error: { message: "boom" }, output: [] })
  assert.equal(failed.failed, true)
  assert.equal(failed.blocked, false)

  const blocked = parseResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] })
  assert.equal(blocked.blocked, true)
})

test("responses: extra_body 不能开启 stream/background", () => {
  const { params } = buildResponseParams([{ role: "user", content: "x" }], {}, { model: "m", extra_body: { stream: true, background: true } })
  assert.equal(params.stream, false)
  assert.equal(params.background, false)
})

test("responses: 音频映射为 input_audio 部件，视频仍明确报错", () => {
  const out = convertMessages([{ role: "user", content: "x", audios: ["data:audio/wav;base64,AAA", "data:audio/mpeg;base64,BBB"] }])
  assert.deepEqual(
    out.input[0].content.filter(p => p.type === "input_audio"),
    [
      { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
      { type: "input_audio", input_audio: { data: "BBB", format: "mp3" } },
    ],
  )
  const placeholder = convertMessages([{ role: "user", content: "x", audios: ["[音频异常]"] }])
  assert.ok(placeholder.input[0].content.some(p => p.type === "input_text" && p.text === "[音频]"))
  assert.throws(() => convertMessages([{ role: "user", content: "x", audios: ["data:audio/flac;base64,AAA"] }]), /不支持 audio\/flac/)
  assert.throws(() => convertMessages([{ role: "user", content: "x", videos: ["data:video/mp4;base64,AAA"] }]), /不支持视频输入/)
})

test("responses: 工具音频改由独立 user 消息携带", () => {
  const out = convertMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "media", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "media", audios: ["data:audio/wav;base64,AAA"], [STATUS_BAR]: "<status_bar>剩余</status_bar>" },
  ])
  const fnOut = out.input.find(item => item.type === "function_call_output")
  assert.deepEqual(fnOut.output, [
    { type: "input_text", text: "ok" },
    { type: "input_text", text: "<status_bar>剩余</status_bar>" },
  ])
  const user = out.input.find(item => item.role === "user")
  assert.deepEqual(user.content, [
    { type: "input_text", text: "[工具 media 返回的媒体]" },
    { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
  ])
})

test("responses: 动图帧数组带同一张动图说明", () => {
  const frames = markAnimatedFrames(["data:image/webp;base64,AAA", "data:image/webp;base64,BBB"])
  const out = convertMessages([{ role: "user", content: "x", images: [frames] }])
  const parts = out.input[0].content
  assert.ok(parts.some(p => p.type === "input_text" && p.text.includes("不是 2 张独立图片")))
  assert.equal(parts.filter(p => p.type === "input_image").length, 2)
})

test("responses: GIF 转视频占位", () => {
  const out = convertMessages([{ role: "user", content: "x", images: ["data:video/mp4;base64,AAA"] }])
  assert.equal(
    out.input[0].content.some(p => p.type === "input_text" && p.text === "[视频]"),
    true,
  )
})

test("responses: 请求参数", () => {
  const { params } = buildResponseParams([{ role: "user", content: "hi" }], { tools, tool_choice: "none", max_output_tokens: 123 }, { model: "gpt-test", extra_body: { reasoning: { effort: "medium" } } })
  assert.equal(params.model, "gpt-test")
  assert.equal(params.max_output_tokens, 123)
  assert.equal(params.store, false)
  assert.equal(params.tools[0].type, "function")
  assert.equal(params.tools[0].name, "f")
  assert.equal(params.tool_choice, "none")
  assert.equal(params.reasoning.effort, "medium")
  assert.deepEqual(params.include, ["reasoning.encrypted_content"])
})

test("responses: 响应解析", () => {
  const response = {
    id: "r1",
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
      { type: "message", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
  const r = parseResponse(response)
  // 只有可回放的 completed item 会被持久化；无 encrypted_content 的 reasoning 被剔除
  assert.deepEqual(r.response_items, [response.output[1], response.output[2]])
  assert.equal(r.content, "ok")
  assert.equal(r.tool_calls[0].function.name, "f")
  assert.equal(r.reasoning_content, "think")
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 })
  assert.equal(r.blocked, false)
})

test("responses: content_filter 视为拦截", () => {
  const r = parseResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] })
  assert.equal(r.blocked, true)
})
