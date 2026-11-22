import test from "node:test"
import assert from "node:assert/strict"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} } }
globalThis.segment = { at: () => ({}), record: () => ({}), image: () => ({}), file: () => ({}) }
globalThis.redis = { get: async () => null, set: async () => "OK", del: async () => 1, keys: async () => [] }

const registry = (await import("../../lib/ai_core/tools/index.js")).default
const master = { event: { isMaster: true } }
const guest = { event: { isMaster: false } }

test("miao_data: 角色/武器/套装的别名与路径", async () => {
  let r = await registry.execute("miao_data", { game: "gs", type: "character", name: "雷神" }, master)
  assert.equal(r.result.name, "雷电将军")
  assert.match(r.result.root, /meta-gs\/character\/雷电将军$/)
  assert.ok(r.result.tree.includes("data.json"))

  r = await registry.execute("miao_data", { game: "gs", type: "weapon", name: "阿莫斯" }, master)
  assert.equal(r.result.name, "阿莫斯之弓")
  assert.match(r.result.root, /weapon\/bow\/阿莫斯之弓$/)

  r = await registry.execute("miao_data", { game: "gs", type: "artifact", name: "绝缘" }, master)
  assert.equal(r.result.name, "绝缘之旗印")
  assert.match(r.result.root, /artifact\/imgs\/绝缘之旗印$/)
  assert.ok(r.result.data_files.some(file => file.endsWith("meta-gs/artifact/data.json")))

  r = await registry.execute("miao_data", { game: "sr", type: "weapon", name: "夜色" }, master)
  assert.equal(r.result.name, "于夜色中")
  assert.equal(r.result.weapon_type, "巡猎")

  r = await registry.execute("miao_data", { game: "zzz", type: "character", name: "11号" }, master)
  assert.equal(r.result.name, "「11号」")
})

test("miao_data: 非 master 可查看路径并读取资源，但不能写入", async () => {
  const r = await registry.execute("miao_data", { game: "gs", type: "character", name: "雷神" }, guest)
  assert.equal(r.error, undefined)
  const dataFile = r.result.data_files[0]

  const read = await registry.execute("read", { file_path: dataFile }, guest)
  assert.equal(read.error, undefined)
  assert.match(read.result, /雷电将军/)

  const write = await registry.execute("write", { file_path: dataFile, content: "x" }, guest)
  assert.match(write.error, /权限不足/)
})

test("miao_data: 未找到名称", async () => {
  const r = await registry.execute("miao_data", { game: "gs", type: "character", name: "不存在的角色xyz" }, master)
  assert.match(r.error, /未找到/)
})
