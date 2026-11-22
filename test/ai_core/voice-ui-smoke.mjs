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
await page.waitForSelector('#config-groups .config-item[data-name="core:aigc"]', { timeout: 15000 })
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForSelector('[data-array-path="voice.models"]', { timeout: 15000 })

const configBox = await page.locator('[data-field="voice.model_config"]').boundingBox()
const modelsBox = await page.locator('[data-field="voice.models"]').boundingBox()
if (!configBox || !modelsBox || configBox.y > modelsBox.y) throw new Error("model_config should render above models")

const entries = await page.locator('details.array-item[data-array-path="voice.models"]').count()
if (entries < 1) throw new Error("voice models not rendered")
const apiFields = await page.locator('[data-array-path="voice.models"] [data-item-path="api"]').count()
if (apiFields) throw new Error("api template should not render as a config field")

await page.locator('[data-action="add-array-item"][data-array-path="voice.models"]').click()
await page.waitForSelector('#dialog [data-choice="openai"]', { timeout: 10000 })
const usedChoice = await page.locator('#dialog [data-choice="wusound"]').count()
if (usedChoice) throw new Error("used api template should not be offered")
await page.locator('#dialog [data-choice="openai"]').click()
const opened = page.locator('details.array-item[data-array-path="voice.models"][open]').last()
await opened.waitFor({ timeout: 10000 })
const apiField = await opened.locator('[data-item-path="api"]').count()
const hint = await opened.locator('.array-item-hint').textContent()
const nameInput = opened.locator('[data-item-path="name"]')
const nameReadonly = await nameInput.evaluate(el => el.readOnly)
const nameValue = await nameInput.inputValue()
const modelField = await opened.locator('[data-item-path="model"]').count()
const keyField = await opened.locator('[data-item-path="api_keys"]').count()
const baseUrlField = await opened.locator('[data-item-path="base_url"]').count()
if (apiField) throw new Error("api template should not render after adding")
if (!String(hint || "").includes("OpenAI")) throw new Error(`provider label missing in summary: ${hint}`)
if (!nameReadonly || nameValue !== "openai") throw new Error(`name should be read-only: ${nameValue} readonly=${nameReadonly}`)
if (!modelField || !keyField || !baseUrlField) throw new Error("openai template fields missing")
console.log("voice UI smoke OK | entries:", entries, "| errors:", errors.length ? errors : "none")
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
