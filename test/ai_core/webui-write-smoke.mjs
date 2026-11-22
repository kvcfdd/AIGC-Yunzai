import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import express from "express"
import { pathToFileURL } from "node:url"

globalThis.logger = {
  blue: value => value,
  logger: { mark: () => {}, info: () => {}, warn: () => {}, error: console.error, debug: () => {}, trace: () => {} },
}

const kv = new Map()
globalThis.redis = {
  async get(key) {
    const item = kv.get(key)
    if (!item) return null
    if (item.exp && item.exp < Date.now()) {
      kv.delete(key)
      return null
    }
    return item.value
  },
  async set(key, value, opts) {
    kv.set(key, { value: String(value), exp: opts?.EX ? Date.now() + opts.EX * 1000 : null })
    return "OK"
  },
  async del(key) {
    return kv.delete(key) ? 1 : 0
  },
}
await globalThis.redis.set("webui:login:api-key", "1", { EX: 600 })
await globalThis.redis.set("webui:login:single-key", "1", { EX: 600 })

const repo = process.cwd()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-write-"))
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/default_config"), { recursive: true })
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/config"), { recursive: true })
const botFile = path.join(dir, "config/config/bot.yaml")
const botText = fs.readFileSync(botFile, "utf8")
fs.writeFileSync(botFile, /^file_watch:/m.test(botText) ? botText.replace(/^file_watch:.*$/m, "file_watch: false") : `${botText}\nfile_watch: false\n`)

const pluginDir = path.join(dir, "plugins/foo-plugin")
fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
fs.mkdirSync(path.join(pluginDir, "defaultConfig/bilibili"), { recursive: true })
fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "foo-plugin", version: "1.0.0", description: "test" }))
fs.writeFileSync(path.join(pluginDir, "config/foo.yaml"), "foo:\n  bar: 5\n")
fs.writeFileSync(path.join(pluginDir, "defaultConfig/foo.yaml"), "foo:\n  bar: 1\n  extra: true\n")
fs.writeFileSync(path.join(pluginDir, "defaultConfig/bilibili/config.yaml"), 'enabled: false\nname: ""\n')
fs.writeFileSync(path.join(dir, "config/foo.yaml"), "foo:\n  bar: 1\n  list:\n    - a\n")

const dataDir = path.join(dir, "data/foo-plugin/config/bilibili")
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, "config.yaml"), "enabled: true\n")

const miaoConfig = path.join(dir, "plugins/miao-plugin/config")
fs.mkdirSync(miaoConfig, { recursive: true })
fs.writeFileSync(path.join(dir, "plugins/miao-plugin/package.json"), JSON.stringify({ name: "miao-plugin", type: "module" }))
fs.writeFileSync(path.join(miaoConfig, "help_default.js"), 'export const helpCfg = { title: "喵喵帮助", subTitle: "Test", colCount: 3 }\nexport const helpList = [{ group: "测试分组", list: [{ icon: 1, title: "#测试", desc: "默认" }] }]\n')

