import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createClient } from "../../lib/redis/index.js"
import cfg from "../../lib/config/config.js"

const redis = createClient(cfg.db?.storage || "data/db/data.db")
const base = "http://127.0.0.1:2536/yunzai"
const apiKey = `real-api-${Date.now()}`
const uiKey = `real-ui-${Date.now()}`
await redis.set(`webui:login:${apiKey}`, "1", { EX: 600 })
await redis.set(`webui:login:${uiKey}`, "1", { EX: 600 })
const loginRes = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: apiKey }) })
if (loginRes.status !== 200) throw new Error(`real login failed: ${loginRes.status}`)
const cookie = String(loginRes.headers.get("set-cookie") || "").split(";")[0]
const state = await fetch(`${base}/api/state`, { headers: { cookie } }).then(res => res.json())
console.log("real state:", JSON.stringify({ ok: state.ok, configs: state.configs?.length, plugins: state.plugins?.length, online: state.system?.online }))
if (!state.ok) process.exit(1)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", err => errors.push(`pageerror: ${err.message}`))
page.on("console", msg => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
})
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector("#login-key", { timeout: 20000 })
console.log("real login avatar:", await page.locator(".gate .app-icon img").count())
await page.fill("#login-key", uiKey)
await page.locator('#gate-form button[type="submit"]').click()
await page.waitForSelector("#home-nav.active", { timeout: 20000 })
await page.waitForSelector(".dash-metrics-strip", { timeout: 20000 })
console.log("real home:", await page.locator("#config-title").innerText(), "| metrics:", await page.locator(".dash-metrics-strip").count())
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForSelector(".config-item.active", { timeout: 20000 })
await page.waitForSelector(".card", { timeout: 20000 })
console.log("real title:", await page.locator("#config-title").innerText(), "| cards:", await page.locator(".card").count(), "| fields:", await page.locator(".field").count())
console.log("real brand:", await page.locator(".brand .app-icon img").count(), "|", await page.locator("#brand-subtitle").innerText(), "| status:", await page.locator("#sidebar-foot .status").innerText(), "| groups:", await page.locator(".group-toggle").count())
await page.screenshot({ path: path.join(os.tmpdir(), "webui-real.png"), fullPage: true })
const plugin = page.locator('#config-groups .config-item[data-name="plugin:genshin:config"]')
if (await plugin.count()) {
  await page.locator('[data-group="plugin:genshin"]').click()
  await page.waitForTimeout(200)
  await plugin.click()
  await page.waitForTimeout(500)
  console.log("real plugin:", await page.locator("#config-title").innerText(), "| note:", await page.locator(".note-card").count(), "| fields:", await page.locator(".field").count())
  await page.screenshot({ path: path.join(os.tmpdir(), "webui-real-plugin.png"), fullPage: true })
}
const miao = page.locator('[data-group="plugin:miao-plugin"]')
if (await miao.count()) {
  await miao.click()
  await page.waitForTimeout(200)
  const help = page.locator('[data-name="special:miao-help"]')
  if (await help.count()) {
    await help.click()
    await page.waitForTimeout(700)
    console.log("real miao help:", await page.locator("#config-title").innerText(), "| cards:", await page.locator(".card").count(), "| help rows:", await page.locator(".help-item-row").count())
    await page.screenshot({ path: path.join(os.tmpdir(), "webui-real-miao-help.png"), fullPage: true })
  }
}
console.log("errors:", errors.length ? errors : "none")
await browser.close()
process.exit(errors.length ? 1 : 0)
