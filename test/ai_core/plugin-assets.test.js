import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import toolRegistry, { ToolRegistry, isMasterOnlyTool } from "../../lib/ai_core/tools/tool-registry.js"
import { SkillStore, skillsListBlock } from "../../lib/ai_core/tools/skills/index.js"
import { PluginAssets } from "../../lib/ai_core/plugin-assets.js"
import { isUnderNonMasterReadDir } from "../../lib/ai_core/tools/workspace.js"
import "../../lib/ai_core/tools/builtin/PluginViewTool.js"

async function makePlugin() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-plugin-assets-"))
  const pluginDir = path.join(root, "demo")
  await fs.mkdir(path.join(pluginDir, "agent", "tools"), { recursive: true })
  await fs.mkdir(path.join(pluginDir, "agent", "skills", "music"), { recursive: true })
  await fs.writeFile(
    path.join(pluginDir, "agent", "tools", "echo.js"),
    `export default {
  name: "demo_echo",
  description: "Echo input.",
  permission: "master",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: ({ text }) => "echo:" + text,
}\n`,
  )
  await fs.writeFile(path.join(pluginDir, "agent", "skills", "music", "SKILL.md"), "---\nname: music\ndescription: 点歌技能\ntools: demo_echo\n---\n\n# music\n\n正文\n")
  await fs.writeFile(path.join(pluginDir, "agent", "plugin.yaml"), "description: 演示插件：回显与点歌\n")
  return { root, pluginDir }
}

test("plugin assets: 注册插件工具与技能，来源与权限正确", async () => {
  const { root, pluginDir } = await makePlugin()
  const registry = new ToolRegistry({ config: { aigc: { tool_loading: { native: ["demo_echo"] } } } })
  const skillStore = new SkillStore([])
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore, logger: null })
  try {
    await assets.load(["demo"])
    const tool = registry.tools.get("demo_echo")
    assert.equal(tool?.execute({ text: "hi" }), "echo:hi")
    assert.equal(tool?.source, "plugin:demo")
    assert.equal(registry.isNative("demo_echo"), false)
    assert.equal(
      registry.getDefinitions().some(d => d.function?.name === "demo_echo"),
      false,
    )
    assert.equal(isMasterOnlyTool(tool), true)
    assert.deepEqual(
      registry.catalog().find(i => i.name === "demo_echo"),
      { name: "demo_echo", description: "Echo input.", permission: "master", source: "plugin:demo" },
    )

    const list = await skillStore.list()
    assert.ok(list.some(i => i.name === "music" && i.source === "plugin:demo"))
    assert.match(skillsListBlock(list), /<skill name="music">点歌技能<\/skill>/)
    assert.equal(isUnderNonMasterReadDir(path.join(pluginDir, "agent", "skills", "music", "SKILL.md")), true)

    assert.deepEqual(await assets.list(), [{ name: "demo", description: "演示插件：回显与点歌" }])
    assert.deepEqual(assets.get("demo"), { name: "demo", description: "演示插件：回显与点歌" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin assets: 无 plugin.yaml 时跳过，不降级 package.json", async () => {
  const { root, pluginDir } = await makePlugin()
  await fs.rm(path.join(pluginDir, "agent", "plugin.yaml"))
  await fs.writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ description: "包描述" }))
  const registry = new ToolRegistry({ config: {} })
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore: new SkillStore([]), logger: null })
  try {
    await assets.load(["demo"])
    assert.deepEqual(assets.list(), [])
    assert.equal(registry.tools.has("demo_echo"), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin assets: 无工具的插件整体跳过", async () => {
  const { root, pluginDir } = await makePlugin()
  await fs.rm(path.join(pluginDir, "agent", "tools"), { recursive: true, force: true })
  const registry = new ToolRegistry({ config: {} })
  const skillStore = new SkillStore([])
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore, logger: null })
  try {
    await assets.load(["demo"])
    assert.deepEqual(assets.list(), [])
    assert.equal(assets.get("demo"), null)
    assert.equal(
      (await skillStore.list()).some(item => item.source === "plugin:demo"),
      false,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin view: 技能可选，没有技能时只返回工具", async () => {
  const { root, pluginDir } = await makePlugin()
  await fs.rm(path.join(pluginDir, "agent", "skills"), { recursive: true, force: true })
  const registry = new ToolRegistry({ config: {} })
  const skillStore = new SkillStore([])
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore, logger: null })
  try {
    await assets.load(["demo"])
    const view = await toolRegistry.execute("plugin_view", { plugin: "demo" }, { tools: registry, skills: skillStore, pluginAssets: assets, event: { isMaster: true } })
    assert.match(view.result, /<tools>[\s\S]*<tool name="demo_echo">Echo input\.<\/tool>[\s\S]*<\/tools>/)
    assert.doesNotMatch(view.result, /<skills>/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin view: 返回插件工具与技能，非 bot_owner 隐藏写工具", async () => {
  const { root } = await makePlugin()
  const registry = new ToolRegistry({ config: {} })
  const skillStore = new SkillStore([])
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore, logger: null })
  try {
    await assets.load(["demo"])
    const base = { tools: registry, skills: skillStore, pluginAssets: assets }

    const owner = await toolRegistry.execute("plugin_view", { plugin: "demo" }, { ...base, event: { isMaster: true } })
    assert.match(owner.result, /<plugin name="demo">/)
    assert.match(owner.result, /<description>演示插件：回显与点歌<\/description>/)
    assert.match(owner.result, /<tool name="demo_echo">Echo input\.<\/tool>/)
    assert.match(owner.result, /<skill name="music">点歌技能<\/skill>/)

    const guest = await toolRegistry.execute("plugin_view", { plugin: "demo" }, { ...base, event: { isMaster: false } })
    assert.doesNotMatch(guest.result, /demo_echo/)
    assert.match(guest.result, /<skill name="music">点歌技能<\/skill>/)

    const missing = await toolRegistry.execute("plugin_view", { plugin: "nope" }, { ...base, event: { isMaster: false } })
    assert.match(missing.error, /未找到插件/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin assets: 描述超过 tool_view 上限时拒绝", async () => {
  const { root, pluginDir } = await makePlugin()
  const registry = new ToolRegistry({ config: {} })
  const logs = []
  const logger = { debug() {}, info() {}, warn() {}, error: (...args) => logs.push(args) }
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore: new SkillStore([]), logger })
  try {
    await fs.writeFile(path.join(pluginDir, "agent", "tools", "echo.js"), `export default { name: "demo_echo", description: "${"x".repeat(601)}", parameters: { type: "object", properties: {} }, execute: () => "" }\n`)
    await assets.load(["demo"])
    assert.equal(registry.tools.has("demo_echo"), false)
    assert.ok(logs.some(args => String(args[0]).includes("description")))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("plugin assets: 与内置工具重名时拒绝注册", async () => {
  const { root } = await makePlugin()
  const registry = new ToolRegistry({ config: {} })
  const logs = []
  const logger = { debug() {}, info() {}, warn() {}, error: (...args) => logs.push(args) }
  const assets = new PluginAssets({ pluginsRoot: root, registry, skillStore: new SkillStore([]), logger })
  try {
    registry.register({ name: "demo_echo", description: "builtin", parameters: { type: "object", properties: {} }, execute: () => "builtin" })
    await assets.load(["demo"])
    assert.equal(registry.tools.get("demo_echo")?.execute(), "builtin")
    assert.ok(logs.some(args => String(args[0]).includes("工具名冲突")))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
