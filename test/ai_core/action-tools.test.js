import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { SkillStore } from "../../lib/ai_core/tools/skills/index.js"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} } }
globalThis.segment = { at: () => ({}), record: () => ({}), image: () => ({}), file: () => ({}) }
globalThis.redis = { get: async () => null, set: async () => "OK", del: async () => 1, keys: async () => [] }

const registry = (await import("../../lib/ai_core/tools/index.js")).default
const master = { event: { isMaster: true } }
const guest = { event: { isMaster: false } }
const shellName = process.platform === "win32" ? "pwsh" : "bash"

async function tempDir() {
  await fs.mkdir(path.join(process.cwd(), "temp"), { recursive: true })
  return fs.mkdtemp(path.join(process.cwd(), "temp", "action-tools-"))
}

const relPath = abs => path.relative(process.cwd(), abs).split(path.sep).join("/")

test("action tools: 所有工具 parameters 都是 object JSON Schema", () => {
  for (const def of registry.getDefinitions()) {
    const params = def.function.parameters
    assert.equal(params?.type, "object", `${def.function.name}.parameters.type`)
    assert.equal(typeof params?.properties, "object", `${def.function.name}.parameters.properties`)
  }
})

test("action tools: web_fetch 支持 http/playwright", () => {
  const def = registry.tools.get("web_fetch")
  assert.deepEqual(def.parameters.properties.mode.enum, ["http", "playwright"])
  assert.deepEqual(def.parameters.required, ["url"])
})

test("action tools: media 非管理员仅允许白名单本地路径", async () => {
  const def = registry.getDefinitions().find(d => d.function.name === "media")
  assert.deepEqual(def.function.parameters.properties.action.enum, ["load", "send"])
  assert.equal(def.function.parameters.properties.source.type, "array")
  assert.deepEqual(def.function.parameters.properties.type.enum, ["image", "video", "audio", "file"])

  const outside = path.join(process.cwd(), "package.json")
  for (const [action, args] of [
    ["load", { action: "load", source: outside }],
    ["send", { action: "send", type: "file", source: outside }],
  ]) {
    const r = await registry.execute("media", args, { event: { isMaster: false, reply: async () => {} } })
    assert.match(r.result, /权限不足/, action)
  }
})

test("action tools: skill 可读取任意技能", async () => {
  const dir = await tempDir()
  const skillDir = path.join(dir, "secret")
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: secret\ndescription: secret\n---\n\nsecret body\n", "utf8")
  const skills = new SkillStore(dir)
  try {
    for (const isMaster of [false, true]) {
      const r = await registry.execute("skill", { skill_name: "secret" }, { skills, event: { isMaster } })
      assert.match(r.result, /secret body/)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("action tools: media 发送支持绝对与相对路径", async () => {
  const dir = path.join(process.cwd(), "data", "aigc", "chat")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `media-test-${Date.now()}.txt`)
  await fs.writeFile(file, "hello", "utf8")
  const ctx = { event: { reply: async () => {}, isMaster: false } }
  try {
    let r = await registry.execute("media", { action: "send", type: "file", source: file }, ctx)
    assert.match(r.result, /Sent file "media-test-/)

    r = await registry.execute("media", { action: "send", type: "file", source: relPath(file) }, ctx)
    assert.match(r.result, /Sent file "media-test-/)
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("action tools: write/read/edit 往返", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "docs", "note.txt")
  const rel = relPath(file)
  try {
    let r = await registry.execute("write", { file_path: rel, content: "hello\nworld\n" }, master)
    assert.match(r.result, /<content>\nCreated file\n<\/content>/)

    r = await registry.execute("read", { file_path: rel }, master)
    assert.match(r.result, /1: hello/)
    assert.match(r.result, /2: world/)
    assert.match(r.result, /End of file - total 2 lines/)

    r = await registry.execute("edit", { file_path: rel, old_string: "world", new_string: "yunzai" }, master)
    assert.match(r.result, /has been updated successfully/)

    r = await registry.execute("read", { file_path: rel }, master)
    assert.match(r.result, /2: yunzai/)

    r = await registry.execute("write", { file_path: rel, content: "hello\nyunzai\n" }, master)
    assert.match(r.result, /Updated file/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("action tools: glob/grep", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "src", "a.js")
  const relDir = relPath(dir)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "const needle = 1\n", "utf8")

    let r = await registry.execute("glob", { pattern: "**/*.js", path: relDir }, master)
    assert.match(r.result, /src\/a\.js/)

    r = await registry.execute("grep", { pattern: "needle", path: relDir }, master)
    assert.match(r.result, /Found 1 match/)
    assert.match(r.result, /Line 1: const needle = 1/)

    r = await registry.execute("glob", { pattern: "**/*.js", path: relDir }, guest)
    assert.match(r.result, /src\/a\.js/)

    r = await registry.execute("grep", { pattern: "needle", path: relDir }, guest)
    assert.match(r.result, /Found 1 match/)

    r = await registry.execute("grep", { pattern: "need.*", path: relDir }, guest)
    assert.match(r.result, /Found 1 match/)

    for (const [name, args] of [
      ["glob", { pattern: "**/*.js", path: "config" }],
      ["grep", { pattern: "name", path: "config" }],
      ["glob", { pattern: "**/*.js", path: "." }],
    ]) {
      r = await registry.execute(name, args, guest)
      assert.match(r.error, /权限不足/, name)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("action tools: 越界路径与普通用户目录限制", async () => {
  let r = await registry.execute("read", { file_path: "../../Windows/win.ini" }, master)
  assert.match(r.error, /path escapes/)

  const dir = await tempDir()
  const file = path.join(dir, "guest.txt")
  const rel = relPath(file)
  try {
    r = await registry.execute("write", { file_path: rel, content: "guest" }, guest)
    assert.equal(r.error, undefined)
    r = await registry.execute("read", { file_path: rel }, guest)
    assert.match(r.result, /1: guest/)
    r = await registry.execute("edit", { file_path: rel, old_string: "guest", new_string: "ok" }, guest)
    assert.equal(r.error, undefined)

    r = await registry.execute("read", { file_path: "skills/skill-authoring/SKILL.md" }, guest)
    assert.match(r.result, /name: skill-authoring/)

    for (const [name, args] of [
      ["read", { file_path: "package.json" }],
      ["write", { file_path: "package.json", content: "x" }],
      ["edit", { file_path: "package.json", old_string: "a", new_string: "b" }],
    ]) {
      r = await registry.execute(name, args, guest)
      assert.match(r.error, /权限不足/, name)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("action tools: shell 仅 master 且可执行", async () => {
  let r = await registry.execute(shellName, { command: "echo hi", timeoutMs: 10000 }, guest)
  assert.match(r.error, /未经授权/)

  const command = process.platform === "win32" ? "Write-Output hi" : "echo hi"
  r = await registry.execute(shellName, { command, timeoutMs: 10000 }, master)
  assert.match(r.result, /hi/)
})
