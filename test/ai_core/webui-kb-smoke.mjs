import express from "express"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { registerWebUI } from "../../lib/webui/index.js"

const noop = () => {}
globalThis.logger = {
  blue: value => value,
  green: value => value,
  yellow: value => value,
  red: value => value,
  cyan: value => value,
  gray: value => value,
  logger: { mark: noop, info: noop, warn: noop, error: console.error, debug: noop, trace: noop },
  mark: noop,
  info: noop,
  warn: noop,
  error: console.error,
  debug: noop,
  trace: noop,
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
await globalThis.redis.set("webui:login:ui-key", "1", { EX: 600 })

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({ express: app, stat: { online: 2 }, bots: {}, package: { version: "test" }, url: "http://localhost:2536" })
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`
const loginRes = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "api-key" }) })
if (loginRes.status !== 200) throw new Error("login failed")
const cookie = String(loginRes.headers.get("set-cookie") || "").split(";")[0]
const json = (url, options = {}) => fetch(base + url, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } }).then(res => res.json())

const overview = await json("/api/kb")
if (!overview.ok) throw new Error("overview failed: " + JSON.stringify(overview))
console.log("kb overview:", overview.kbs.length, "enabled:", overview.enabled, "embedding:", overview.embedding)

const name = `UI验证-${Date.now()}`
const created = await json("/api/kb", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description: "smoke" }) })
if (!created.ok) throw new Error("create failed: " + JSON.stringify(created))
const kbId = created.kb.id
console.log("created:", created.kb.name)

const content = "# 部署\n\n## 环境变量\n\n设置 API_KEY 后重启服务。\n"
const importRes = await fetch(`${base}/api/kb/${kbId}/import?name=guide.md&mime=text%2Fmarkdown`, { method: "POST", headers: { cookie, "Content-Type": "application/octet-stream" }, body: Buffer.from(content) })
const imported = await importRes.json()
if (!imported.ok) throw new Error("import failed: " + JSON.stringify(imported))
let task = imported.task
for (let i = 0; i < 100; i++) {
  await new Promise(resolve => setTimeout(resolve, 100))
  const data = await json(`/api/kb/tasks/${task.id}`)
  task = data.task
  if (task.status === "done" || task.status === "error") break
}
console.log("import task:", task.status, task.error || "")
if (task.status !== "done") throw new Error("import failed")

const docs = await json(`/api/kb/${kbId}/documents`)
console.log("documents:", docs.documents.map(item => `${item.name}:${item.chunk_count}`).join(", "))

const search = await json(`/api/kb/${kbId}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "环境变量怎么配置", top_k: 5 }) })
console.log("search hits:", search.results?.length, "| first:", search.results?.[0]?.heading, search.results?.[0]?.score?.toFixed?.(3))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", err => errors.push(`pageerror: ${err.message}`))
page.on("console", msg => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
})
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector("#login-key", { timeout: 15000 })
await page.fill("#login-key", "ui-key")
await page.locator('#gate-form button[type="submit"]').click()
await page.waitForSelector("#home-nav.active", { timeout: 15000 })
await page.click("#kb-nav")
await page.waitForSelector("#config-title", { timeout: 15000 })
await page.waitForFunction(() => document.querySelector("#config-title")?.textContent === "知识库", { timeout: 15000 })
await page.waitForSelector(".kb-item", { timeout: 15000 })
console.log("ui title:", await page.locator("#config-title").innerText(), "| kb items:", await page.locator(".kb-item").count())
await page.locator(".kb-item", { hasText: name }).click()
await page.waitForSelector(".kb-doc", { timeout: 15000 })
console.log("ui docs:", await page.locator(".kb-doc").count())
await page.fill("#kb-query", "环境变量怎么配置")
await page.click('[data-kb-action="search"]')
await page.waitForSelector(".kb-hit", { timeout: 15000 })
console.log("ui hits:", await page.locator(".kb-hit").count(), "| heading:", await page.locator(".kb-hit-heading").first().innerText(), "| save hidden:", await page.locator("#save").isHidden())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-kb.png"), fullPage: true })
console.log("errors:", errors.length ? errors.join(" | ") : "none")

const all = await json("/api/kb")
for (const item of all.kbs.filter(kb => kb.name.startsWith("UI验证-"))) await json(`/api/kb/${item.id}`, { method: "DELETE" })
await browser.close()
server.close()
process.exit(0)
