import express from "express"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { registerWebUI } from "../../lib/webui/index.js"

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
await globalThis.redis.set("webui:login:ui-key", "1", { EX: 600 })

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({ express: app, stat: { online: 2 }, bots: { "123456": { uin: "123456", nickname: "TestBot", info: { nickname: "TestBot" }, adapter: { id: "QQ", name: "OneBotv11" }, gl: new Map([["987654321", { group_id: "987654321", group_name: "测试群" }]]), avatar: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23007aff'/%3E%3C/svg%3E" } }, package: { version: "test" }, url: "http://localhost:2536" })
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`
let cookie = ""
const json = (url, options = {}) => fetch(base + url, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } }).then(res => res.json())
const loginRes = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "api-key" }) })
if (loginRes.status !== 200) throw new Error("api login failed")
cookie = String(loginRes.headers.get("set-cookie") || "").split(";")[0]

const state = await json("/api/state")
if (!state.ok || !state.configs?.length) throw new Error("state failed")
console.log("configs:", state.configs.map(item => `${item.group}:${item.name}`).join(" | "))
console.log("plugins:", state.plugins.map(item => item.name).join(", "))
const aigc = await json("/api/config?name=core:aigc")
if (!aigc.ok || !aigc.config?.types) throw new Error("config failed")
console.log("aigc keys:", Object.keys(aigc.config.effective).length, "| comments:", Object.keys(aigc.config.comments).length, "| types:", Object.keys(aigc.config.types).length)
for (const asset of ["/", "/style.css", "/app.js", "/api/auth"]) {
  const res = await fetch(base + asset)
  console.log(asset, res.status, res.headers.get("content-type"))
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", err => errors.push(`pageerror: ${err.message}`))
page.on("console", msg => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
})
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector("#login-key", { timeout: 15000 })
console.log("login avatar:", await page.locator(".gate .app-icon img").count())
await page.fill("#login-key", "ui-key")
await page.locator('#gate-form button[type="submit"]').click()
await page.waitForSelector("#home-nav.active", { timeout: 15000 })
await page.waitForSelector(".dash-metrics-strip", { timeout: 15000 })
console.log("home:", await page.locator("#config-title").innerText(), "| metrics:", await page.locator(".dash-metrics-strip").count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-home.png"), fullPage: true })
await page.locator('#config-groups .config-item[data-name="core:bot"]').click()
await page.waitForSelector(".config-item.active", { timeout: 15000 })
await page.waitForSelector(".card", { timeout: 15000 })
console.log("brand:", await page.locator(".brand .app-icon img").count(), await page.locator("#brand-subtitle").innerText(), "| status:", await page.locator("#sidebar-foot .status").innerText(), "| groups:", await page.locator(".group-toggle").count())
console.log("title:", await page.locator("#config-title").innerText(), "| cards:", await page.locator(".card").count(), "| fields:", await page.locator(".field").count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-config.png"), fullPage: true })

await page.locator('#config-groups .config-item[data-name="core:bot"]').click()
await page.waitForTimeout(500)
console.log("switched:", await page.locator("#config-title").innerText())
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForSelector('[data-field="group_whitelist"] [data-multi]', { timeout: 15000 })
console.log("aigc whitelist options:", await page.locator('[data-field="group_whitelist"] [data-multi-option]').count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-bot.png"), fullPage: true })
await page.locator('[data-group="plugin:genshin"]').click()
await page.waitForTimeout(200)
await page.locator('#config-groups .config-item[data-name="plugin:genshin:config"]').click()
await page.waitForTimeout(500)
console.log("plugin page:", await page.locator("#config-title").innerText(), "| note:", await page.locator(".note-card").count(), "| fields:", await page.locator(".field").count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-plugin.png"), fullPage: true })
await page.locator('[data-group="plugin:miao-plugin"]').click()
await page.waitForTimeout(200)
await page.locator('[data-name="special:miao-help"]').click()
await page.waitForTimeout(600)
console.log("miao help:", await page.locator("#config-title").innerText(), "| cards:", await page.locator(".card").count(), "| help rows:", await page.locator(".help-item-row").count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-miao-help.png"), fullPage: true })

await page.locator('.segmented [data-mode="yaml"]').click()
await page.waitForSelector("#raw-editor", { timeout: 10000 })
await page.screenshot({ path: path.join(os.tmpdir(), "webui-yaml.png"), fullPage: true })
await page.locator('.segmented [data-mode="form"]').click()
await page.waitForTimeout(300)

await page.locator("[data-theme-toggle]").first().click()
await page.waitForTimeout(300)
console.log("theme:", await page.evaluate(() => document.documentElement.dataset.theme))
await page.screenshot({ path: path.join(os.tmpdir(), "webui-dark.png"), fullPage: true })

await page.setViewportSize({ width: 390, height: 844 })
await page.click("#sidebar-toggle")
await page.waitForTimeout(500)
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(os.tmpdir(), "webui-mobile.png"), fullPage: true })

console.log("errors:", errors.length ? errors : "none")
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
