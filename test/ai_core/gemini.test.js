import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { buildInteractionParams, unwrapInteraction, GeminiAdapter } from "../../lib/ai_core/llm/gemini/adapter.js"
import { describeApiError } from "../../lib/ai_core/llm/gemini/http.js"
import { convertToInteractions, parseInteractionSteps } from "../../lib/ai_core/llm/gemini/interactions.js"
import { collectApiKeys } from "../../lib/ai_core/llm/api-keys.js"
import { markAnimatedFrames } from "../../lib/ai_core/media/animated.js"
import { CURRENT_TURN, STATUS_BAR } from "../../lib/ai_core/llm/message-builders.js"

const toolDefs = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }]

// 适配器 chat() 会写全局 logger；单测里用空实现
globalThis.logger = { info() {}, mark() {}, warn() {}, error() {}, debug() {} }

test("gemini: 请求参数映射", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi", time: Date.now(), chat_type: "私聊" },
    {
      role: "assistant",
      content: null,
      reasoning_parts: [{ text: "think", signature: "ts" }],
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' }, signature: "s1" }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "f", signature: "s2" },
  ]

  const { params, model, channel } = buildInteractionParams(messages, { tools: toolDefs, tool_choice: "none", max_output_tokens: 64, channel: "main" }, { model: "gemini-test", thinking_level: "low" }, { max_output_tokens: 128, show_thinking: true })

  assert.equal(model, "gemini-test")
  assert.equal(channel, "main")
  assert.equal(params.model, "gemini-test")
  assert.equal(params.store, false)
  assert.equal(params.system_instruction, "sys")
  assert.equal(params.generation_config.max_output_tokens, 64)
  assert.equal(params.generation_config.thinking_level, "low")
  assert.equal(params.generation_config.thinking_summaries, "auto")
  assert.equal(params.generation_config.tool_choice, "none")
  assert.equal(params.tools[0].type, "function")
  assert.equal(params.tools[0].name, "f")
  assert.deepEqual(
    params.input.map(s => s.type),
    ["user_input", "thought", "function_call", "function_result"],
  )
})

test("gemini: 当前轮 user 不加时间前缀，历史轮加", () => {
  const time = new Date(2024, 0, 2, 3, 4, 5).getTime()
  const { input } = convertToInteractions(
    [
      { role: "user", content: "history", time, chat_type: "私聊" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "current", time, chat_type: "私聊", [CURRENT_TURN]: true },
    ],
    null,
  )
  const userInputs = input.filter(step => step.type === "user_input")
  assert.equal(userInputs[0].content[0].text, "[2024-01-02 03:04:05 私聊] history")
  assert.equal(userInputs[1].content[0].text, "current")
})

test("gemini: 工具结果里的 status_bar 是独立 part，user 插话在其后", () => {
  const { input } = convertToInteractions(
    [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "c1", name: "f", [STATUS_BAR]: "<status_bar>\n剩余次数: 2\n</status_bar>" },
      { role: "user", content: "插话" },
    ],
    null,
  )

  const result = input.find(step => step.type === "function_result")
  assert.deepEqual(
    result.result.map(part => part.text),
    ["ok", "<status_bar>\n剩余次数: 2\n</status_bar>"],
  )
  const user = input.find(step => step.type === "user_input")
  assert.equal(user.content[0].text, "插话")
})

test("gemini: runtime_context 作为 user_input 最后一段", () => {
  const { params } = buildInteractionParams([{ role: "user", content: "hi", runtime_context: "<Real_time_status>x</Real_time_status>" }], {}, { model: "gemini-test" }, {})
  const user = params.input.find(item => item.type === "user_input")
  assert.deepEqual(user.content.at(-1), { type: "text", text: "<Real_time_status>x</Real_time_status>" })
})

test("gemini: 旁听不返回思考摘要", () => {
  const { params } = buildInteractionParams([{ role: "user", content: "hi" }], { channel: "ambient" }, { model: "gemini-test" }, { show_thinking: true })
  assert.equal(params.generation_config.thinking_summaries, "none")
})

test("gemini: 响应 steps 解析", () => {
  const result = parseInteractionSteps(
    [
      { type: "thought", summary: [{ type: "text", text: "think" }], signature: "ts2" },
      { type: "function_call", id: "c2", name: "echo", arguments: { x: 2 }, signature: "sig2" },
      { type: "model_output", content: [{ type: "text", text: "ok" }] },
    ],
    { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 },
  )

  assert.equal(result.content, "ok")
  assert.equal(result.tool_calls[0].function.name, "echo")
  assert.equal(result.tool_calls[0].signature, "sig2")
  assert.equal(result.reasoning_content, "think")
  assert.deepEqual(result.reasoning_parts, [{ text: "think", signature: "ts2" }])
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 })
})

test("gemini: 连续 user 消息保留为两个 user_input", () => {
  const { params } = buildInteractionParams(
    [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ],
    {},
    { model: "gemini-test" },
  )
  assert.equal(params.input.filter(s => s.type === "user_input").length, 2)
})

test("gemini: api_keys 支持数组或逗号字符串", () => {
  assert.deepEqual(collectApiKeys({ api_keys: ["a", " b "] }, {}), ["a", "b"])
  assert.deepEqual(collectApiKeys({ api_keys: "a, b" }, {}), ["a", "b"])
  assert.deepEqual(collectApiKeys({}, {}), [])
})

test("gemini: 数组包裹的错误响应体保留真实原因", () => {
  const err = new Error('429 API error occurred: {"httpMeta":{"response":{},"request":{}}}')
  err.status = 429
  err.body = '[{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED","details":[{"metadata":{"quota_limit_value":"0","quota_location":"asia-east1"}}]}}]'
  assert.equal(describeApiError(err), err)
  assert.match(err.message, /Quota exceeded for metric/)
  assert.match(err.message, /RESOURCE_EXHAUSTED/)
  assert.match(err.message, /limit=0/)
  assert.match(err.message, /region=asia-east1/)
  assert.equal(err.status, 429)
})

