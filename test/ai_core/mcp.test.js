import test from "node:test"
import assert from "node:assert/strict"
import { buildHeaders, buildVersionNegotiation, createTransport, normalizeTransport } from "../../lib/ai_core/tools/mcp/transport.js"
import { extractToolResult, normalizeCallToolResult } from "../../lib/ai_core/tools/mcp/result.js"
import { McpManager, sanitizeName } from "../../lib/ai_core/tools/mcp/manager.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

test("mcp: 传输类型推断", () => {
  assert.equal(normalizeTransport({ type: "http", url: "http://x" }), "http")
  assert.equal(normalizeTransport({ type: "sse", url: "http://x" }), "sse")
  assert.equal(normalizeTransport({ command: "node" }), "stdio")
  assert.equal(normalizeTransport({ url: "http://x" }), "http")
  assert.equal(normalizeTransport({}), null)
  // 旧键不再兼容
  assert.equal(normalizeTransport({ transport: "sse", url: "http://x" }), "http")
})

test("mcp: headers 与 bearer_token 合并", () => {
  assert.deepEqual(buildHeaders({ bearer_token: "k" }), { Authorization: "Bearer k" })
  assert.deepEqual(buildHeaders({ bearer_token: "k", headers: { "X-A": "1" } }), { "X-A": "1", Authorization: "Bearer k" })
  assert.deepEqual(buildHeaders({ bearer_token: "k", headers: { Authorization: "Custom" } }), { Authorization: "Custom" })
  // 旧键不再兼容
  assert.deepEqual(buildHeaders({ api_key: "k" }), {})
})

test("mcp: 协议协商", () => {
  assert.deepEqual(buildVersionNegotiation({ protocol_mode: "auto" }), { mode: "auto" })
  assert.deepEqual(buildVersionNegotiation({ protocol_version: "2026-07-28" }), { mode: { pin: "2026-07-28" } })
  assert.equal(buildVersionNegotiation({}), undefined)
  // 旧键不再兼容
  assert.equal(buildVersionNegotiation({ version_negotiation: "auto" }), undefined)
})

test("mcp: 创建 HTTP/SSE transport", () => {
  assert.equal(createTransport({ type: "http", url: "http://localhost:3000/mcp" }).type, "http")
  assert.equal(createTransport({ type: "sse", url: "http://localhost:3000/sse" }).type, "sse")
  assert.throws(() => createTransport({ type: "http" }), /缺少 url/)
  assert.throws(() => createTransport({}), /缺少 type/)
})

test("mcp: 工具名清理", () => {
  assert.equal(sanitizeName("mcp_foo bar!"), "mcp_foo_bar")
  assert.equal(sanitizeName(""), "x")
  assert.equal(sanitizeName("a".repeat(100)).length <= 64, true)
})

test("mcp: 工具注册", () => {
  const registered = []
  const manager = new McpManager({
    getServers: () => [],
    registry: { register: tool => registered.push({ tool }), unregister() {} },
  })
  manager._applyTools({ callTool: async () => ({ content: [] }) }, "srv", [{ name: "search", description: "d", inputSchema: { type: "object" } }], 1000)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].tool.name, "mcp_search")
})

test("mcp: CallToolResult 提取", () => {
  assert.equal(extractToolResult({ content: [{ type: "text", text: "hi" }] }), "hi")
  assert.equal(extractToolResult({ content: [{ type: "image", mimeType: "image/png" }] }), "[image image/png]")
  assert.equal(extractToolResult({ content: [{ type: "resource", resource: { text: "x" } }] }), "x")
  assert.equal(extractToolResult({ structuredContent: { a: 1 } }), '{"a":1}')
  assert.throws(() => normalizeCallToolResult({ isError: true, content: [{ type: "text", text: "bad" }] }), /bad/)
  assert.equal(normalizeCallToolResult({ content: [{ type: "text", text: "ok" }] }), "ok")
})

test("mcp: 图片/音频内容转为多模态数据", () => {
  const r = normalizeCallToolResult({
    content: [
      { type: "text", text: "shot" },
      { type: "image", mimeType: "image/png", data: "eA==" },
      { type: "audio", mimeType: "audio/mpeg", data: "eQ==" },
    ],
  })
  assert.deepEqual(r, {
    text: "shot\n[image image/png]\n[audio audio/mpeg]",
    images: ["data:image/png;base64,eA=="],
    audios: ["data:audio/mpeg;base64,eQ=="],
  })
  // 缺少数据或类型不匹配时仍按纯文本处理
  assert.equal(normalizeCallToolResult({ content: [{ type: "image", mimeType: "image/png" }] }), "[image image/png]")
  assert.equal(normalizeCallToolResult({ content: [{ type: "image", mimeType: "text/plain", data: "eA==" }] }), "[image text/plain]")
})
