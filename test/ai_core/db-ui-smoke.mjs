import express from "express"
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
    if (!item || (item.exp && item.exp < Date.now())) return null
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

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({
  express: app,
  stat: { online: 1 },
  bots: { "123456": { uin: "123456", nickname: "TestBot", info: { nickname: "TestBot" }, adapter: { id: "QQ", name: "OneBotv11" }, gl: new Map(), avatar: "" } },
  package: { version: "test" },
  url: "http://localhost:2536",
})
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`
const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "api-key" }) })
const cookie = String(login.headers.get("set-cookie") || "").split(";")[0]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
const errors = []
page.on("pageerror", err => errors.push(err.message))
await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: base }])
await page.goto(base, { waitUntil: "domcontentloaded" })
await page.waitForSelector('#config-groups .config-item[data-name="core:db"]', { timeout: 15000 })
await page.locator('#config-groups .config-item[data-name="core:db"]').click()
await page.waitForSelector('[data-field="storage"]', { timeout: 15000 })

const storageReadonly = await page.locator('[data-field="storage"] input').evaluate(el => el.readOnly)
const storageBadge = await page.locator('[data-field="storage"] .type-badge').textContent()
const dialectDisabled = await page.locator('[data-field="dialect"] select').isDisabled()
const dialectBadge = await page.locator('[data-field="dialect"] .type-badge').textContent()
const loggingSwitch = await page.locator('[data-field="logging"] input[type="checkbox"]').count()
if (!storageReadonly || !storageBadge.includes("只读")) throw new Error("storage should be read-only")
if (!dialectDisabled || !dialectBadge.includes("只读")) throw new Error("dialect should be disabled")
if (!loggingSwitch) throw new Error("logging should render as a switch")
console.log("db UI smoke OK | errors:", errors.length ? errors : "none")
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
