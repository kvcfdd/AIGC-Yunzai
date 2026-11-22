import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolRegistry, isMasterOnlyTool } from "../../lib/ai_core/tools/tool-registry.js"
import { SkillStore, skillsListBlock } from "../../lib/ai_core/tools/skills/index.js"
import { PluginAssets } from "../../lib/ai_core/plugin-assets.js"
import { isUnderNonMasterReadDir } from "../../lib/ai_core/tools/workspace.js"

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
