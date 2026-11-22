import express from "express"
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
await globalThis.redis.set("webui:login:ui-key", "1", { EX: 600 })

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({ express: app, stat: { online: 0 }, bots: {}, package: { version: "test" }, url: "http://localhost:2536" })
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`

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
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForSelector('.config-item.active[data-name="core:aigc"]', { timeout: 15000 })
await page.waitForSelector(".card", { timeout: 15000 })
await page.evaluate(() => document.querySelectorAll("details").forEach(d => (d.open = true)))
const add = page.locator('[data-action="add-array-item"][data-array-path="models"]')
await add.scrollIntoViewIfNeeded()
await add.click()
await page.waitForSelector(".dialog-choices .choice-item", { timeout: 15000 })
const rerankChoice = page.locator(".dialog-choices .choice-item", { hasText: "重排模型" })
console.log("rerank choice:", await rerankChoice.count())
await rerankChoice.click()
await page.waitForSelector(".array-item", { timeout: 15000 })
const labels = await page.locator(".array-item").last().locator(".field-info label").allInnerTexts()
console.log("rerank item labels:", labels.join(" | "))
console.log("has dimensions:", labels.some(text => text.includes("向量维度")), "| has base_url:", labels.some(text => text.includes("接口地址")))

await page.evaluate(() => document.querySelectorAll("details").forEach(d => (d.open = true)))
const modelSelect = page.locator('select[data-path="knowledge.rerank.model_config"]')
console.log("knowledge rerank model options:", (await modelSelect.locator("option").allInnerTexts()).join(" | "))
const adapterSelect = page.locator('select[data-path="knowledge.rerank.adapter"]')
console.log("knowledge rerank adapters:", (await adapterSelect.locator("option").allInnerTexts()).join(" | "))
console.log("errors:", errors.length ? errors.join(" | ") : "none")
await page.screenshot({ path: path.join(process.env.TEMP || ".", "webui-rerank.png"), fullPage: true })
await browser.close()
server.close()
process.exit(0)
