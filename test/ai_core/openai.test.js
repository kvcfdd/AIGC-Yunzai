import test from "node:test"
import assert from "node:assert/strict"
import { buildChatParams, convertMessages, parseChatCompletion } from "../../lib/ai_core/llm/openai/adapter.js"
import { markAnimatedFrames } from "../../lib/ai_core/media/animated.js"
import { STATUS_BAR } from "../../lib/ai_core/llm/message-builders.js"

globalThis.logger = { info() {}, mark() {}, warn() {}, error() {}, debug() {} }

test("openai: 消息转换（文本/图片/工具媒体）", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi", time: Date.now(), chat_type: "私聊", images: ["data:image/png;base64,abc"] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", images: ["data:image/png;base64,xyz"] },
  ]
  const out = convertMessages(messages)

  assert.equal(out[0].role, "system")
  assert.equal(out[1].role, "user")
  assert.equal(
    out[1].content.some(p => p.type === "image_url"),
    true,
  )
  assert.equal(out[2].role, "assistant")
  assert.equal(out[2].tool_calls[0].function.name, "f")
  assert.equal(out[3].role, "tool")
  assert.equal(out[3].tool_call_id, "c1")
  assert.equal(out[4].role, "user")
  assert.equal(out[4].content[0].text.includes("工具 f"), true)
  assert.equal(
    out[4].content.some(p => p.type === "image_url"),
    true,
  )
})

test("openai: runtime_context 作为 user 最后一段文本", () => {
  const out = convertMessages([{ role: "user", content: "hi", runtime_context: "<Real_time_status>x</Real_time_status>" }])
  assert.deepEqual(out[0].content.at(-1), { type: "text", text: "<Real_time_status>x</Real_time_status>" })
})

test("openai: 连续 user 消息合并", () => {
  const out = convertMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "ok" },
  ])
  assert.equal(out.filter(m => m.role === "user").length, 1)
  assert.equal(out[0].content.filter(p => p.type === "text").length, 2)
})

test("openai: 工具结果里的 status_bar 是独立文本 part，user 插话在其后", () => {
  const out = convertMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", [STATUS_BAR]: "<status_bar>\n剩余次数: 2\n</status_bar>" },
    { role: "user", content: "插话" },
  ])

  const tool = out.find(m => m.role === "tool")
  assert.deepEqual(tool.content, [
    { type: "text", text: "ok" },
    { type: "text", text: "<status_bar>\n剩余次数: 2\n</status_bar>" },
  ])
  const user = out.find(m => m.role === "user")
  assert.equal(user.content[0].text, "插话")

  const plain = convertMessages([{ role: "tool", content: "ok", tool_call_id: "c1" }])
  assert.deepEqual(plain[0].content, [{ type: "text", text: "ok" }], "工具结果统一为部件数组")
  const barOnly = convertMessages([{ role: "tool", content: "", tool_call_id: "c1", [STATUS_BAR]: "<status_bar>剩余</status_bar>" }])
  assert.deepEqual(barOnly[0].content, [{ type: "text", text: "<status_bar>剩余</status_bar>" }], "只有状态栏时也是独立 part")
})

test("openai: 工具文件路径并入工具消息数组，不额外拉 user", () => {
  const out = convertMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "media", arguments: "{}" } }] },
    { role: "tool", content: "", tool_call_id: "c1", name: "media", file_paths: ["/tmp/a.pdf"], [STATUS_BAR]: "<status_bar>剩余</status_bar>" },
  ])
  const tool = out.find(m => m.role === "tool")
  assert.deepEqual(tool.content, [
    { type: "text", text: "[文件已缓存](/tmp/a.pdf)" },
    { type: "text", text: "<status_bar>剩余</status_bar>" },
  ])
  assert.equal(out.filter(m => m.role === "user").length, 0, "文件路径不再单独拉 user 消息")
})

test("openai: 音频/文件路径/视频内容块", () => {
  const out = convertMessages([
    {
      role: "user",
      content: "media",
      audios: ["data:audio/wav;base64,AAA"],
      files: ["data:application/pdf;base64,BBB"],
      file_paths: ["/tmp/a.pdf"],
      videos: ["data:video/mp4;base64,CCC"],
    },
  ])
  const parts = out[0].content
  assert.equal(
    parts.some(p => p.type === "input_audio" && p.input_audio.format === "wav"),
    true,
  )
  assert.equal(
    parts.some(p => p.type === "file"),
    false,
  )
  assert.ok(parts.some(p => p.type === "text" && p.text.includes("/tmp/a.pdf")))
  assert.equal(
    parts.some(p => p.type === "video_url" && p.video_url.url === "data:video/mp4;base64,CCC"),
    true,
  )
})

test("openai: 非视频 data URI 的视频项仍用文本占位", () => {
  const out = convertMessages([{ role: "user", content: "x", videos: ["[视频异常]"] }])
  assert.equal(
    out[0].content.some(p => p.type === "text" && p.text === "[视频]"),
    true,
  )
})

test("openai: 图片解析失败占位 + content 数组归一化", () => {
  const out = convertMessages([{ role: "user", content: "x", images: ["[图像异常]"] }])
  assert.equal(
    out[0].content.some(p => p.type === "text" && p.text === "[图片]"),
    true,
  )
  const r = parseChatCompletion({
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      },
    ],
  })
  assert.equal(r.content, "ab")
})

