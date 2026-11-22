import express from "express"
import { chromium } from "playwright"
import { registerWebUI } from "../../lib/webui/index.js"

globalThis.logger = {
  blue: value => value,
  logger: { mark: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
}

const kv = new Map()
globalThis.redis = {
  async get(key) {
    const value = kv.get(key)
    return typeof value === "string" ? value : null
  },
  async set(key, value) {
    kv.set(key, value)
    return "OK"
  },
  async del(key) {
    return kv.delete(key) ? 1 : 0
  },
  keys() {
    return []
  },
  hGetAll() {
    return {}
  },
}

const now = new Date()
const receiving = [10, 5, 24]
for (let i = 2; i >= 0; i--) {
  const date = new Date(now)
  date.setDate(date.getDate() - i)
  const day = `${date.getFullYear()}:${String(date.getMonth() + 1).padStart(2, "0")}:${String(date.getDate()).padStart(2, "0")}`
  kv.set(`Yz:count:receive:msg:total:${day}`, String(receiving[2 - i]))
  kv.set(`Yz:count:send:msg:total:${day}`, String([20, 15, 10][2 - i]))
}
await globalThis.redis.set("webui:login:chart-key", "1")

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.json())
registerWebUI({
  express: app,
  stat: { online: 2 },
  bots: { "123456": { uin: "123456", nickname: "TestBot", info: { nickname: "TestBot" }, adapter: { id: "QQ", name: "OneBotv11" }, gl: new Map() } },
  package: { version: "3.3.0" },
  url: "http://localhost:2536",
})
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}/yunzai`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } })
const errors = []
page.on("pageerror", err => errors.push(err.message))
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
await page.waitForSelector("#login-key", { timeout: 15000 })
await page.fill("#login-key", "chart-key")
await page.locator('#gate-form button[type="submit"]').click()
await page.waitForSelector(".dash-chart svg circle", { timeout: 15000 })
await page.waitForTimeout(300)

const hit = await page.evaluate(() => {
  const circles = [...document.querySelectorAll(".dash-chart svg circle")]
  const blue = circles.filter(circle => getComputedStyle(circle).fill === "rgb(0, 122, 255)")
  const green = circles.filter(circle => getComputedStyle(circle).fill === "rgb(52, 199, 89)")
  for (const point of blue) {
    const other = green.find(item => item.getAttribute("cx") === point.getAttribute("cx"))
    if (!other) continue
    if (Number(point.getAttribute("cy")) <= Number(other.getAttribute("cy"))) continue
    const rect = point.getBoundingClientRect()
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { tag: target?.tagName, title: target?.querySelector?.("title")?.textContent || "" }
  }
  return null
})
console.log("blue-below-green hit:", hit)
console.log("errors:", errors.length ? errors : "none")
await browser.close()
server.close()
process.exit(hit?.tag === "circle" && !errors.length ? 0 : 1)
