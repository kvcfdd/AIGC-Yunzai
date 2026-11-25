import test from "node:test"
import assert from "node:assert/strict"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} } }

const { SystemPromptBuilder } = await import("../../lib/ai_core/perception/system-prompt.js")

const event = { isGroup: false, isMaster: true, self_id: "s", user_id: "u", sender: { nickname: "n" } }
const config = { aigc: { system_prompt: "persona" } }

test("system prompt: persona 与 system_policies 结构", async () => {
  const builder = new SystemPromptBuilder({ event, skills: { list: async () => [] }, tools: { catalog: () => [] }, config })
  const prompt = await builder.buildSystemPrompt()
  assert.match(prompt, /<persona>\npersona\n<\/persona>/)
  assert.match(prompt, /<system_policies>/)
  assert.ok(prompt.indexOf("<system_policies>") > prompt.indexOf("<persona>"))
})

test("system prompt: system_policies 不出现在运行时上下文", async () => {
  const builder = new SystemPromptBuilder({ event, skills: { list: async () => [] }, tools: { catalog: () => [] }, config })
  const runtime = await builder.buildRuntimeContext(false, {})
  assert.match(runtime, /<Real_time_status>/)
  assert.equal(runtime.includes("system_policies"), false)
})

test("system prompt: 工具目录不再按总长度截断", async () => {
  const catalog = Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(240) }))
  const builder = new SystemPromptBuilder({ event, skills: { list: async () => [] }, tools: { catalog: () => catalog }, config })
  const prompt = await builder.buildSystemPrompt()
  assert.ok(prompt.length > 16_000)
  assert.match(prompt, /<tool name="tool_99">/)
})

test("system prompt: 工具描述 250 字内保留，超出截断到 240 并标注省略数", async () => {
  const catalog = [
    { name: "keep", description: "x".repeat(250) },
    { name: "cut", description: "y".repeat(251) },
  ]
  const builder = new SystemPromptBuilder({ event, skills: { list: async () => [] }, tools: { catalog: () => catalog }, config })
  const prompt = await builder.buildSystemPrompt()
  assert.ok(prompt.includes(`<tool name="keep">${"x".repeat(250)}</tool>`))
  assert.ok(prompt.includes(`<tool name="cut">${"y".repeat(240)}(已省略11字符)</tool>`))
})

test("system prompt: 插件目录替代插件工具与技能", async () => {
  const builder = new SystemPromptBuilder({
    event,
    skills: {
      list: async () => [
        { name: "builtin-skill", description: "内置技能", source: "builtin" },
        { name: "plugin-skill", description: "插件技能", source: "plugin:demo" },
      ],
    },
    tools: {
      catalog: () => [
        { name: "builtin_tool", description: "内置工具", source: "builtin", permission: "all" },
        { name: "demo_tool", description: "插件工具", source: "plugin:demo", permission: "all" },
      ],
    },
    pluginAssets: { get: name => (name === "demo" ? { name: "demo", description: "演示插件：回显与点歌" } : null) },
    config,
  })
  const prompt = await builder.buildSystemPrompt()

  assert.match(prompt, /<plugins>[\s\S]*<plugin name="demo">演示插件：回显与点歌<\/plugin>[\s\S]*<\/plugins>/)
  assert.match(prompt, /<skill name="builtin-skill">内置技能<\/skill>/)
  assert.match(prompt, /<tool name="builtin_tool">内置工具<\/tool>/)
  assert.match(prompt, /plugin_view/)
  assert.doesNotMatch(prompt, /plugin-skill/)
  assert.doesNotMatch(prompt, /demo_tool/)
  assert.ok(prompt.indexOf("<plugins>") < prompt.indexOf("<available_tools>"))
})

test("system prompt: 非 bot_owner 权限提示不含插件工具", async () => {
  const builder = new SystemPromptBuilder({
    event: { ...event, isMaster: false },
    skills: { list: async () => [] },
    tools: {
      catalog: () => [
        { name: "pwsh", description: "", source: "builtin", permission: "master" },
        { name: "demo_tool", description: "", source: "plugin:demo", permission: "master" },
      ],
    },
    config,
  })
  const runtime = await builder.buildRuntimeContext(false, {})

  assert.match(runtime, /pwsh/)
  assert.doesNotMatch(runtime, /demo_tool/)
})

test("system prompt: 有工具时包含 capability_protocol", async () => {
  const builder = new SystemPromptBuilder({
    event,
    skills: { list: async () => [] },
    tools: { catalog: () => [{ name: "web_search", description: "Search the web." }] },
    config,
  })
  const prompt = await builder.buildSystemPrompt()
  assert.match(prompt, /<capability_protocol>/)
  assert.match(prompt, /<tool name="web_search">Search the web\.<\/tool>/)
})