test("openai: extra_body 不能开启 stream", () => {
  const { params } = buildChatParams([{ role: "user", content: "x" }], {}, { model: "m", extra_body: { stream: true } })
  assert.equal(params.stream, false)
})

test("openai: 请求参数与 max_tokens_field", () => {
  const tools = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }]
  const { params } = buildChatParams([{ role: "user", content: "hi" }], { tools, tool_choice: "none", max_output_tokens: 123 }, { model: "gpt-test", max_tokens_field: "max_completion_tokens", extra_body: { temperature: 0.2 } })
  assert.equal(params.model, "gpt-test")
  assert.equal(params.max_completion_tokens, 123)
  assert.equal("max_tokens" in params, false)
  assert.equal(params.temperature, 0.2)
  assert.equal(params.tools[0].type, "function")
  assert.equal(params.tool_choice, "none")
})

test("openai: 默认 max_tokens 字段", () => {
  const { params } = buildChatParams([{ role: "user", content: "hi" }], { max_output_tokens: 64 }, { model: "gpt-test" })
  assert.equal(params.max_tokens, 64)
  assert.equal("max_completion_tokens" in params, false)
})

test("openai: 响应解析", () => {
  const r = parseChatCompletion({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          reasoning_content: "think",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  assert.equal(r.content, "")
  assert.equal(r.tool_calls[0].function.name, "f")
  assert.equal(r.reasoning_content, "think")
  assert.equal(r.blocked, false)
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 })
})

test("openai: 兼容 DeepSeek 缓存命中字段", () => {
  const r = parseChatCompletion({
    choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 768, prompt_cache_miss_tokens: 232 },
  })
  assert.equal(r.usage.cached_tokens, 768)

  const r2 = parseChatCompletion({
    choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cached_tokens: 512 },
  })
  assert.equal(r2.usage.cached_tokens, 512)
})

test("openai: content_filter 视为拦截", () => {
  const r = parseChatCompletion({ choices: [{ finish_reason: "content_filter", message: { content: null } }] })
  assert.equal(r.blocked, true)
})

test("openai: 动画 GIF 转成的视频占位为 [视频]", () => {
  const out = convertMessages([{ role: "user", content: "x", images: ["data:video/mp4;base64,AAA"] }])
  assert.equal(
    out[0].content.some(p => p.type === "text" && p.text === "[视频]"),
    true,
  )
  assert.equal(
    out[0].content.some(p => p.type === "text" && p.text === "[图片]"),
    false,
  )
})

test("openai: content 数组中的 refusal part 不丢失", () => {
  const r = parseChatCompletion({
    choices: [{ finish_reason: "stop", message: { content: [{ type: "refusal", refusal: "拒绝" }] } }],
  })
  assert.equal(r.content, "拒绝")
})

test("openai: 无 choices 视为失败并保留 usage", () => {
  const r = parseChatCompletion({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  assert.equal(r.failed, true)
  assert.equal(r.blocked, false)
  assert.equal(r.usage.total_tokens, 3)
})

test("openai: 不支持的音频格式直接报错", () => {
  assert.throws(() => convertMessages([{ role: "user", content: "x", audios: ["data:audio/ogg;base64,AAA"] }]), /不支持 audio\/ogg/)
})

test("openai: 动图帧数组带同一张动图说明", () => {
  const frames = markAnimatedFrames(["data:image/webp;base64,AAA", "data:image/webp;base64,BBB"])
  const out = convertMessages([{ role: "user", content: "x", images: [frames] }])
  const parts = out[0].content
  assert.ok(parts.some(p => p.type === "text" && p.text.includes("不是 2 张独立图片")))
  assert.equal(parts.filter(p => p.type === "image_url").length, 2)
})

test("openai: 默认回传 reasoning_content（DeepSeek V4 工具调用要求）", () => {
  const messages = [
    { role: "user", content: "查一下" },
    { role: "assistant", content: null, reasoning_content: "think", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f" },
    { role: "assistant", content: "done", reasoning_content: "enough" },
  ]
  const { params } = buildChatParams(messages, {}, { model: "deepseek-v4-pro" })
  assert.equal(params.messages[1].reasoning_content, "think")
  assert.equal(params.messages[3].reasoning_content, "enough")
})

test("openai: reasoning_replay=false 时不回传 reasoning_content", () => {
  const messages = [{ role: "assistant", content: "x", reasoning_content: "think" }]
  const { params } = buildChatParams(messages, {}, { model: "gpt-test", reasoning_replay: false })
  assert.equal("reasoning_content" in params.messages[0], false)
  assert.equal("reasoning_content" in convertMessages(messages, { replayReasoning: false })[0], false)
  assert.equal(convertMessages(messages)[0].reasoning_content, "think")
})

test("openai: 非 data URI 文件项不产生部件", () => {
  const out = convertMessages([{ role: "user", content: "[文件: a.pdf]", files: ["[文件异常]"] }])
  assert.equal(
    out[0].content.some(p => p.type === "text" && p.text === "[文件]"),
    false,
  )
})
