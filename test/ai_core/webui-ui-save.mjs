import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import express from "express"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright"

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
await globalThis.redis.set("webui:login:ui-key", "1", { EX: 600 })

const repo = process.cwd()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-ui-"))
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/default_config"), { recursive: true })
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/config"), { recursive: true })
const botFile = path.join(dir, "config/config/bot.yaml")
const botText = fs.readFileSync(botFile, "utf8")
fs.writeFileSync(botFile, /^file_watch:/m.test(botText) ? botText.replace(/^file_watch:.*$/m, "file_watch: false") : `${botText}\nfile_watch: false\n`)

process.chdir(dir)
const { registerWebUI } = await import(pathToFileURL(path.join(repo, "lib/webui/index.js")).href)
const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({ express: app, stat: { online: 2 }, bots: {}, package: { version: "test" }, url: "http://localhost:2536" })
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`
const check = (condition, message) => {
  if (!condition) throw new Error(message)
  console.log("ok:", message)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on("pageerror", err => errors.push(err.message))
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector("#login-key", { timeout: 15000 })
await page.fill("#login-key", "ui-key")
await page.locator('#gate-form button[type="submit"]').click()
await page.waitForSelector("#home-nav.active", { timeout: 15000 })
await page.locator('#config-groups .config-item[data-name="core:aigc"]').click()
await page.waitForSelector(".config-item.active", { timeout: 15000 })
await page.waitForSelector('[data-field="enable"]', { timeout: 15000 })

await page.locator('[data-field="enable"] .switch').click()
await page.waitForTimeout(200)
check(await page.locator("#save").isEnabled(), "toggle marks form dirty")
await page.locator("#save").click()
await page.waitForFunction(() => document.querySelector("#toast-text")?.textContent === "已保存", null, { timeout: 10000 })
const aigcFile = path.join(dir, "config/config/aigc.yaml")
check(fs.readFileSync(aigcFile, "utf8").includes("enable: true"), "form save writes YAML")
check(fs.readFileSync(aigcFile, "utf8").includes("# AIGC 开关"), "form save keeps comments")

await page.selectOption('[data-field="adapter"] select', "openai")
await page.locator("#save").click()
await page.waitForFunction(() => document.querySelector("#toast-text")?.textContent === "已保存", null, { timeout: 10000 })
check(fs.readFileSync(aigcFile, "utf8").includes("adapter: openai"), "select save writes YAML")

const firstItem = page.locator("details.array-item").first()
await firstItem.locator("summary").click()
await page.waitForTimeout(200)
await firstItem.locator('[data-array-path="models"][data-item-path="model"]').fill("UI-Model")
await page.locator("#save").click()
await page.waitForFunction(() => document.querySelector("#toast-text")?.textContent === "已保存", null, { timeout: 10000 })
check(fs.readFileSync(aigcFile, "utf8").includes("model: UI-Model"), "array item edit writes YAML")
const beforeCount = (fs.readFileSync(aigcFile, "utf8").match(/- name:/g) || []).length
await page.locator('[data-action="add-array-item"][data-array-path="models"]').click()
await page.waitForTimeout(200)
await page.locator("#save").click()
await page.waitForFunction(() => document.querySelector("#toast-text")?.textContent === "已保存", null, { timeout: 10000 })
const afterCount = (fs.readFileSync(aigcFile, "utf8").match(/- name:/g) || []).length
check(afterCount === beforeCount + 1, "array item add writes YAML")

await page.locator('.segmented [data-mode="yaml"]').click()
await page.waitForSelector("#raw-editor", { timeout: 10000 })
const raw = await page.locator("#raw-editor").inputValue()
const next = raw.replace(/keywords:.*$/m, "keywords: [UI-Bot]")
await page.locator("#raw-editor").fill(next)
await page.waitForTimeout(200)
check(await page.locator("#save").isEnabled(), "raw edit marks dirty")
await page.locator("#save").click()
await page.waitForFunction(() => document.querySelector("#toast-text")?.textContent === "已保存", null, { timeout: 10000 })
check(fs.readFileSync(aigcFile, "utf8").includes("keywords: [UI-Bot]"), "raw save writes YAML")

console.log("errors:", errors.length ? errors : "none")
await browser.close()
server.close()
try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}
process.exit(errors.length ? 1 : 0)