process.chdir(dir)
const { registerWebUI } = await import(pathToFileURL(path.join(repo, "lib/webui/index.js")).href)
const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({ express: app, stat: { online: 2 }, bots: {}, package: { version: "test" }, url: "http://localhost:2536" })
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`
let cookie = ""
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const check = (condition, message) => {
  if (!condition) throw new Error(message)
  console.log("ok:", message)
}

const loginRes = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "api-key" }) })
check(loginRes.status === 200, "api login succeeds")
cookie = String(loginRes.headers.get("set-cookie") || "").split(";")[0]
check(!!cookie, "session cookie issued")

const state = await call("GET", "/api/state")
const names = state.body.configs.map(item => item.name)
console.log("configs:", names.join(" | "))
check(state.status === 200 && names.includes("core:aigc"), "core config listed")
check(state.body.configs.some(item => item.name === "root:foo" && item.group === "plugin"), "root plugin config detected")
check(state.body.configs.some(item => item.name === "plugin:foo-plugin:foo" && item.hasDefault), "plugin dir config detected")
check(state.body.configs.some(item => item.name === "data:foo-plugin:bilibili/config" && item.hasDefault), "plugin data config detected")
check(state.body.configs.some(item => item.name === "special:miao-help" && item.special === "miao-help"), "miao help entry detected")
const help = await call("GET", "/api/config?name=" + encodeURIComponent("special:miao-help"))
check(help.status === 200 && help.body.config.effective.helpCfg.title === "喵喵帮助", "miao help loaded")
const helpSaved = await call("PUT", "/api/config", { name: "special:miao-help", patch: { helpCfg: { title: "测试帮助" }, helpList: [{ group: "测试分组", list: [{ icon: 2, title: "#新命令", desc: "新说明" }] }] } })
check(helpSaved.status === 200 && helpSaved.body.config.effective.helpCfg.title === "测试帮助", "miao help structured save")
const helpFile = path.join(dir, "plugins/miao-plugin/config/help.js")
check(fs.existsSync(helpFile) && fs.readFileSync(helpFile, "utf8").includes("测试帮助"), "help.js created and written")
const helpRaw = await call("PUT", "/api/raw", { name: "special:miao-help", content: 'export const helpCfg = { title: "源码帮助" }\nexport const helpList = []\n' })
check(helpRaw.status === 200 && helpRaw.body.config.effective.helpCfg.title === "源码帮助", "miao help raw save")

const internal = await call("GET", "/api/config?name=" + encodeURIComponent("plugin:foo-plugin:foo"))
check(internal.status === 200 && internal.body.config.effective.foo.bar === 5 && internal.body.config.effective.foo.extra === true, "plugin config merges defaults for display")
const internalSaved = await call("PUT", "/api/config", { name: "plugin:foo-plugin:foo", patch: { foo: { bar: 6 } } })
check(internalSaved.status === 200 && internalSaved.body.config.effective.foo.bar === 6, "plugin config patch saved")
check(fs.readFileSync(path.join(pluginDir, "config/foo.yaml"), "utf8").includes("bar: 6"), "plugin config written")

const dataConfig = await call("GET", "/api/config?name=" + encodeURIComponent("data:foo-plugin:bilibili/config"))
check(dataConfig.status === 200 && dataConfig.body.config.effective.enabled === true && dataConfig.body.config.effective.name === "", "data config merges defaults")
const dataSaved = await call("PUT", "/api/config", { name: "data:foo-plugin:bilibili/config", patch: { name: "Yuki" } })
check(dataSaved.status === 200 && dataSaved.body.config.effective.name === "Yuki", "data config patch saved")
check(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8").includes("name: Yuki"), "data config written")

const aigc = await call("GET", "/api/config?name=core:aigc")
check(aigc.status === 200 && aigc.body.config.effective.enable === false, "core config readable")
check(!!aigc.body.config.comments.enable, "default comments extracted")
const saved = await call("PUT", "/api/config", { name: "core:aigc", patch: { proactive_group_chat: { keywords: ["TempBot"] }, embeddings: { enable: false } } })
check(saved.status === 200 && saved.body.config.effective.proactive_group_chat.keywords[0] === "TempBot", "core config patch saved")
const aigcText = fs.readFileSync(path.join(dir, "config/config/aigc.yaml"), "utf8")
check(aigcText.includes("TempBot"), "core config written")
check(aigcText.includes("# AIGC 开关"), "core comments preserved")

const badKey = await call("PUT", "/api/config", { name: "core:aigc", patch: { not_a_key: true } })
check(badKey.status === 400, "unknown key rejected")
const badType = await call("PUT", "/api/config", { name: "core:aigc", patch: { enable: "yes" } })
check(badType.status === 400, "type mismatch rejected")

const rootSaved = await call("PUT", "/api/config", { name: "root:foo", patch: { foo: { bar: 2 } } })
check(rootSaved.status === 200 && rootSaved.body.config.effective.foo.bar === 2, "root plugin config patch saved")
check(fs.readFileSync(path.join(dir, "config/foo.yaml"), "utf8").includes("bar: 2"), "root plugin config written")

const changed = aigc.body.config.effective.models.map((model, index) => (index === 0 ? { ...model, retry_count: 3 } : model))
const arraySaved = await call("PUT", "/api/config", { name: "core:aigc", patch: { models: changed } })
check(arraySaved.status === 200 && arraySaved.body.config.effective.models[0].retry_count === 3, "array of objects patch saved")

const badRaw = await call("PUT", "/api/raw", { name: "root:foo", content: "broken: [\n" })
check(badRaw.status === 400, "invalid raw YAML rejected")
const goodRaw = await call("PUT", "/api/raw", { name: "root:foo", content: "foo:\n  bar: 3\n" })
check(goodRaw.status === 200 && goodRaw.body.config.effective.foo.bar === 3, "raw YAML saved")

const unauth = await fetch(`${base}/api/state`)
check(unauth.status === 401, "auth rejected without session")
const badLogin = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "bad" }) })
check(badLogin.status === 401, "invalid login key rejected")
const authInfo = await fetch(`${base}/api/auth`).then(res => res.json())
check(authInfo.ok === true && authInfo.login === true, "login auth metadata exposed")
const single1 = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "single-key" }) })
check(single1.status === 200, "one-time key accepted")
const single2 = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "single-key" }) })
check(single2.status === 401, "one-time key consumed")

server.close()
try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}
console.log("webui write smoke passed")
process.exit(0)