test("gemini: 对象包裹的错误体补配额元数据且不重复原因", () => {
  const err = new Error("429 Quota exceeded for metric: x")
  err.status = 429
  err.body = '{"error":{"code":429,"message":"Quota exceeded for metric: x","status":"RESOURCE_EXHAUSTED","details":[{"metadata":{"quota_limit_value":"0","quota_location":"us-south1"}}]}}'
  describeApiError(err)
  assert.equal(err.message, "429 Quota exceeded for metric: x (RESOURCE_EXHAUSTED, limit=0, region=us-south1)")
})

test("gemini: 数组包裹的成功响应取出 interaction 对象", () => {
  const interaction = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }] }
  assert.equal(unwrapInteraction(interaction), interaction)
  assert.equal(unwrapInteraction([{ foo: 1 }, interaction]), interaction)
  assert.deepEqual(unwrapInteraction([]), {})
})

test("gemini: 裸 fetch 成功响应解析", async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify([{ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hello" }] }], usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 } }]))
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const modelConfig = { name: "test", base_url: `http://127.0.0.1:${server.address().port}`, api_keys: ["k"], model: "gemini-test", retry_count: 0, timeout_ms: 5000 }
  const result = await new GeminiAdapter().chat([{ role: "user", content: "hi" }], { modelConfig })
  assert.equal(result.content, "hello")
  assert.deepEqual(result.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0, reasoning_tokens: 0 })
})

test("gemini: 缺少 model 时明确报错", () => {
  assert.throws(() => buildInteractionParams([{ role: "user", content: "hi" }], {}, {}), /缺少 model/)
})

test("gemini: 同一响应缺失 id 的多个调用生成唯一 id", () => {
  const result = parseInteractionSteps([
    { type: "function_call", name: "a", arguments: {} },
    { type: "function_call", name: "b", arguments: {} },
  ])
  assert.notEqual(result.tool_calls[0].id, result.tool_calls[1].id)
  assert.ok(result.tool_calls.every(tc => tc.id))
})

test("gemini: 媒体超上限时给出省略提示", () => {
  const { input } = convertToInteractions([{ role: "user", content: "", images: Array(21).fill("data:image/png;base64,AAA"), videos: ["data:video/mp4;base64,AAA", "data:video/mp4;base64,BBB", "data:video/mp4;base64,CCC"] }])
  const texts = input[0].content.filter(c => c.type === "text").map(c => c.text)
  assert.ok(texts.some(t => t.includes("另有 1 张超出单条消息上限")))
  assert.ok(texts.includes("[视频过多，其余已省略]"))
})

test("gemini: 动图帧数组按同一张动图提示", () => {
  const frames = markAnimatedFrames(["data:image/webp;base64,AAA", "data:image/webp;base64,BBB"])
  const { input } = convertToInteractions([{ role: "user", content: "x", images: [frames] }])
  const texts = input[0].content.filter(c => c.type === "text").map(c => c.text)
  assert.ok(texts.some(t => t.includes("不是 2 张独立图片")))
  assert.deepEqual(
    texts.filter(t => t.startsWith("[动图 第")),
    ["[动图 第 1/2 帧]", "[动图 第 2/2 帧]"],
  )
  assert.equal(input[0].content.filter(c => c.type === "image").length, 2)
})

test("gemini: 畸形 data URI 降级为占位符", () => {
  const { input } = convertToInteractions([{ role: "user", content: "", images: ["data:image/png,not-base64"] }])
  assert.ok(input[0].content.some(c => c.type === "text" && c.text === "[图像异常]"))
})

test("gemini: 失败响应保留 usage", async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "failed", errors: [{ message: "boom" }], usage: { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 } }))
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const modelConfig = { name: "test", base_url: `http://127.0.0.1:${server.address().port}`, api_keys: ["k"], model: "gemini-test", retry_count: 0, timeout_ms: 5000 }
  const result = await new GeminiAdapter().chat([{ role: "user", content: "hi" }], { modelConfig })
  assert.equal(result.failed, true)
  assert.equal(result.blocked, false)
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 0, reasoning_tokens: 0 })
})

test("gemini: 无法识别的 2xx 结构不算安全拦截", async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify([]))
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const modelConfig = { name: "test", base_url: `http://127.0.0.1:${server.address().port}`, api_keys: ["k"], model: "gemini-test", retry_count: 0, timeout_ms: 5000 }
  const result = await new GeminiAdapter().chat([{ role: "user", content: "hi" }], { modelConfig })
  assert.equal(result.failed, true)
  assert.equal(result.blocked, false)
})

test("gemini: 裸 fetch 429 保留状态码和配额原因", async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json" })
    res.end(JSON.stringify([{ error: { code: 429, message: "Quota exceeded for testing", status: "RESOURCE_EXHAUSTED", details: [{ metadata: { quota_limit_value: "0", quota_location: "us-south1" } }] } }]))
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const modelConfig = { name: "test", base_url: `http://127.0.0.1:${server.address().port}`, api_keys: ["k"], model: "gemini-test", retry_count: 0, timeout_ms: 5000 }
  await assert.rejects(new GeminiAdapter().chat([{ role: "user", content: "hi" }], { modelConfig }), err => {
    assert.equal(err.status, 429)
    assert.match(err.message, /Quota exceeded for testing/)
    assert.match(err.message, /limit=0/)
    assert.match(err.message, /region=us-south1/)
    return true
  })
})
