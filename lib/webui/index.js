import express from "express"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import cfg from "../config/config.js"
import util from "../util.js"
import * as store from "./store.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, "public")
const MOUNT = "/aigc_yunzai"
const SESSION_COOKIE = "yunzai_webui_session"
const SESSION_PREFIX = "webui:session:"
const LOGIN_PREFIX = "webui:login:"
const SESSION_TTL = 12 * 3600

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      const status = Number(err?.status) || 500
      if (status >= 500) util.makeLog("error", ["WebUI", err?.stack || err], "WebUI")
      if (res.headersSent) return
      res.status(status).json({ ok: false, error: err?.message || "服务器错误" })
    })
  }
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("X-Robots-Tag", "noindex, nofollow")
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'")
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store")
  next()
}

function body(req) {
  return req.body && typeof req.body === "object" ? req.body : {}
}

function log(action, detail) {
  util.makeLog("mark", ["WebUI", action, detail].filter(Boolean), "WebUI")
}

function startupUrl(bot) {
  const origin = String(bot?.url || cfg.server?.url || `http://localhost:${cfg.server?.port || 2536}`).replace(/\/+$/, "")
  return `${origin}${MOUNT}/`
}

function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ""
}

function setSessionCookie(req, res, token) {
  const secure =
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() === "https"
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${MOUNT}; Max-Age=${SESSION_TTL}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`)
}

async function hasSession(req) {
  const token = getCookie(req, SESSION_COOKIE)
  if (!token || !globalThis.redis) return false
  return !!(await globalThis.redis.get(SESSION_PREFIX + token))
}

async function requireSession(req, res, next) {
  try {
    if (await hasSession(req)) return next()
  } catch {}
  res.status(401).json({ ok: false, error: "需要登录" })
}

export function registerWebUI(bot) {
  const app = bot.express
  if (!app.skip_auth.includes(MOUNT)) app.skip_auth.push(MOUNT)
  if (Array.isArray(app.quiet) && !app.quiet.includes(MOUNT)) app.quiet.push(MOUNT)

  const router = express.Router()
  router.use(securityHeaders)

  router.get("/api/auth", (req, res) => {
    res.json({ ok: true, login: true, session: true, bot: store.getBotInfo(bot) })
  })

  router.get(
    "/api/session",
    wrap(async (req, res) => {
      res.json({ ok: true, authenticated: await hasSession(req), bot: store.getBotInfo(bot) })
    }),
  )

  router.post(
    "/api/login",
    wrap(async (req, res) => {
      const key = String(body(req).key || "").trim()
      if (!key) return res.status(400).json({ ok: false, error: "请输入临时密钥" })
      if (!globalThis.redis) throw new Error("Redis 未初始化")
      const removed = await globalThis.redis.del(LOGIN_PREFIX + key)
      if (!removed) return res.status(401).json({ ok: false, error: "密钥无效或已过期" })
      const token = randomBytes(32).toString("base64url")
      await globalThis.redis.set(SESSION_PREFIX + token, "1", { EX: SESSION_TTL })
      setSessionCookie(req, res, token)
      log("登录成功")
      res.json({ ok: true, expires_in: SESSION_TTL })
    }),
  )

  router.use("/api", requireSession)

  router.get(
    "/api/state",
    wrap(async (req, res) => {
      res.json({ ok: true, ...store.getState(bot) })
    }),
  )

  router.get(
    "/api/config",
    wrap(async (req, res) => {
      res.json({ ok: true, config: await store.getConfig(String(req.query.name || "")) })
    }),
  )

  router.put(
    "/api/config",
    wrap(async (req, res) => {
      const payload = body(req)
      const config = await store.saveConfig(payload.name, payload.patch)
      log("保存配置", payload.name)
      res.json({ ok: true, config })
    }),
  )

  router.get(
    "/api/raw",
    wrap(async (req, res) => {
      res.json({ ok: true, ...store.getRaw(String(req.query.name || "")) })
    }),
  )

  router.put(
    "/api/raw",
    wrap(async (req, res) => {
      const payload = body(req)
      const config = await store.saveRaw(payload.name, payload.content)
      log("保存原始配置", payload.name)
      res.json({ ok: true, config })
    }),
  )

  router.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0, etag: true }))

  app.use(MOUNT, router)

  const url = startupUrl(bot)
  util.makeLog("mark", `Yunzai WebUI：${url}`, "WebUI")
}
