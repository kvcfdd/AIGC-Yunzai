import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../../lib/ai_core/tools/tool-registry.js"

/** 测试用配置：把自定义工具放进原生列表，其余工具保持默认渐进式 */
function testConfig(native) {
  return { aigc: { tool_loading: { native } } }
}

test("ToolRegistry: 注册、导出定义、执行与异常", async () => {
  const r = new ToolRegistry({ config: testConfig(["echo", "bad"]) })
  r.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: {} },
    execute: async args => `hi ${args.name}`,
  })

  assert.equal(r.getDefinitions()[0].function.name, "echo")
  assert.deepEqual(await r.execute("echo", { name: "a" }), { name: "echo", result: "hi a" })
  assert.equal((await r.execute("missing", {})).error, "Unknown tool: missing")

  r.register({
    name: "bad",
    execute: async () => {
      throw new Error("boom")
    },
  })
  assert.deepEqual(await r.execute("bad", {}), { name: "bad", error: "boom" })
  r.unregister("bad")
  assert.equal(r.tools.has("bad"), false)
})

test("ToolRegistry: master-only 工具对所有人可见，仅 master 可执行", async () => {
  const r = new ToolRegistry({ config: testConfig(["pwsh"]) })
  r.register({ name: "pwsh", execute: async () => "ok" })

  assert.equal(
    r.getDefinitions().some(d => d.function.name === "pwsh"),
    true,
  )
  assert.match((await r.execute("pwsh", {}, { event: { isMaster: false } })).error, /未经授权/)
  assert.deepEqual(await r.execute("pwsh", {}, { event: { isMaster: true } }), { name: "pwsh", result: "ok" })
})

test("ToolRegistry: enabled 开关", async () => {
  const r = new ToolRegistry({ config: testConfig(["gated"]) })
  let on = false
  r.register({ name: "gated", execute: async () => "ok" }, { enabled: () => on })
  assert.equal(r.getDefinitions().length, 0)
  assert.equal((await r.execute("gated", {})).error, "Tool gated 未开启")
  on = true
  assert.equal(r.getDefinitions().length, 1)
  assert.deepEqual(await r.execute("gated", {}), { name: "gated", result: "ok" })
})
