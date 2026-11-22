import { randomInt } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Bot as QQBot, ReceiverMode, segment as sdkSegment } from "qq-official-bot"
import cfg from "../../lib/config/config.js"

// 被动回复有效期
const PASSIVE_TTL = 60 * 60 * 1000
// 单聊/群聊/群管每个 msg_id 最多回复次数
const C2C_PASSIVE_LIMIT = 4
const GROUP_PASSIVE_LIMIT = 5
const GROUP_ADMIN_PASSIVE_LIMIT = 50
// msg_seq 冲突最多连续换号重试次数
const MAX_SEQ_RETRIES = 5
// 缓存上限
const PASSIVE_POOL_MAX = 100
const PASSIVE_CONVERSATIONS_MAX = 500
const GROUP_INFO_MAX = 500
const BOT_STATE_MAX = 500
const BOT_MENTION_MAX = 500
const EVENT_SOURCE_MAX = 200
const MESSAGE_REF_MAX = 500
const SEEN_MAX = 1000
const SEEN_TTL = 10 * 60 * 1000
const HISTORY_MAX = 50
const HISTORY_CONVERSATIONS = 100
// 消息与媒体限制
const EMPTY_MARKDOWN = "\u200b"
const TEXT_LIMIT = 1800
const MARKDOWN_LIMIT = 3000
const AUDIO_MAX_BYTES = 25 * 1024 * 1024
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const MATERIAL_MAX_IMAGES = 3
const KEYBOARD_MAX_ROWS = 5
const KEYBOARD_MAX_COLS = 5
const DEFAULT_MUTE_SECONDS = 1800
const MAX_MUTE_SECONDS = 30 * 24 * 60 * 60
// 互动回应延时
const INTERACTION_ACK_DELAY = 1500
// 重连与超时
const RETRY_BASE = 10000
const RETRY_MAX = 300000
const CONNECT_TIMEOUT = 30000
// Intent 降级序列
const INTENT_SETS = [["GROUP_AND_C2C_EVENT", "GROUP_MEMBER", "INTERACTION"], ["GROUP_AND_C2C_EVENT", "INTERACTION"], ["GROUP_AND_C2C_EVENT", "GROUP_MEMBER"], ["GROUP_AND_C2C_EVENT"]]
const INTENT_CLOSE_CODES = [4013, 4014]
const FATAL_CLOSE_CODES = [4914, 4915]
const NON_RETRY_CLOSE_CODES = [4001, 4002, 4010, 4011, 4012]
// 错误分类
const PASSIVE_ERROR = /msg[\s_-]*id|event[\s_-]*id|消息\s*id|被动回复[\s\S]{0,16}(?:超限|过期|失效|无效|错误|限制)|回复[\s\S]{0,12}(?:过期|失效|超限)|30402[67]|304103|40034005|4003402[4-7]|40034128/i
const DEDUP_ERROR = /msg[\s_-]*seq|40054005|去重/i
const EXPIRED_ERROR = /过期|失效|expired|304027|304103|40034005|40034026/i
const AUTH_ERROR = /1124[1-3]|authorization/i
const ACTIVE_ERROR = /40034100|40034105|40054013|主动消息失败|主动消息[\s\S]{0,20}(?:无权限|关闭|未开启|频控)|用户拒收消息/i
const KEYBOARD_ERROR = /30403[7-9]|304040|304057|305007|40034029|keybo?ard|按钮组件/i
const MARKDOWN_ERROR = /markdown|304014|304036|4003400[89]|4003401[01]|40034124|40034127|50037|5004[12]|5005[4-7]/i
const IMAGE_RESOURCE_ERROR = /图片|image|素材|资源|转存|304010|40034004|40035\d{3}/i

const splitText = (text, limit) => {
  if (text.length <= limit) return [text, ""]
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end = end > 1 ? end - 1 : Math.min(2, text.length)
  return [text.slice(0, end), text.slice(end)]
}

function splitMarkdown(text, limit = MARKDOWN_LIMIT) {
  const str = String(text ?? "")
  if (str.length <= limit) return [str]
  const chunks = []
  let rest = str
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < Math.floor(limit * 0.4)) cut = splitText(rest, limit)[0].length
    else cut += 1
    const chunk = rest.slice(0, cut)
    if (chunk) chunks.push(chunk)
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

const sanitizeText = text => String(text).replace(/<qqbot-/gi, "<qqbot\u200b-")
const normalizeUrl = url => (!url || typeof url !== "string" ? "" : /^https?:\/\//i.test(url) ? url : url.startsWith("//") ? `https:${url}` : `https://${url}`)
const capMap = (map, max) => {
  while (map.size > max) map.delete(map.keys().next().value)
}

function stripMarkdownTags(text) {
  return String(text || "")
    .replace(/<qqbot-at-user\b[^>]*\/?>/gi, "")
    .replace(/<qqbot-cmd-[^>]*(?:\bshow=["']([^"']*)["']|\btext=["']([^"']*)["'])[^>]*\/?>/gi, (_, show, txt) => show ?? txt ?? "")
    .replace(/<qqbot-cmd-[^>]*\/?>/gi, "")
}

function errorText(err) {
  if (!err) return ""
  if (typeof err === "string") return err
  return [err.message, err.code, err.err_code, err.status, err.statusCode, err.response?.status, err.response?.data?.err_code, err.response?.data?.code, err.response?.data?.message]
    .filter(v => v != null && v !== "")
    .map(String)
    .join(" ")
}

function isAuthError(err) {
  const text = errorText(err)
  if (AUTH_ERROR.test(text)) return true
  return Number(err?.response?.status ?? err?.status ?? err?.statusCode) === 401 && !/11298/.test(text)
}

function resolveLocalPath(value) {
  if (!/^file:\/\//i.test(value)) return value
  try {
    return fileURLToPath(value)
  } catch {
    return value.replace(/^file:\/\//i, "")
  }
}

function isSilk(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 9) return false
  return buffer[0] === 0x02 ? buffer.subarray(1, 10).toString("ascii") === "#!SILK_V3" : buffer.subarray(0, 9).toString("ascii") === "#!SILK_V3"
}

function fileNameFrom(value) {
  if (typeof value !== "string" || !value || /^(?:base64:\/\/|data:)/i.test(value)) return "file.bin"
  try {
    if (/^https?:\/\//i.test(value)) return decodeURIComponent(new URL(value).pathname.split("/").pop() || "") || "file.bin"
    return path.basename(resolveLocalPath(value)) || "file.bin"
  } catch {
    return "file.bin"
  }
}

function toRfc3339(value) {
  const d = new Date(value)
  const pad = n => String(n).padStart(2, "0")
  const off = -d.getTimezoneOffset()
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function extractSceneExt(ext, key) {
  if (!Array.isArray(ext)) return ""
  const item = ext.find(s => typeof s === "string" && s.startsWith(`${key}=`))
  return item ? item.slice(key.length + 1) : ""
}

function toSdkSource(source) {
  if (!source) return undefined
  return source.event_id ? { event_id: source.event_id } : { id: source.id }
}

function permissionType(value) {
  if (typeof value === "string") {
    const key = value.toLowerCase()
    if (["admin", "管理员", "1"].includes(key)) return 1
    if (["specify", "指定用户", "0"].includes(key)) return 0
    if (["role", "身份组", "3"].includes(key)) return 3
    return 2
  }
  const type = Number(value)
  return [0, 1, 2, 3].includes(type) ? type : 2
}

function normalizePermission(permission) {
  if (permission == null) return { type: 2 }
  if (Array.isArray(permission)) return { type: 0, specify_user_ids: permission.map(String) }
  if (typeof permission === "object") {
    const type = permissionType(permission.type)
    const result = { ...permission, type }
    if (type === 0) result.specify_user_ids = (permission.specify_user_ids || []).map(String)
    if (type === 3) result.specify_role_ids = (permission.specify_role_ids || []).map(String)
    return result
  }
  const type = permissionType(permission)
  return type === 0 ? { type, specify_user_ids: [] } : { type }
}

function normalizeButton(button, nextId) {
  if (!button || typeof button !== "object") return null
  if (Array.isArray(button)) {
    const buttons = button.map(item => normalizeButton(item, nextId)).filter(Boolean)
    return buttons.length ? { buttons } : null
  }
  if (button.buttons) {
    const buttons = (Array.isArray(button.buttons) ? button.buttons : [button.buttons]).map(item => normalizeButton(item, nextId)).filter(Boolean)
    return buttons.length ? { buttons } : null
  }

  const label = button.text ?? button.label ?? button.render_data?.label
  if (label == null || String(label) === "") return null
  const render = button.render_data && typeof button.render_data === "object" ? button.render_data : {}
  const { style: rawStyle, ...renderRest } = render
  const styleVal = rawStyle ?? button.style
  const style = styleVal == null || styleVal === "" ? 0 : Number(styleVal)
  const render_data = {
    ...renderRest,
    label: String(label),
    visited_label: String(render.visited_label ?? button.visited_label ?? label),
    style: Number.isFinite(style) ? style : 0,
  }

  const action = button.action && typeof button.action === "object" ? { ...button.action } : {}
  if (action.type === undefined) {
    if (button.link) [action.type, action.data] = [0, String(button.link)]
    else if (button.input !== undefined) [action.type, action.data, action.enter] = [2, String(button.input), button.enter !== false]
    else [action.type, action.data] = [1, String(button.callback ?? button.id ?? label)]
  }
  if (typeof action.type === "string") {
    const v = action.type.toLowerCase()
    action.type = /^[012]$/.test(v) ? Number(v) : ["link", "url", "jump"].includes(v) ? 0 : ["input", "command"].includes(v) ? 2 : 1
  }
  action.type = [0, 1, 2].includes(Number(action.type)) ? Number(action.type) : 1
  if (action.type === 0 && action.data === undefined) action.data = String(button.link ?? "")
  if ((action.type === 1 || action.type === 2) && action.data === undefined) action.data = String(button.callback ?? button.input ?? button.id ?? label)
  action.permission = normalizePermission(action.permission ?? button.permission)
  for (const key of ["enter", "reply", "unsupport_tips", "anchor", "modal"]) if (button[key] !== undefined && action[key] === undefined) action[key] = button[key]

  return {
    id: String(button.id || nextId()),
    render_data,
    action,
    ...(button.group_id !== undefined && action.type === 1 ? { group_id: String(button.group_id) } : {}),
  }
}

async function readSource(source, maxBytes, label = "文件") {
  if (Buffer.isBuffer(source)) {
    if (source.length > maxBytes) throw new Error(`${label}文件过大`)
    return source
  }
  const value = String(source ?? "")
  if (!value) throw new Error(`${label}为空`)
  if (value.startsWith("base64://") || /^data:[^;]+;base64,/i.test(value)) {
    const buffer = Buffer.from(value.replace(/^(?:base64:\/\/|data:[^;]+;base64,)/i, ""), "base64")
    if (buffer.length > maxBytes) throw new Error(`${label}文件过大`)
    return buffer
  }
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载${label}失败：HTTP ${res.status}`)
    if (Number(res.headers.get("content-length") || 0) > maxBytes) throw new Error(`${label}文件过大`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`${label}文件过大`)
    return buffer
  }
  const filePath = resolveLocalPath(value)
  if ((await fs.stat(filePath)).size > maxBytes) throw new Error(`${label}文件过大`)
  return fs.readFile(filePath)
}

/** 识别图片格式与宽高 */
function detectImageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: ".png", width: buf.length >= 24 ? buf.readUInt32BE(16) : 0, height: buf.length >= 24 ? buf.readUInt32BE(20) : 0 }
  const head = buf.subarray(0, 6).toString("ascii")
  if (head === "GIF87a" || head === "GIF89a") return { ext: ".gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const c = buf.length >= 16 ? buf.subarray(12, 16).toString("ascii") : ""
    if (c === "VP8 " && buf.length >= 30) return { ext: ".webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (c === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21)
      return { ext: ".webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    if (c === "VP8X" && buf.length >= 30) return { ext: ".webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    return { ext: ".webp", width: 0, height: 0 }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    for (let i = 2; i + 4 <= buf.length;) {
      while (i < buf.length && buf[i] !== 0xff) i++
      while (i < buf.length && buf[i] === 0xff) i++
      if (i >= buf.length) break
      const m = buf[i++]
      if (m === 0xd9 || m === 0xda) break
      if (m === 0xd8 || m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue
      if (i + 2 > buf.length) break
      const len = buf.readUInt16BE(i)
      if (len < 2 || i + len > buf.length) break
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m) && i + 7 <= buf.length) return { ext: ".jpg", height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) }
      i += len
    }
    return { ext: ".jpg", width: 0, height: 0 }
  }
  return null
}

function ffmpegToPcm(input) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error("ffmpeg 转换超时")), 60000)
    timer.unref?.()
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: ac.signal,
    })
    const chunks = []
    let error = ""
    child.stdout.on("data", chunk => chunks.push(chunk))
    child.stderr.on("data", chunk => (error += chunk))
    child.on("error", err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", code => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg 转换失败 (${code})：${error.slice(0, 200)}`))
    })
  })
}

async function toSilk(source, name = "voice") {
  const buffer = await readSource(source, AUDIO_MAX_BYTES, "语音")
  if (isSilk(buffer)) return buffer[0] === 0x02 ? buffer : Buffer.concat([Buffer.from([0x02]), buffer])

  const tempDir = path.resolve("temp/qqbot")
  await fs.mkdir(tempDir, { recursive: true })
  const temp = path.join(tempDir, `${Date.now().toString(36)}${randomInt(1000, 9999)}${path.extname(String(name || "")) || ".audio"}`)
  try {
    await fs.writeFile(temp, buffer)
    const { encode } = await import("silk-wasm")
    return Buffer.from((await encode(await ffmpegToPcm(temp), 24000)).data)
  } finally {
    fs.rm(temp, { force: true }).catch(() => {})
  }
}

class QQBotInstance {
  id = "QQBot"
  name = "QQ官方机器人"
  sdk = null
  appid = ""
  secret = ""
  selfId = ""
  nickname = ""
  avatar = ""
  mode = "websocket"
  replyText = false
  activeWarned = false
  passiveReply = true
  customIntents = null
  retryTimer = null
  retryDelay = RETRY_BASE
  started = false
  stopped = false
  startToken = 0
  startAbort = null
  intentIndex = 0
  intentRetry = false
  tokenRefreshPromise = null
  boundReceivers = new WeakSet()
  fl = new Map()
  gl = new Map()
  gml = new Map()
  messageRefs = new Map()
  passivePools = new Map()
  eventSources = new Map()
  groupInfo = new Map()
  botStates = new Map()
  botMentionIds = new Map()
  seen = new Map()
  histories = new Map()

  constructor(config) {
    this.config = config
  }

  get botName() {
    return this.nickname || this.sdk?.nickname || this.name
  }

  makeLog(msg) {
    return Bot.String(msg).replace(/base64:\/\/[^,\]"'\s}]+/g, "base64://...")
  }

  logError(msg, err) {
    Bot.makeLog("error", [msg, err?.stack || errorText(err) || String(err)], this.selfId)
  }

  init() {
    const config = this.config
    this.appid = String(config.appid || "").trim()
    this.secret = String(config.secret || "").trim()
    this.mode = config.mode === "webhook" ? "webhook" : "websocket"
    this.replyText = config.reply_text === true
    this.passiveReply = config.passive_reply !== false
    this.customIntents = Array.isArray(config.intents) && config.intents.length ? config.intents.map(String) : null
    this.selfId = this.appid

    const sdkConfig = {
      appid: this.appid,
      secret: this.secret,
      mode: this.mode === "webhook" ? ReceiverMode.WEBHOOK : ReceiverMode.WEBSOCKET,
      intents: this.currentIntents(),
      logLevel: "warn",
      timeout: 10000,
      maxRetry: 10,
      removeAt: true,
      handleProcessErrors: false,
      ...(config.api_base_url ? { apiBaseUrl: String(config.api_base_url) } : {}),
      ...(config.access_token_url ? { accessTokenUrl: String(config.access_token_url) } : {}),
      ...(config.gateway_url ? { gatewayUrl: String(config.gateway_url) } : {}),
    }
    if (this.mode === "webhook") {
      sdkConfig.port = Math.min(65535, Math.max(1, Number(config.webhook_port) || 6196))
      sdkConfig.path = String(config.webhook_path || "/QQBot")
      if (!sdkConfig.path.startsWith("/")) sdkConfig.path = `/${sdkConfig.path}`
    }

    if (Bot.bots[this.selfId]) return Bot.makeLog("error", [`QQ机器人 AppID ${this.selfId} 已存在同名 Bot，跳过加载`], this.id)
    this.sdk = new QQBot(sdkConfig)
    this.bindEvents()
    this.sdk.sessionManager?.on?.("max_retry_reached", () => {
      if (this.stopped) return
      Bot.makeLog("mark", "QQ机器人重连次数耗尽，准备重新启动", this.selfId)
      const wasStarted = this.started
      this.startToken += 1
      this.started = false
      if (!wasStarted && this.startAbort) this.startAbort(new Error("QQ机器人重连次数耗尽"))
      else this.scheduleStart()
    })
    this.bindReceiver()
    this.start().catch(err => this.handleStartError(err))
  }

  bindReceiver() {
    const receiver = this.sdk?.receiver
    if (!receiver || this.boundReceivers.has(receiver)) return
    this.boundReceivers.add(receiver)
    receiver.on?.("close", (code, reason) => this.onReceiverClose(code, reason))
  }

  currentIntents() {
    return this.customIntents || INTENT_SETS[Math.min(this.intentIndex, INTENT_SETS.length - 1)]
  }

  fallbackIntents() {
    if (this.customIntents || this.intentIndex >= INTENT_SETS.length - 1) return false
    this.intentIndex += 1
    if (this.sdk?.config) this.sdk.config.intents = this.currentIntents()
    return true
  }

  stop(msg, unregister = false) {
    this.stopped = true
    this.started = false
    this.startToken += 1
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (msg) Bot.makeLog("mark", msg, this.selfId)
    this.startAbort?.(new Error(msg || "QQ机器人已停止"))
    try {
      this.sdk?.sessionManager?.stop?.()
    } catch {}
    if (unregister) {
      if (Bot[this.selfId]?.adapter === this) delete Bot[this.selfId]
      const idx = Array.isArray(Bot.uin) ? Bot.uin.indexOf(this.selfId) : -1
      if (idx >= 0) Bot.uin.splice(idx, 1)
    }
  }

  stopForever(msg) {
    Bot.makeLog("error", msg, this.selfId)
    this.stop(undefined, true)
  }

  handleStartError(err) {
    if (this.stopped) return
    const retrySoon = this.intentRetry
    this.intentRetry = false
    if (!retrySoon) this.logError("QQ机器人启动失败", err)
    this.scheduleStart(retrySoon ? 1000 : undefined)
  }

  onReceiverClose(code, reason) {
    if (this.stopped || this.sdk.sessionManager?.userClose) return
    const numeric = Number(code)
    if (FATAL_CLOSE_CODES.includes(numeric)) return this.stopForever("QQ机器人已下架或封禁，停止自动重连")
    if (NON_RETRY_CLOSE_CODES.includes(numeric)) return this.stopForever(`QQ机器人 WebSocket 连接发生不可恢复错误 (${numeric}${reason ? `: ${reason}` : ""})，停止自动重连`)
    if (INTENT_CLOSE_CODES.includes(numeric) || /intent/i.test(String(reason || ""))) {
      const wasStarted = this.started
      this.startToken += 1
      this.started = false
      if (!this.fallbackIntents()) return this.stopForever(`QQ机器人订阅 Intent 被平台拒绝（${numeric || "intent"}），停止自动重连`)
      this.intentRetry = true
      if (!wasStarted && this.startAbort) this.startAbort(new Error(`QQ机器人 Intent 无权限${reason ? `：${reason}` : ""}`))
      else this.scheduleStart(1000)
      return
    }
    Bot.makeLog("mark", `QQ机器人连接已断开${code ? ` (${code})` : ""}，准备重连`, this.selfId)
    const wasStarted = this.started
    this.startToken += 1
    this.started = false
    if (!wasStarted && this.startAbort) this.startAbort(new Error("QQ机器人连接已关闭"))
    else this.scheduleStart()
  }

  scheduleStart(delay) {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    const wait = delay ?? this.retryDelay
    if (delay === undefined) this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX)
    this.retryTimer = setTimeout(() => {
      this.start().catch(err => this.handleStartError(err))
    }, wait)
    this.retryTimer.unref?.()
  }

  async start() {
    if (this.started || this.stopped) return
    const token = ++this.startToken
    this.intentRetry = false
    clearTimeout(this.retryTimer)
    this.bindReceiver()
    let abort
    const aborted = new Promise((_, reject) => (abort = reject))
    this.startAbort = abort
    const startPromise = this.sdk.start()
    startPromise.catch(() => {})
    let timer
    try {
      await Promise.race([
        startPromise,
        aborted,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("QQ机器人连接超时")), CONNECT_TIMEOUT)
          timer.unref?.()
        }),
      ])
    } catch (err) {
      try {
        await this.sdk.sessionManager?.stop?.()
      } catch {}
      throw err
    } finally {
      clearTimeout(timer)
      if (this.startAbort === abort) this.startAbort = null
    }
    if (token !== this.startToken || this.stopped) {
      try {
        await this.sdk.sessionManager?.stop?.()
      } catch {}
      return
    }
    this.bindReceiver()
    if (this.sdk.receiver?.isReady === false) throw new Error("QQ机器人连接未就绪")
    if (!this.setupBot()) return
    this.started = true
    this.retryDelay = RETRY_BASE
    await this.loadSelf()
    if (token !== this.startToken || !this.started) return
    Bot.makeLog("mark", `QQ机器人已连接：${this.nickname || this.selfId}（Intent: ${this.currentIntents().join(", ")}）`, this.selfId)
    try {
      Bot.em(`connect.${this.selfId}`, { self_id: this.selfId, time: Math.floor(Date.now() / 1000) })
    } catch (err) {
      this.logError("QQ机器人 connect 事件处理失败", err)
    }
  }

  async loadSelf() {
    try {
      const info = await this.retryAuth(() => this.sdk.getSelfInfo())
      if (info?.username) this.nickname = info.username
      if (info?.avatar) this.avatar = normalizeUrl(info.avatar)
      if (!this.sdk.self_id && info?.id) this.sdk.self_id = String(info.id)
    } catch (err) {
      Bot.makeLog("debug", ["获取机器人信息失败", errorText(err)], this.selfId)
    }
  }

  bindEvents() {
    const onMessage = event => Promise.resolve(this.onMessage(event)).catch(err => this.logError("处理 QQ机器人消息失败", err))
    for (const name of ["message.group", "message.private.friend"]) this.sdk.on(name, onMessage)

    const noticeMap = [
      ["notice.group.member.increase", e => this.onGroupMemberNotice(e, "increase")],
      ["notice.group.member.decrease", e => this.onGroupMemberNotice(e, "decrease")],
      ["notice.group.increase", e => this.onGroupChangeNotice(e, "increase")],
      ["notice.group.decrease", e => this.onGroupChangeNotice(e, "decrease")],
      ["notice.friend.increase", e => this.onFriendNotice(e, "increase")],
      ["notice.friend.decrease", e => this.onFriendNotice(e, "decrease")],
      ["notice.group.receive_open", e => this.onReceiveNotice(e, "group", "receive_open")],
      ["notice.group.receive_close", e => this.onReceiveNotice(e, "group", "receive_close")],
      ["notice.friend.receive_open", e => this.onReceiveNotice(e, "friend", "receive_open")],
      ["notice.friend.receive_close", e => this.onReceiveNotice(e, "friend", "receive_close")],
      ["notice.group.join_request", e => this.onGroupJoinRequest(e)],
      ["notice.group.subscribe", e => this.onSubscribeNotice(e, "group")],
      ["notice.friend.subscribe", e => this.onSubscribeNotice(e, "friend")],
      ["notice.group.action", e => this.onActionNotice(e, "group")],
      ["notice.friend.action", e => this.onActionNotice(e, "friend")],
    ]
    for (const [name, handler] of noticeMap) {
      this.sdk.on(name, event => {
        try {
          handler(event)
        } catch (err) {
          this.logError(`处理 QQ机器人 ${name} 事件失败`, err)
        }
      })
    }
  }

  async onMessage(event) {
    if (!event) return
    const messageId = String(event.message_id || event.id || event.event_id || "")
    if (messageId && this.isDuplicate(messageId)) return
    if (event.message_type === "group") return this.handleGroupMessage(event)
    if (event.message_type === "private") return this.handlePrivateMessage(event)
  }

  async handleGroupMessage(event) {
    const group_id = String(event.group_id || event.group_openid || "")
    const sender = event.sender || {}
    const author = event.author || {}
    const user_id = String(sender.user_openid || author.member_openid || author.user_openid || event.user_id || "")
    if (!group_id || !user_id) return

    const cachedGroup = this.gl.get(group_id) || {}
    let gml = this.gml.get(group_id)
    if (!gml) this.gml.set(group_id, (gml = new Map()))
    const cachedMember = gml.get(user_id) || {}

    const nickname = String(sender.user_name || sender.username || sender.nickname || author.username || sender.member_nickname || author.member_nickname || cachedMember.nickname || user_id)
    const card = String(sender.member_nickname || author.member_nickname || cachedMember.card || nickname)
    const avatar = normalizeUrl(sender.avatar || author.avatar) || cachedMember.avatar || ""
    const role = this.memberRole(sender.permissions || sender.member_role || author.member_role) || cachedMember.role || ""
    const union_openid = sender.union_openid || author.union_openid || cachedMember.union_openid
    const union_group_openid = event.union_group_openid || cachedGroup.union_group_openid
    const group_name = String(event.group_name || (cachedGroup.group_name && cachedGroup.group_name !== group_id ? cachedGroup.group_name : "") || group_id)
    if (!event.group_name && group_name === group_id) {
      void this.getGroupName(group_id).then(name => {
        const group = name && this.gl.get(group_id)
        if (group && (!group.group_name || group.group_name === group_id)) group.group_name = group.name = name
      })
    }

    const selfMention = (Array.isArray(event.mentions) ? event.mentions : []).find(m => this.isSelfMention(m, cachedGroup.botOpenid || ""))
    this.gl.set(group_id, {
      ...cachedGroup,
      group_id,
      group_name,
      name: group_name,
      ...(union_group_openid ? { union_group_openid: String(union_group_openid) } : {}),
      ...(selfMention?.member_openid ? { botOpenid: String(selfMention.member_openid) } : {}),
      ...(event.sub_type && event.sub_type !== "at" ? { allMessages: true } : {}),
    })

    const atBot = event.sub_type ? event.sub_type === "at" || this.detectSelfMention(event) : this.detectSelfMention(event) || this.gl.get(group_id)?.allMessages !== true
    const segments = this.convertSegments(event, atBot)
    const message_id = String(event.message_id || event.id || "")
    const msg_idx = event.msg_idx || extractSceneExt(event.message_scene?.ext, "msg_idx")
    const senderInfo = { user_id, nickname, card, avatar, ...(role ? { role } : {}), ...(union_openid ? { union_openid: String(union_openid) } : {}) }
    const raw_message = typeof event.raw_message === "string" && event.raw_message ? event.raw_message : this.describeElements(segments)

    gml.set(user_id, { ...cachedMember, ...senderInfo })
    gml.set(this.selfId, { ...(gml.get(this.selfId) || {}), user_id: this.selfId, nickname: this.botName, card: this.botName, avatar: this.avatar || "" })

    this.rememberMessage("group", group_id, { ...event, msg_idx })
    void this.refreshGroupState(group_id)
    Bot.makeLog("info", `群消息${atBot ? "[@]" : ""}：[${group_name}, ${card}] ${this.makeLog(raw_message)}`, `${this.selfId} <= ${group_id}, ${user_id}`, true)

    const interactionEventId = String(event.interaction_event_id || "")
    const data = {
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      self_id: this.selfId,
      user_id,
      group_id,
      group_name,
      ...(union_group_openid ? { union_group_openid: String(union_group_openid) } : {}),
      sender: senderInfo,
      message: segments,
      raw_message,
      message_id,
      msg_idx,
      time: this.eventTime(event),
      raw: this.rawEvent(event),
      ...(interactionEventId ? { interaction_event_id: interactionEventId, reply: msg => this.sendTo({ kind: "group", id: group_id }, msg, { eventId: interactionEventId }) } : {}),
    }
    data.message_seq = this.recordHistory("group", group_id, data)
    Bot.em("message.group.normal", data)
  }

  async handlePrivateMessage(event) {
    const sender = event.sender || {}
    const author = event.author || {}
    const user_id = String(sender.user_openid || author.user_openid || event.user_id || "")
    if (!user_id) return

    const cached = this.fl.get(user_id) || {}
    const nickname = String(sender.user_name || sender.username || sender.nickname || author.username || cached.nickname || user_id)
    const avatar = normalizeUrl(sender.avatar || author.avatar) || cached.avatar || ""
    const union_openid = sender.union_openid || author.union_openid || cached.union_openid
    const message_id = String(event.message_id || event.id || "")
    const msg_idx = event.msg_idx || extractSceneExt(event.message_scene?.ext, "msg_idx")
    const senderInfo = { user_id, nickname, card: nickname, avatar, ...(union_openid ? { union_openid: String(union_openid) } : {}) }
    const segments = this.convertSegments(event, false)
    const raw_message = typeof event.raw_message === "string" && event.raw_message ? event.raw_message : this.describeElements(segments)

    this.fl.set(user_id, { ...cached, ...senderInfo })
    this.rememberMessage("c2c", user_id, { ...event, msg_idx })
    Bot.makeLog("info", `好友消息：[${nickname}] ${this.makeLog(raw_message)}`, `${this.selfId} <= ${user_id}`, true)

    const interactionEventId = String(event.interaction_event_id || "")
    const data = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      self_id: this.selfId,
      user_id,
      sender: senderInfo,
      message: segments,
      raw_message,
      message_id,
      msg_idx,
      time: this.eventTime(event),
      raw: this.rawEvent(event),
      ...(interactionEventId ? { interaction_event_id: interactionEventId, reply: msg => this.sendTo({ kind: "c2c", id: user_id }, msg, { eventId: interactionEventId }) } : {}),
    }
    data.message_seq = this.recordHistory("c2c", user_id, data)
    Bot.em("message.private.friend", data)
  }

  emitNotice(type, sub_type, event, fields = {}) {
    Bot.em(`notice.${type}.${sub_type}`, {
      post_type: "notice",
      notice_type: type,
      sub_type,
      self_id: this.selfId,
      time: this.eventTime(event),
      raw: this.rawEvent(event),
      ...fields,
    })
  }

  onGroupMemberNotice(event, type) {
    const group_id = String(event.group_id || event.group_openid || "")
    const user_id = String(event.user_id || event.user_openid || event.member_openid || "")
    if (!group_id || !user_id) return
    this.emitNotice("group", type, event, {
      group_id,
      user_id,
      operator_id: event.operator_id || event.op_member_openid,
      ...(event.union_group_openid ? { union_group_openid: String(event.union_group_openid) } : {}),
    })
    if (type === "decrease") this.gml.get(group_id)?.delete(user_id)
  }

  onGroupChangeNotice(event, type) {
    const group_id = String(event.group_id || event.group_openid || "")
    if (!group_id) return
    const cached = this.gl.get(group_id)
    const group_name = cached?.group_name && cached.group_name !== group_id ? cached.group_name : group_id
    const union_group_openid = event.union_group_openid || cached?.union_group_openid
    if (type === "increase") {
      this.gl.set(group_id, { ...(cached || {}), group_id, group_name, name: group_name, ...(union_group_openid ? { union_group_openid: String(union_group_openid) } : {}) })
    }
    const target = { kind: "group", id: group_id }
    const eventId = String(event.notice_id || event.event_id || event.id || "")
    if (type === "increase" && eventId) this.registerEventSource(eventId)
    this.emitNotice("group", type, event, {
      group_id,
      group_name,
      user_id: this.selfId,
      operator_id: event.operator_id || event.op_member_openid,
      ...(union_group_openid ? { union_group_openid: String(union_group_openid) } : {}),
      ...(type === "increase" ? { reply: msg => this.sendTo(target, msg, { eventId }), sendMsg: msg => this.sendTo(target, msg, { eventId }) } : {}),
    })
    if (type === "increase") {
      void this.getGroupName(group_id).then(name => {
        const group = name && this.gl.get(group_id)
        if (group && (!group.group_name || group.group_name === group_id)) group.group_name = group.name = name
      })
      return
    }
    for (const map of [this.gl, this.gml, this.groupInfo, this.botStates, this.botMentionIds]) map.delete(group_id)
    this.passivePools.delete(`group:${group_id}`)
    this.histories.delete(`group:${group_id}`)
  }

  onFriendNotice(event, type) {
    const user_id = String(event.user_id || event.openid || "")
    if (!user_id) return
    const target = { kind: "c2c", id: user_id }
    const eventId = String(event.notice_id || event.event_id || event.id || "")
    if (type === "increase" && eventId) this.registerEventSource(eventId)
    this.emitNotice("friend", type, event, {
      user_id,
      ...(event.scene !== undefined ? { scene: event.scene } : {}),
      ...(event.scene_param !== undefined ? { scene_param: event.scene_param } : {}),
      ...(type === "increase" ? { reply: msg => this.sendTo(target, msg, { eventId }), sendMsg: msg => this.sendTo(target, msg, { eventId }) } : {}),
    })
    if (type === "decrease") {
      this.fl.delete(user_id)
      this.passivePools.delete(`c2c:${user_id}`)
      this.histories.delete(`c2c:${user_id}`)
    } else this.fl.set(user_id, { ...(this.fl.get(user_id) || {}), user_id })
  }

  onReceiveNotice(event, type, sub_type) {
    const group_id = type === "group" ? String(event.group_id || event.group_openid || "") : ""
    const operator_id = String(event.operator_id || event.op_member_openid || "")
    const user_id = String(type === "friend" ? event.user_id || event.openid || "" : operator_id)
    if (!sub_type || (type === "group" ? !group_id : !user_id)) return
    const target = type === "group" ? { kind: "group", id: group_id } : { kind: "c2c", id: user_id }
    const eventId = String(event.notice_id || event.event_id || event.id || "")
    if (sub_type === "receive_open" && eventId) this.registerEventSource(eventId)
    this.emitNotice(type, sub_type, event, {
      ...(group_id ? { group_id } : {}),
      ...(user_id ? { user_id } : {}),
      ...(operator_id ? { operator_id } : {}),
      ...(sub_type === "receive_open" ? { reply: msg => this.sendTo(target, msg, { eventId }), sendMsg: msg => this.sendTo(target, msg, { eventId }) } : {}),
    })
  }

  onGroupJoinRequest(event) {
    const group_id = String(event.group_id || event.group_openid || "")
    const user_id = String(event.user_id || event.apply_member_openid || event.member_openid || "")
    if (!group_id || !user_id) return
    const verify = event.verify_info
    const qaList = verify?.review_qa_list ?? verify?.admin_review_qa
    const comment = typeof verify === "string" ? verify : verify?.verify_message || (Array.isArray(qaList) ? qaList.map(i => [i.question, i.answer].filter(Boolean).join(": ")).join("\n") : "")
    Bot.em("request.group.add", {
      post_type: "request",
      request_type: "group",
      sub_type: "add",
      self_id: this.selfId,
      group_id,
      user_id,
      comment,
      verify_info: verify,
      ...(event.auto_approved !== undefined ? { auto_approved: event.auto_approved } : {}),
      flag: event.join_request_id,
      time: this.eventTime({ timestamp: event.apply_at ?? event.timestamp }),
      raw: this.rawEvent(event),
      approve: (approve = true, reason = "", addToBlacklist = false) =>
        this.retryAuth(() =>
          this.sdk.group(group_id).approveJoin(user_id, {
            op: approve ? "approve" : "decline",
            join_request_id: event.join_request_id,
            ...(!approve && reason ? { reject_reason: String(reason) } : {}),
            ...(!approve && addToBlacklist ? { add_to_blacklist: true } : {}),
          }),
        ),
    })
  }

  onSubscribeNotice(event, type) {
    const group_id = String(event.group_id || event.group_openid || "")
    const user_id = String(event.user_id || event.openid || "")
    if (type === "group" ? !group_id : !user_id) return
    this.emitNotice(type, "subscribe", event, {
      ...(group_id ? { group_id } : {}),
      ...(user_id ? { user_id } : {}),
      results: event.results || [],
      allowed: event.allowed || [],
      refused: event.refused || [],
    })
  }

  /** 按钮点击、快捷菜单等互动回调 */
  onActionNotice(event, type) {
    const group_id = type === "group" ? String(event.group_id || event.group_openid || "") : ""
    const user_id = String(event.operator_id || event.user_id || event.user_openid || event.data?.resolved?.user_id || "")
    const interactionId = String(event.id || event.notice_id || "")
    const eventId = String(event.notice_id || event.event_id || event.id || "")
    const interactionType = Number(event.interaction_type ?? event.type)
    const shouldAutoAck = !Number.isFinite(interactionType) || interactionType === 11 || interactionType === 12
    const buttonData = interactionType === 11 ? String(event.data?.resolved?.button_data || "").trim() : ""
    if (eventId) this.registerEventSource(eventId)

    let acked = false
    let ackTimer = null
    const replyAction = async (code = 0) => {
      if (ackTimer) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
      if (acked || event.replied) return
      acked = true
      try {
        if (typeof event.reply === "function") return await this.retryAuth(() => event.reply(code))
        if (interactionId) return await this.retryAuth(() => this.sdk.request.put(`/interactions/${encodeURIComponent(interactionId)}`, { code })).then(res => res.data)
      } catch (err) {
        acked = false
        throw err
      }
    }

    if (shouldAutoAck && (interactionId || typeof event.reply === "function")) {
      ackTimer = setTimeout(
        () => {
          ackTimer = null
          void replyAction(0).catch(err => Bot.makeLog("debug", ["互动事件自动回应失败", errorText(err)], this.selfId))
        },
        buttonData ? 0 : INTERACTION_ACK_DELAY,
      )
      ackTimer.unref?.()
    }

    if (!user_id || (type === "group" && !group_id)) return
    const target = type === "group" ? { kind: "group", id: group_id } : { kind: "c2c", id: user_id }
    const sendMsg = msg => this.sendTo(target, msg, { eventId })
    this.emitNotice(type, "action", event, {
      ...(group_id ? { group_id } : {}),
      user_id,
      operator_id: user_id,
      interaction_type: event.interaction_type ?? event.type,
      data: event.data,
      notice_id: event.notice_id ?? eventId,
      event_id: event.event_id ?? eventId,
      application_id: event.application_id,
      version: event.version,
      sendMsg,
      reply: sendMsg,
      replyAction,
    })

    if (!buttonData || (eventId && this.isDuplicate(`button:${eventId}`))) return
    const cached = type === "group" ? this.gml.get(group_id)?.get(user_id) : this.fl.get(user_id)
    const nickname = String(cached?.nickname || cached?.card || user_id)
    const card = String(cached?.card || nickname)
    const avatar = cached?.avatar || ""
    const union_openid = cached?.union_openid
    const role = cached?.role || ""
    const buttonEvent = {
      ...(type === "group" ? { group_id, group_openid: group_id, sub_type: "at" } : { user_id }),
      author: {
        member_openid: user_id,
        user_openid: user_id,
        username: nickname,
        member_nickname: card,
        avatar,
        ...(role ? { member_role: role } : {}),
        ...(union_openid ? { union_openid } : {}),
      },
      sender: {
        user_openid: user_id,
        user_name: nickname,
        member_nickname: card,
        avatar,
        ...(role ? { permissions: [role] } : {}),
        ...(union_openid ? { union_openid } : {}),
      },
      message: [{ type: "text", data: { text: buttonData } }],
      raw_message: buttonData,
      message_id: eventId,
      timestamp: this.eventTime(event),
      interaction_event_id: eventId,
    }
    void (type === "group" ? this.handleGroupMessage(buttonEvent) : this.handlePrivateMessage(buttonEvent)).catch(err => this.logError("处理按钮回调命令失败", err))
  }

  isDuplicate(message_id) {
    const now = Date.now()
    const time = this.seen.get(message_id)
    if (time && now - time < SEEN_TTL) return true
    if (this.seen.size >= SEEN_MAX) {
      for (const [key, value] of this.seen) if (now - value >= SEEN_TTL) this.seen.delete(key)
      capMap(this.seen, SEEN_MAX - 1)
    }
    this.seen.delete(message_id)
    this.seen.set(message_id, now)
    return false
  }

  memberRole(permissions) {
    const role = Array.isArray(permissions) ? permissions[0] : permissions
    return role === "owner" || role === "admin" ? role : role ? "member" : ""
  }

  eventTime(event) {
    const raw = event?.timestamp ?? event?.time
    const time = Number(raw)
    if (Number.isFinite(time) && time > 0) return Math.floor(time > 1e12 ? time / 1000 : time)
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000)
  }

  rawEvent(event) {
    try {
      if (typeof event?.toJSON === "function") return event.toJSON()
      const raw = { ...event }
      delete raw.bot
      return raw
    } catch {
      return event
    }
  }

  setBotMentionId(key, id) {
    if (!key || !id) return
    let ids = this.botMentionIds.get(key)
    if (ids) {
      this.botMentionIds.delete(key)
      this.botMentionIds.set(key, ids)
    } else {
      capMap(this.botMentionIds, BOT_MENTION_MAX - 1)
      this.botMentionIds.set(key, (ids = new Set()))
    }
    ids.add(String(id))
  }

  isSelfMention(mention, selfOpenid = "") {
    if (!mention || typeof mention !== "object") return false
    if (mention.is_you === true) return true
    if (mention.is_you === false || mention.bot === false) return false
    const ids = [mention.id, mention.member_openid, mention.user_openid].filter(Boolean).map(String)
    if (ids.includes(this.selfId) || (selfOpenid && ids.includes(String(selfOpenid))) || (this.sdk?.self_id && ids.includes(String(this.sdk.self_id)))) return true
    const name = this.nickname || this.sdk?.nickname || ""
    return Boolean(mention.bot === true && name && [mention.username, mention.member_nick, mention.member_nickname].some(v => v && String(v) === name))
  }

  detectSelfMention(event) {
    const key = String(event.group_id || event.group_openid || "")
    const selfOpenid = this.gl.get(key)?.botOpenid || ""
    for (const mention of Array.isArray(event.mentions) ? event.mentions : []) {
      if (!this.isSelfMention(mention, selfOpenid)) continue
      this.setBotMentionId(key, mention.id)
      return true
    }
    const ids = this.botMentionIds.get(key)
    if (!ids?.size && !selfOpenid) return false
    for (const elem of Array.isArray(event.message) ? event.message : [event.message]) {
      if (elem?.type !== "at") continue
      const id = String(elem.data?.user_id ?? elem.data?.member_openid ?? "")
      if (id && (id === selfOpenid || ids?.has(id))) return true
    }
    return false
  }

  convertSegments(event, atBot) {
    const list = Array.isArray(event.message) ? event.message : event.message ? [event.message] : []
    const key = String(event.group_id || event.group_openid || "")
    const selfMentionIds = this.botMentionIds.get(key)
    const selfOpenid = this.gl.get(key)?.botOpenid || ""
    const mentions = Array.isArray(event.mentions) ? event.mentions : []
    const segments = []
    const kind = event.group_id || event.group_openid ? "group" : "c2c"
    const convId = String(event.group_id || event.group_openid || event.sender?.user_openid || event.user_id || "")

    const pushText = text => {
      if (!text) return
      const last = segments[segments.length - 1]
      if (last?.type === "text") last.text += text
      else segments.push({ type: "text", text })
    }

    const pushAt = raw => {
      const id = String(raw ?? "")
      if (!id) return
      if (id === "all" || id === "everyone") return void segments.push({ type: "at", qq: "all", name: "全体成员" })
      const mention = mentions.find(item => String(item.id) === id || String(item.member_openid) === id || String(item.user_openid) === id)
      const isSelf = this.isSelfMention(mention, selfOpenid) || id === this.selfId || (selfOpenid && id === selfOpenid) || (this.sdk?.self_id && id === String(this.sdk.self_id)) || Boolean(selfMentionIds?.has(id))
      if (isSelf && mention?.id) this.setBotMentionId(key, mention.id)
      segments.push({ type: "at", qq: isSelf ? this.selfId : id, name: mention?.username || mention?.member_nickname || mention?.member_nick || "" })
    }

    const pushTextWithMentions = text => {
      if (!text) return
      let last = 0
      for (const m of text.matchAll(/<qqbot-at-user\s+[^>]*id=["']([^"']*)["'][^>]*\/?>|<qqbot-at-everyone[^>]*\/?>|<@!?([^>]+)>/g)) {
        pushText(text.slice(last, m.index))
        pushAt(m[0].startsWith("<qqbot-at-everyone") ? "all" : m[1] || m[2])
        last = m.index + m[0].length
      }
      pushText(text.slice(last))
    }

    for (const elem of list) {
      if (typeof elem === "string") {
        pushTextWithMentions(elem)
        continue
      }
      const data = elem?.data || {}
      switch (elem?.type) {
        case "text":
          pushTextWithMentions(data.text)
          break
        case "at":
          pushAt(data.user_id === "all" ? "all" : (data.user_id ?? data.member_openid))
          break
        case "face":
          segments.push({ type: "face", id: Number(data.id) })
          break
        case "image": {
          const url = normalizeUrl(data.url || data.file)
          segments.push({ type: "image", url, file: url, name: data.name, ...(data.width ? { width: data.width } : {}), ...(data.height ? { height: data.height } : {}), ...(data.size ? { size: data.size } : {}) })
          break
        }
        case "audio": {
          const url = normalizeUrl(data.voice_wav_url || data.url || data.file)
          segments.push({ type: "record", url, file: url, name: data.name, ...(data.asr_refer_text ? { asr_refer_text: data.asr_refer_text } : {}) })
          break
        }
        case "video":
        case "file": {
          const url = normalizeUrl(data.url || data.file)
          segments.push({ type: elem.type, url, file: url, name: data.name, ...(elem.type === "file" ? { size: data.size } : {}) })
          break
        }
        case "reply": {
          const refIdx = String(data.ref_idx || data.id || "")
          const quoted = refIdx && convId ? this.getMsg(kind, convId, refIdx) : null
          segments.push({ type: "reply", id: quoted?.message_id || refIdx, ref_idx: data.ref_idx || refIdx })
          break
        }
        case "markdown":
          pushTextWithMentions(data.content || "")
          break
      }
    }

    if (!segments.some(item => item.type === "reply")) {
      const refMsgIdx = extractSceneExt(event.message_scene?.ext, "ref_msg_idx")
      if (refMsgIdx) {
        const quoted = convId ? this.getMsg(kind, convId, refMsgIdx) : null
        segments.unshift({ type: "reply", id: quoted?.message_id || refMsgIdx, ref_idx: refMsgIdx })
      }
    }

    if (atBot && !segments.some(item => item.type === "at" && item.qq === this.selfId)) segments.unshift({ type: "at", qq: this.selfId, name: this.botName })
    return segments
  }

  entity(target) {
    if (target.kind === "group") return this.sdk.group(target.id)
    if (target.kind === "c2c") return this.sdk.user(target.id)
    throw new Error(`未知发送目标：${target.kind}`)
  }

  targetApi(target) {
    return {
      sendMsg: msg => this.sendTo(target, msg),
      sendFile: (file, name) => this.sendTo(target, { type: "file", file, name }),
      sendForwardMsg: msg => this.sendTo(target, { type: "node", data: Array.isArray(msg?.data) ? msg.data : Array.isArray(msg) ? msg : [msg] }),
      recallMsg: message_id => this.recallMsg(target, message_id),
    }
  }

  registerEventSource(eventId) {
    const key = String(eventId || "")
    if (!key || this.eventSources.has(key)) return
    const now = Date.now()
    this.pruneEventSources(now)
    capMap(this.eventSources, EVENT_SOURCE_MAX - 1)
    this.eventSources.set(key, { time: now, used: 0, dead: false })
  }

  createSourceProvider(target, eventId, force = false) {
    if (!this.passiveReply && !force) return null
    const key = String(eventId || "")
    if (!key) {
      return {
        next: () => this.pickMessageSource(target),
        drop: (source, expired) => this.dropMessageSource(target, source, expired),
      }
    }
    const now = Date.now()
    this.pruneEventSources(now)
    let entry = this.eventSources.get(key)
    if (!entry) {
      capMap(this.eventSources, EVENT_SOURCE_MAX - 1)
      this.eventSources.set(key, (entry = { time: now, used: 0, dead: false }))
    }
    const limit = this.passiveLimit(target)
    return {
      next: () => {
        if (entry.dead || Date.now() - entry.time >= PASSIVE_TTL || entry.used >= limit) {
          entry.dead = true
          this.eventSources.delete(key)
          return undefined
        }
        return { event_id: key, seq: ++entry.used }
      },
      drop: () => {
        entry.dead = true
        this.eventSources.delete(key)
      },
    }
  }

  passiveLimit(target) {
    if (target.kind === "c2c") return C2C_PASSIVE_LIMIT
    const role = this.gml.get(target.id)?.get(this.selfId)?.role || this.botStates.get(target.id)?.state?.member_role || ""
    return role === "owner" || role === "admin" ? GROUP_ADMIN_PASSIVE_LIMIT : GROUP_PASSIVE_LIMIT
  }

  pruneEventSources(now) {
    for (const [key, entry] of this.eventSources) if (entry.dead || now - entry.time >= PASSIVE_TTL) this.eventSources.delete(key)
  }

  prunePassivePools(now) {
    for (const [key, list] of this.passivePools) {
      while (list.length && (list[0].dead || now - list[0].time >= PASSIVE_TTL)) list.shift()
      if (!list.length) this.passivePools.delete(key)
    }
    capMap(this.passivePools, PASSIVE_CONVERSATIONS_MAX)
  }

  rememberMessage(kind, id, event) {
    if (event?.interaction_event_id) return
    const message_id = String(event?.message_id || event?.id || "")
    if (!id || !message_id) return
    const now = Date.now()
    let entry = this.messageRefs.get(message_id)
    if (entry) {
      if (!entry.msg_idx && event.msg_idx) entry.msg_idx = event.msg_idx
    } else {
      this.messageRefs.set(message_id, (entry = { id: message_id, msg_idx: event.msg_idx, time: now, used: 0 }))
      this.pruneMessageRefs(now)
    }
    const key = `${kind}:${id}`
    let list = this.passivePools.get(key)
    if (list) {
      this.passivePools.delete(key)
      this.passivePools.set(key, list)
    } else {
      this.prunePassivePools(now)
      capMap(this.passivePools, PASSIVE_CONVERSATIONS_MAX - 1)
      this.passivePools.set(key, (list = []))
    }
    while (list.length && (list[0].dead || now - list[0].time >= PASSIVE_TTL)) list.shift()
    if (!entry.dead && !list.some(item => item.id === message_id)) list.push(entry)
    if (list.length > PASSIVE_POOL_MAX) list.splice(0, list.length - PASSIVE_POOL_MAX)
  }

  toHistorySegments(elements) {
    const segs = []
    for (const el of elements) {
      if (!el || el.type === "reply") continue
      const d = el.data || {}
      if (el.type === "text") segs.push({ type: "text", text: d.text ?? el.text ?? "" })
      else if (el.type === "at") segs.push({ type: "at", qq: String(d.user_id ?? "") })
      else if (el.type === "face") segs.push({ type: "face", id: Number(d.id) || 0 })
      else if (el.type === "markdown") segs.push({ type: "markdown", data: { ...d } })
      else if (el.type === "audio") segs.push({ type: "record", ...(typeof d.url === "string" ? { url: d.url } : {}), ...(d.name ? { name: d.name } : {}) })
      else if (el.type === "image" || el.type === "video" || el.type === "file") {
        segs.push({ type: el.type, ...(typeof d.url === "string" ? { url: d.url } : typeof d.file === "string" ? { file: d.file } : {}), ...(d.name || el.name ? { name: d.name || el.name } : {}) })
      } else segs.push({ type: el.type })
    }
    return segs
  }

  rememberSentMessage(target, result, elements = []) {
    const message_id = String(result?.id || result?.message_id || "")
    if (!target?.id || !message_id) return
    const msg_idx = result?.ext_info?.ref_idx ? String(result.ext_info.ref_idx) : ""
    const now = Date.now()
    if (msg_idx) {
      this.messageRefs.delete(message_id)
      this.messageRefs.set(message_id, { id: message_id, msg_idx, time: now, used: 0 })
      this.pruneMessageRefs(now)
    }
    this.recordHistory(target.kind, target.id, {
      message_id,
      user_id: this.selfId,
      ...(target.kind === "group" ? { group_id: target.id } : {}),
      time: this.eventTime({ timestamp: result?.timestamp }),
      sender: { user_id: this.selfId, nickname: this.botName, card: this.botName, avatar: this.avatar || "" },
      message: this.toHistorySegments(elements),
      raw_message: this.describeElements(elements),
      msg_idx,
    })
  }

  pruneMessageRefs(now) {
    if (this.messageRefs.size <= MESSAGE_REF_MAX) return
    for (const [key, entry] of this.messageRefs) if (now - entry.time >= PASSIVE_TTL) this.messageRefs.delete(key)
    capMap(this.messageRefs, MESSAGE_REF_MAX)
  }

  pickMessageSource(target) {
    const key = `${target.kind}:${target.id}`
    const list = this.passivePools.get(key)
    if (!list?.length) return undefined
    const limit = this.passiveLimit(target)
    const now = Date.now()
    while (list.length) {
      const entry = list[list.length - 1]
      if (entry.dead || now - entry.time >= PASSIVE_TTL || entry.used >= limit) {
        list.pop()
        continue
      }
      return { id: entry.id, seq: ++entry.used, entry }
    }
    this.passivePools.delete(key)
    return undefined
  }

  dropMessageSource(target, source, expired = false) {
    const key = `${target.kind}:${target.id}`
    const list = this.passivePools.get(key)
    if (!list || !source?.entry) return
    if (expired) {
      for (const item of list) if (item.time <= source.entry.time) item.dead = true
    } else source.entry.dead = true
    const remaining = list.filter(item => !item.dead)
    if (remaining.length) this.passivePools.set(key, remaining)
    else this.passivePools.delete(key)
  }

  getMessageRef(message_id) {
    const key = String(message_id || "")
    const entry = key ? this.messageRefs.get(key) : undefined
    if (!entry) return undefined
    if (Date.now() - entry.time >= PASSIVE_TTL) {
      this.messageRefs.delete(key)
      return undefined
    }
    return entry
  }

  recordHistory(kind, id, data) {
    if (!id) return 0
    const key = `${kind}:${id}`
    let entry = this.histories.get(key)
    if (entry) {
      this.histories.delete(key)
      this.histories.set(key, entry)
    } else {
      capMap(this.histories, HISTORY_CONVERSATIONS - 1)
      this.histories.set(key, (entry = { seq: 0, messages: [] }))
    }
    const message_seq = ++entry.seq
    entry.messages.push({
      message_id: data.message_id,
      message_seq,
      user_id: data.user_id,
      group_id: data.group_id,
      time: data.time,
      sender: { ...data.sender },
      message: Array.isArray(data.message) ? data.message.map(s => ({ ...s })) : data.message,
      raw_message: data.raw_message,
      msg_idx: data.msg_idx,
    })
    if (entry.messages.length > HISTORY_MAX) entry.messages.splice(0, entry.messages.length - HISTORY_MAX)
    return message_seq
  }

  copyHistoryMessage(item) {
    return { ...item, sender: { ...item.sender }, message: Array.isArray(item.message) ? item.message.map(s => ({ ...s })) : item.message }
  }

  getChatHistory(kind, id, message_seq, count = 20, reverseOrder = true) {
    const list = this.histories.get(`${kind}:${id}`)?.messages
    if (!list?.length) return []
    let end = list.length
    const seq = Number(message_seq)
    if (Number.isFinite(seq) && seq > 0) {
      const idx = list.findIndex(item => item.message_seq === seq)
      if (idx >= 0) end = idx + 1
      else {
        const timeIdx = list.findIndex(item => item.time > seq)
        if (timeIdx >= 0) end = timeIdx
      }
    }
    const size = Math.min(HISTORY_MAX, Math.max(1, Number(count) || 20))
    const result = list.slice(Math.max(0, end - size), end).map(item => this.copyHistoryMessage(item))
    return reverseOrder === false ? result.reverse() : result
  }

  getMsg(kind, id, message_id) {
    const list = this.histories.get(`${kind}:${id}`)?.messages
    const key = String(message_id || "")
    if (!list || !key) return null
    const found = list.find(item => String(item.message_id) === key || (item.msg_idx && String(item.msg_idx) === key))
    return found ? this.copyHistoryMessage(found) : null
  }

  normalizeSegment(segment) {
    if (segment == null) return null
    if (typeof segment !== "object") return { type: "text", text: String(segment) }
    const data = segment.data && typeof segment.data === "object" && !Array.isArray(segment.data) ? segment.data : null
    const raw = typeof segment.data === "string" || typeof segment.data === "number" ? segment.data : undefined
    switch (segment.type) {
      case "text":
        return { type: "text", text: String(segment.text ?? data?.text ?? raw ?? "") }
      case "at":
        return { type: "at", qq: String(segment.qq ?? data?.qq ?? raw ?? ""), name: segment.name ?? data?.name ?? "" }
      case "reply":
        return { type: "reply", id: String(segment.id ?? data?.id ?? raw ?? ""), ref_idx: segment.ref_idx ?? data?.ref_idx }
      case "image":
      case "record":
      case "audio":
      case "video":
      case "file":
        return {
          type: segment.type === "audio" ? "record" : segment.type,
          file: segment.file ?? segment.url ?? data?.file ?? data?.url ?? raw,
          url: segment.url ?? data?.url,
          name: segment.name ?? data?.name ?? segment.file_name ?? data?.file_name,
        }
      case "node": {
        const v = segment.data ?? data?.data ?? (segment.message !== undefined || segment.content !== undefined ? segment : undefined)
        return { type: "node", data: Array.isArray(v) ? v : v ? [v] : [] }
      }
      case "markdown": {
        const base = segment.data ?? data?.data ?? (segment.content !== undefined || segment.custom_template_id !== undefined || segment.params !== undefined ? segment : undefined)
        if (!base || typeof base !== "object") return { type: "markdown", data: base }
        const md = { ...base }
        if (md.type === "markdown") delete md.type
        if (segment.keyboard && !md.keyboard) md.keyboard = segment.keyboard
        if (segment.buttons && !md.buttons) md.buttons = segment.buttons
        return { type: "markdown", data: md }
      }
      case "card": {
        const rawCard = segment.data ?? data ?? segment.content ?? (segment.title || segment.url || segment.pic_url ? segment : undefined)
        if (!rawCard || typeof rawCard !== "object") return { type: "card", data: rawCard }
        const cardData = { ...rawCard }
        if (cardData.type === "card") delete cardData.type
        return { type: "card", data: cardData }
      }
      case "keyboard": {
        const v = segment.data ?? data?.data ?? segment.id ?? (segment.content ? { content: segment.content } : segment.rows ? { content: { rows: segment.rows } } : undefined)
        return { type: "keyboard", data: typeof v === "string" || typeof v === "number" ? { id: String(v) } : v }
      }
      case "button":
        return {
          type: "button",
          data: segment.data ?? segment.buttons ?? data?.data ?? (segment.rows ? { rows: segment.rows } : segment.text != null || segment.label != null ? segment : undefined),
        }
      case "face":
        return { type: "face", id: Number(segment.id ?? data?.id ?? raw) }
      default:
        return segment
    }
  }

  buildKeyboardElements(segments) {
    const buttonElements = []
    let templateKeyboard = null
    let index = 0
    const nextId = () => `btn_${Date.now().toString(36)}_${++index}`

    const pushRow = row => {
      const buttons = row.map(item => normalizeButton(item, nextId)).filter(Boolean)
      for (let i = 0; i < buttons.length && buttonElements.length < KEYBOARD_MAX_ROWS; i += KEYBOARD_MAX_COLS) buttonElements.push({ type: "button", data: { buttons: buttons.slice(i, i + KEYBOARD_MAX_COLS) } })
    }
    const pushRows = rows => {
      const list = Array.isArray(rows) && rows.length && Array.isArray(rows[0]) ? rows : [rows]
      for (const row of list) pushRow(Array.isArray(row) ? row : [row])
    }

    for (const segment of segments) {
      if (segment.type === "keyboard") {
        const data = typeof segment.data === "string" || typeof segment.data === "number" ? { id: String(segment.data) } : segment.data
        if (Array.isArray(data?.content?.rows)) pushRows(data.content.rows)
        else if (Array.isArray(data?.rows)) pushRows(data.rows)
        else if (data && (data.id || data.content)) templateKeyboard = { type: "keyboard", data }
        continue
      }
      const value = segment.data
      if (Array.isArray(value)) {
        if (value.some(Array.isArray)) for (const row of value) pushRow(Array.isArray(row) ? row : [row])
        else pushRow(value)
      } else if (value && typeof value === "object" && (Array.isArray(value.rows) || Array.isArray(value.buttons))) {
        pushRows(value.rows || value.buttons)
      } else {
        const button = normalizeButton(value, nextId)
        if (button) pushRow([button])
      }
    }
    return buttonElements.length ? buttonElements : templateKeyboard ? [templateKeyboard] : []
  }

  buildInlineBatches(elements) {
    const batches = []
    let batch = []
    let length = 0
    const commit = () => {
      if (!batch.length) return
      batches.push(batch)
      batch = []
      length = 0
    }
    for (const element of elements) {
      if (element.type === "text") {
        let rest = sanitizeText(element.data?.text ?? element.text ?? "")
        while (rest.length) {
          if (TEXT_LIMIT - length <= 0) {
            commit()
            continue
          }
          const [part, remain] = splitText(rest, TEXT_LIMIT - length)
          rest = remain
          batch.push(sdkSegment.text(part))
          length += part.length
          if (length >= TEXT_LIMIT) commit()
        }
      } else {
        if (length >= TEXT_LIMIT) commit()
        batch.push(element)
        length += 1
      }
    }
    commit()
    return batches
  }

  async uploadMarkdownImage(segment) {
    try {
      const buffer = await readSource(segment.file ?? segment.url, IMAGE_MAX_BYTES, "图片")
      const info = detectImageInfo(buffer)
      if (!info) return null
      const uploaded = await this.retryAuth(() => this.sdk.uploadMaterialImage(buffer, { fileName: `image${info.ext}` }))
      return uploaded?.image_id && uploaded?.url ? { imageId: uploaded.image_id, url: uploaded.url, width: info.width, height: info.height } : null
    } catch (err) {
      Bot.makeLog("debug", ["上传 Markdown 图片素材失败，改为普通图片发送", errorText(err)], this.selfId)
      return null
    }
  }

  releaseMaterials(materials) {
    for (const m of materials) void this.retryAuth(() => this.sdk.deleteMaterialImage(m.imageId)).catch(err => Bot.makeLog("debug", ["删除 Markdown 图片素材失败", m.imageId, errorText(err)], this.selfId))
  }

  mergeSendResults(results) {
    const done = results.filter(Boolean)
    if (done.length <= 1) return done[0] || null
    return { data: done, message_id: done.map(item => item?.id ?? item?.message_id).filter(Boolean) }
  }

  async sendWithKeyboard(target, segments, options) {
    let markdown = null
    const inlineSegments = []
    const rest = []
    const keyboards = []

    for (const segment of segments) {
      switch (segment.type) {
        case "keyboard":
        case "button":
          keyboards.push(segment)
          break
        case "reply":
          rest.push(segment)
          break
        case "markdown": {
          const v = typeof segment.data === "string" ? { content: segment.data } : { ...(segment.data || {}) }
          if (!markdown) markdown = v
          else if (v.content) markdown.content = [markdown.content, v.content].filter(Boolean).join("\n")
          break
        }
        case "text":
          if (segment.text) inlineSegments.push(segment)
          break
        case "at":
          if (target.kind === "group" && segment.qq && segment.qq !== this.selfId && segment.qq !== String(this.sdk?.self_id || "") && segment.qq !== this.gl.get(target.id)?.botOpenid) inlineSegments.push(segment)
          break
        case "node": {
          const v = this.forwardText(segment.data)
          if (v) inlineSegments.push({ type: "text", text: v })
          break
        }
        case "face":
          break
        default:
          rest.push(segment)
      }
    }

    if (inlineSegments.length) {
      if (markdown?.custom_template_id) rest.push(...inlineSegments)
      else {
        const value = inlineSegments.map(s => (s.type === "text" ? sanitizeText(s.text) : s.qq === "all" ? "<qqbot-at-everyone />" : `<qqbot-at-user id="${String(s.qq).replace(/["<>]/g, "")}" />`)).join("")
        if (!markdown) markdown = { content: value }
        else markdown.content = markdown.content ? `${markdown.content}\n${value}` : value
      }
    }

    const keyboardElements = this.buildKeyboardElements(keyboards)
    if (!keyboardElements.length) {
      return this.sendTo(
        target,
        segments.filter(item => item.type !== "keyboard" && item.type !== "button"),
        options,
      )
    }

    const baseContent = typeof markdown?.content === "string" ? markdown.content : ""
    const embedded = []
    if (!markdown?.custom_template_id) {
      for (const segment of rest.filter(item => item.type === "image").slice(0, MATERIAL_MAX_IMAGES)) {
        const material = await this.uploadMarkdownImage(segment)
        if (material) embedded.push({ segment, ...material })
      }
      if (embedded.length) {
        const imagesMd = embedded.map((item, idx) => `![图片${idx + 1}${item.width > 0 && item.height > 0 ? ` #${item.width}px #${item.height}px` : ""}](${item.url})`).join("\n")
        if (!markdown) markdown = { content: imagesMd }
        else markdown.content = baseContent && baseContent !== EMPTY_MARKDOWN ? `${baseContent}\n${imagesMd}` : imagesMd
        markdown.force_verify_image_resource = true
        for (const item of embedded) {
          const idx = rest.indexOf(item.segment)
          if (idx >= 0) rest.splice(idx, 1)
        }
      }
    }

    if (!markdown) markdown = { content: EMPTY_MARKDOWN }
    else if (!markdown.content && !markdown.custom_template_id) markdown.content = EMPTY_MARKDOWN

    const reply = rest.find(item => item.type === "reply")
    const remaining = rest.filter(item => item.type !== "reply")
    const hasMedia = remaining.some(item => ["image", "video", "record", "file", "card"].includes(item.type))
    const results = []
    if (hasMedia) {
      try {
        results.push(await this.sendTo(target, reply ? [reply, ...remaining] : remaining, options))
      } catch (err) {
        this.releaseMaterials(embedded)
        throw err
      }
    }

    const context = { reply: null, replyUsed: false, eventId: options.eventId, provider: this.createSourceProvider(target, options.eventId) }
    if (reply && !hasMedia) this.applyReply(reply, context)
    const sendPayload = async elems => {
      const res = await this.sendEntities(target, context.reply && !context.replyUsed ? [context.reply, ...elems] : elems, context)
      if (context.reply) context.replyUsed = true
      results.push(res)
    }

    let sendImagesSeparately = false
    let curMarkdown = markdown
    let curKeyboards = keyboardElements
    let sentChunks = 0
    try {
      while (true) {
        try {
          if (!curKeyboards.length && !curMarkdown.custom_template_id && (!curMarkdown.content || curMarkdown.content === EMPTY_MARKDOWN)) break
          const chunks = !curMarkdown.custom_template_id && typeof curMarkdown.content === "string" ? splitMarkdown(curMarkdown.content, MARKDOWN_LIMIT) : [curMarkdown.content]
          for (let i = sentChunks; i < chunks.length; i++) {
            const md = { ...curMarkdown, ...(chunks[i] !== undefined ? { content: chunks[i] } : {}) }
            const elems = i === chunks.length - 1 ? [{ type: "markdown", data: md }, ...curKeyboards] : [{ type: "markdown", data: md }]
            await sendPayload(elems)
            sentChunks = i + 1
          }
          break
        } catch (err) {
          const msg = errorText(err)
          if (embedded.length && !sendImagesSeparately && IMAGE_RESOURCE_ERROR.test(msg)) {
            Bot.makeLog("warn", ["Markdown 图片资源校验失败，改为图片分开发送", msg], this.selfId)
            sendImagesSeparately = true
            curMarkdown = { ...curMarkdown, content: baseContent || EMPTY_MARKDOWN }
            delete curMarkdown.force_verify_image_resource
            sentChunks = 0
            continue
          }
          if (curKeyboards.length && KEYBOARD_ERROR.test(msg) && !MARKDOWN_ERROR.test(msg)) {
            Bot.makeLog("warn", ["未开通自定义按钮或按钮参数受限，已降级为无按钮 Markdown", msg], this.selfId)
            curKeyboards = []
            continue
          }
          if (!MARKDOWN_ERROR.test(msg)) throw err
          Bot.makeLog("warn", ["按钮消息需要 Markdown 权限，已降级为纯文本", msg], this.selfId)
          if (embedded.length) sendImagesSeparately = true
          const plainText = stripMarkdownTags(baseContent).trim()
          if (plainText && plainText !== EMPTY_MARKDOWN && !curMarkdown.custom_template_id) {
            const useReply = reply && !hasMedia && !context.replyUsed
            results.push(await this.sendTo(target, useReply ? [reply, { type: "text", text: plainText }] : plainText, options))
            if (useReply) context.replyUsed = true
          }
          break
        }
      }
    } finally {
      this.releaseMaterials(embedded)
    }

    if (sendImagesSeparately) {
      const segs = embedded.map(item => item.segment)
      results.push(await this.sendTo(target, reply && !hasMedia && !context.replyUsed ? [reply, ...segs] : segs, options))
    }
    if (remaining.length && !hasMedia) results.push(await this.sendTo(target, remaining, options))
    return this.mergeSendResults(results)
  }

  async sendTo(target, msg, options = {}) {
    if (!target?.id) throw new Error("发送目标为空")
    const segments = []
    for (const item of Array.isArray(msg) ? msg : [msg]) {
      const seg = this.normalizeSegment(item)
      if (!seg) continue
      if (seg.type === "markdown" && seg.data && typeof seg.data === "object") {
        const { keyboard, buttons, ...rest } = seg.data
        segments.push({ type: "markdown", data: rest })
        if (keyboard) segments.push({ type: "keyboard", data: keyboard })
        if (buttons) segments.push({ type: "button", data: buttons })
      } else segments.push(seg)
    }

    if (segments.some(item => item.type === "keyboard" || item.type === "button")) {
      if (!this.replyText) return this.sendWithKeyboard(target, segments, options)
      Bot.makeLog("debug", ["普通消息模式已丢弃按钮"], this.selfId)
      return this.sendTo(
        target,
        segments.filter(item => item.type !== "keyboard" && item.type !== "button"),
        options,
      )
    }

    const context = { reply: null, replyUsed: false, eventId: options.eventId, provider: this.createSourceProvider(target, options.eventId) }
    const replySeg = segments.find(item => item.type === "reply")
    if (replySeg) this.applyReply(replySeg, context)
    const results = []
    let inline = []

    const sendBatch = async elements => {
      if (!elements.length) return
      if (context.reply && !context.replyUsed) {
        elements = [context.reply, ...elements]
        context.replyUsed = true
      }
      results.push(await this.dispatchSend(target, elements, context))
    }

    const flushInline = async () => {
      if (!inline.length) return
      for (const batch of this.buildInlineBatches(inline)) await sendBatch(batch)
      inline = []
    }

    for (const segment of segments) {
      if (segment.type === "reply") continue
      switch (segment.type) {
        case "text":
          inline.push(sdkSegment.text(segment.text))
          break
        case "at":
          if (target.kind === "group" && segment.qq && segment.qq !== this.selfId && segment.qq !== String(this.sdk?.self_id || "") && segment.qq !== this.gl.get(target.id)?.botOpenid && (!this.replyText || segment.qq === "all")) inline.push(sdkSegment.at(segment.qq))
          break
        case "face":
          inline.push(sdkSegment.face(Number(segment.id) || 0))
          break
        case "node": {
          const text = this.forwardText(segment.data)
          if (text) inline.push(sdkSegment.text(text))
          break
        }
        case "markdown": {
          const v = segment.data
          if (this.replyText) {
            const text = stripMarkdownTags(typeof v === "string" ? v : v?.content || "").trim()
            if (text) inline.push(sdkSegment.text(text))
            else Bot.makeLog("debug", ["普通消息模式无法转换该 Markdown 段，已跳过"], this.selfId)
            break
          }
          await flushInline()
          const base = typeof v === "string" ? { content: v } : { ...(v || {}) }
          if (base.custom_template_id) await sendBatch([{ type: "markdown", data: base }])
          else if (base.content) {
            for (const chunk of splitMarkdown(base.content, MARKDOWN_LIMIT)) await sendBatch([{ type: "markdown", data: { ...base, content: chunk } }])
          }
          break
        }
        case "card": {
          await flushInline()
          const card = segment.data?.content ?? segment.data
          if (card) await sendBatch([sdkSegment.card(card)])
          break
        }
        case "image":
        case "video": {
          const src = segment.file ?? segment.url
          if (!src) break
          await flushInline()
          await sendBatch([sdkSegment[segment.type](src, { url: segment.url, name: segment.name })])
          break
        }
        case "record": {
          const src = segment.file ?? segment.url
          if (!src) break
          await flushInline()
          const base = path.basename(String(segment.name || "voice"), path.extname(String(segment.name || ""))) || "voice"
          await sendBatch([sdkSegment.audio(await toSilk(src, segment.name || "voice"), { name: `${base}.silk` })])
          break
        }
        case "file":
          await flushInline()
          results.push(await this.sendFileTo(target, segment, context))
          break
        default:
          Bot.makeLog("debug", [`QQ机器人不支持 ${segment.type} 消息，已跳过`], this.selfId)
      }
    }
    await flushInline()
    return this.mergeSendResults(results)
  }

  applyReply(segment, context) {
    const id = String(segment.id || "")
    const refIdx = String(segment.ref_idx || "")
    if (!id && !refIdx) return
    const ref = id ? this.getMessageRef(id) : undefined
    if (ref?.msg_idx) context.reply = sdkSegment.reply({ ref_idx: ref.msg_idx })
    else if (refIdx || /^REFIDX_/i.test(id)) context.reply = sdkSegment.reply({ ref_idx: refIdx || id })
    else Bot.makeLog("debug", ["QQ机器人无法引用该消息", id], this.selfId)
  }

  async dispatchSend(target, elements, context) {
    try {
      return await this.sendEntities(target, elements, context)
    } catch (err) {
      if (!MARKDOWN_ERROR.test(errorText(err))) throw err
      const replyEl = elements.find(item => item.type === "reply")
      const plainBody = elements.flatMap(item => {
        if (item.type === "reply") return []
        if (item.type === "markdown") {
          const text = stripMarkdownTags(item.data?.content || "").trim()
          return text ? [sdkSegment.text(text)] : []
        }
        if (item.type === "at" && item.data?.user_id !== "all") return []
        return [item]
      })
      if (!plainBody.length) throw err
      const batches = this.buildInlineBatches(plainBody)
      const results = []
      for (let i = 0; i < batches.length; i++) {
        const batch = i === 0 && replyEl ? [replyEl, ...batches[i]] : batches[i]
        results.push(await this.sendEntities(target, batch, context))
      }
      return this.mergeSendResults(results)
    }
  }

  async retryAuth(fn) {
    try {
      return await fn()
    } catch (err) {
      if (!isAuthError(err)) throw err
      Bot.makeLog("debug", ["Authorization 失效，刷新令牌后重试", errorText(err)], this.selfId)
      if (!this.tokenRefreshPromise) {
        this.tokenRefreshPromise = Promise.resolve()
          .then(() => this.sdk.sessionManager.getAccessToken())
          .finally(() => (this.tokenRefreshPromise = null))
      }
      await this.tokenRefreshPromise
      return fn()
    }
  }

  async sendWithRetry(target, context, sendFn, allowActive = true) {
    let source = context.provider?.next()
    let activeFailed = false
    for (let dedup = 0, passive = 0; ;) {
      if (!source && !allowActive) throw new Error("发送输入状态需要有效的被动回复来源")
      try {
        return await this.retryAuth(() => sendFn(source))
      } catch (err) {
        const msg = errorText(err)
        if (!source) {
          if (!ACTIVE_ERROR.test(msg)) throw err
          activeFailed = true
          context.provider ||= this.createSourceProvider(target, context.eventId, true)
          source = context.provider?.next()
          if (!source) throw err
          if (!this.passiveReply && !this.activeWarned) {
            this.activeWarned = true
            Bot.makeLog("warn", ["主动消息无权限，已自动改用被动回复；建议将 passive_reply 设为 true"], this.selfId)
          }
        } else if (DEDUP_ERROR.test(msg) && dedup++ < MAX_SEQ_RETRIES) {
          Bot.makeLog("debug", [`msg_seq 重复，换号重试 (${dedup}/${MAX_SEQ_RETRIES})`, msg], this.selfId)
          source = context.provider?.next()
          if (!source && (activeFailed || !allowActive)) throw err
        } else if (PASSIVE_ERROR.test(msg)) {
          context.provider?.drop(source, EXPIRED_ERROR.test(msg))
          source = passive++ < 2 ? context.provider?.next() : undefined
          if (!source && (activeFailed || !allowActive)) throw err
          Bot.makeLog("debug", [source ? "被动来源失效，尝试下一条" : "被动回复失败，改为主动发送", msg], this.selfId)
        } else {
          throw err
        }
      }
    }
  }

  async sendEntities(target, elements, context) {
    const entity = this.entity(target)
    const label = { group: "群", c2c: "好友" }[target.kind] || target.kind
    Bot.makeLog("info", `发送${label}消息：${this.makeLog(this.describeElements(elements))}`, `${this.selfId} => ${target.id}`, true)

    const ret = await this.sendWithRetry(target, context, source => entity.send(elements, toSdkSource(source), source ? { msgSeq: source.seq } : undefined))
    const result = { ...(ret || {}) }
    if (result.id !== undefined && result.message_id === undefined) result.message_id = result.id
    this.rememberSentMessage(target, result, elements)
    return result
  }

  describeElements(elements) {
    return (Array.isArray(elements) ? elements : []).map(item => (!item ? "" : item.type === "text" ? (item.data?.text ?? item.text ?? "") : item.type === "markdown" ? item.data?.content || "" : `<${item.type}>`)).join("")
  }

  async sendFileTo(target, segment, context) {
    const fileSource = segment.file ?? segment.url
    if (!fileSource) throw new Error("文件为空")
    const name = segment.name || fileNameFrom(fileSource)
    const uploaded = await this.retryAuth(() => this.entity(target).upload(fileSource, { fileType: 4, fileName: name, sendMessage: false }))
    if (!uploaded?.file_info) throw new Error("上传文件失败")

    const endpoint = target.kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`
    const payload = { msg_type: 7, media: { file_info: uploaded.file_info } }
    const refIdx = String(context?.reply?.data?.ref_idx || "")
    if (refIdx && !context.replyUsed) {
      payload.message_reference = { message_id: refIdx }
      context.replyUsed = true
    }

    Bot.makeLog("info", `发送文件：${name}`, `${this.selfId} => ${target.id}`, true)
    const data = await this.sendWithRetry(target, context, async source => {
      delete payload.msg_id
      delete payload.event_id
      if (source?.id) payload.msg_id = source.id
      else if (source?.event_id) payload.event_id = source.event_id
      payload.msg_seq = source ? source.seq : randomInt(1, 1_000_000)
      return (await this.sdk.request.post(endpoint, payload, { timeout: 60000 })).data
    })
    const result = { ...(data || {}) }
    if (result.id !== undefined && result.message_id === undefined) result.message_id = result.id
    this.rememberSentMessage(target, result, [{ type: "file", name }])
    return result
  }

  sendInputNotify(user_id, seconds = 10) {
    const target = { kind: "c2c", id: String(user_id) }
    const value = Math.min(60, Math.max(1, Math.floor(Number(seconds) || 10)))
    return this.sendWithRetry(target, { provider: this.createSourceProvider(target) }, source => this.sdk.user(target.id).sendInputNotify(value, toSdkSource(source), { msgSeq: source.seq }), false)
  }

  forwardText(nodes) {
    const lines = []
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
      if (!node || typeof node !== "object") continue
      const name = node.nickname || node.name || node.data?.name || node.user_id || ""
      const content = node.message ?? node.content ?? node.data?.content ?? ""
      let line = ""
      for (const s of Array.isArray(content) ? content : [content]) {
        if (typeof s === "string") line += s
        else if (s?.type === "text") line += s.text ?? s.data?.text ?? ""
        else if (s?.type === "at") line += `@${s.name || s.qq || s.data?.qq || ""}`
        else if (s?.type === "face") line += "[表情]"
        else if (s?.type === "image") line += "[图片]"
        else if (s?.type === "record" || s?.type === "audio") line += "[语音]"
        else if (s?.type === "video") line += "[视频]"
        else if (s?.type === "file") line += `[文件:${s.name || s.data?.name || ""}]`
        else if (s?.type === "markdown") line += s.data?.content ?? (typeof s.data === "string" ? s.data : s.content) ?? ""
        else if (s?.type === "node") line += this.forwardText(s.data ?? s)
      }
      lines.push(`${name ? `${name}: ` : ""}${line}`)
    }
    return lines.length ? ["[合并转发]", ...lines].join("\n") : ""
  }

  async refreshGroupState(group_id) {
    try {
      const state = await this.ensureBotState(group_id)
      if (!state) return
      const group = this.gl.get(group_id)
      if (group && state.recv_msg_setting) group.allMessages = state.recv_msg_setting === "all"
      if (group && state.member_openid) group.botOpenid = String(state.member_openid)
      const gml = this.gml.get(group_id)
      if (gml) gml.set(this.selfId, { ...(gml.get(this.selfId) || { user_id: this.selfId, nickname: this.botName, card: this.botName, avatar: this.avatar || "" }), role: state.member_role || "" })
    } catch {}
  }

  setBotStateCache(group_id, value) {
    this.botStates.delete(group_id)
    capMap(this.botStates, BOT_STATE_MAX - 1)
    this.botStates.set(group_id, value)
  }

  ensureBotState(group_id) {
    const cached = this.botStates.get(group_id)
    if (cached && Date.now() - cached.time < 600000) return Promise.resolve(cached.state)
    if (cached?.promise) return cached.promise

    const promise = this.retryAuth(() => this.sdk.group(group_id).botState())
      .then(state => {
        this.setBotStateCache(group_id, { state, time: Date.now() })
        return state
      })
      .catch(() => {
        this.setBotStateCache(group_id, { state: null, time: Date.now() })
        return null
      })
    this.setBotStateCache(group_id, { ...(cached || {}), promise })
    return promise.finally(() => {
      const entry = this.botStates.get(group_id)
      if (entry?.promise) delete entry.promise
    })
  }

  setGroupInfoCache(group_id, value) {
    this.groupInfo.delete(group_id)
    capMap(this.groupInfo, GROUP_INFO_MAX - 1)
    this.groupInfo.set(group_id, value)
  }

  async getGroupName(group_id) {
    const cached = this.groupInfo.get(group_id)
    if (cached && Date.now() - cached.time < (cached.ttl || 3600000)) return cached.name
    if (cached?.promise) return cached.promise

    const promise = this.retryAuth(() => this.sdk.group(group_id).info())
      .then(info => {
        const name = info?.group_name || ""
        if (info?.union_group_openid) {
          const group = this.gl.get(group_id)
          if (group) group.union_group_openid = String(info.union_group_openid)
        }
        this.setGroupInfoCache(group_id, { name, time: Date.now(), ttl: name ? 3600000 : 300000 })
        return name
      })
      .catch(() => {
        this.setGroupInfoCache(group_id, { name: "", time: Date.now(), ttl: 300000 })
        return ""
      })
    this.setGroupInfoCache(group_id, { ...(cached || {}), promise })
    try {
      return await promise
    } finally {
      const entry = this.groupInfo.get(group_id)
      if (entry?.promise) delete entry.promise
    }
  }

  setupBot() {
    const self_id = this.selfId
    if (Bot.bots[self_id]) {
      if (Bot.bots[self_id].adapter === this) return true
      Bot.makeLog("error", [`QQ机器人 AppID ${self_id} 已存在同名 Bot，跳过加载`], this.id)
      return false
    }

    const adapter = this
    Bot[self_id] = {
      adapter,
      sdk: this.sdk,
      uin: self_id,
      name: this.name,
      model: "Yunzai",
      version: {
        id: this.id,
        name: this.name,
        get version() {
          return this.name
        },
      },
      sendApi: (method, url, data) => adapter.retryAuth(() => adapter.sdk.request({ method, url, data })).then(res => res.data),
      logout: () => adapter.stop("QQ机器人已主动停止", true),
      get info() {
        return { user_id: self_id, nickname: adapter.botName, avatar: adapter.avatar || "" }
      },
      get nickname() {
        return adapter.botName
      },
      get avatar() {
        return adapter.avatar || ""
      },
      stat: Bot.stat,
      fl: this.fl,
      gl: this.gl,
      gml: this.gml,
      pickFriend: this.pickFriend.bind(this),
      pickMember: this.pickMember.bind(this),
      pickGroup: this.pickGroup.bind(this),
      get pickUser() {
        return this.pickFriend
      },
      getFriendArray: () => [...adapter.fl.values()],
      getFriendList: () => [...adapter.fl.keys()],
      getFriendMap: () => adapter.fl,
      getGroupArray: () => [...adapter.gl.values()],
      getGroupList: () => [...adapter.gl.keys()],
      getGroupMap: () => adapter.gl,
      getGroupMemberMap: () => adapter.gml,
    }
    if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id)
    return true
  }

  pickFriend(user_id) {
    user_id = String(user_id)
    const info = this.fl.get(user_id) || {}
    return {
      ...info,
      ...this.targetApi({ kind: "c2c", id: user_id }),
      user_id,
      name: info.nickname || user_id,
      nickname: info.nickname || user_id,
      avatar: info.avatar || "",
      sendInputNotify: (seconds = 10) => this.sendInputNotify(user_id, seconds),
      getInfo: async () => {
        const latest = this.fl.get(user_id) || info
        const u = this.sdk.user(user_id)
        const user = await this.retryAuth(() => (typeof u.info === "function" ? u.info() : this.sdk.request.get(`/v2/users/${encodeURIComponent(user_id)}/info`).then(r => r.data))).catch(() => null)
        if (!user) return { ...latest, user_id, nickname: latest.nickname || user_id }
        const ret = { ...latest, user_id, ...user, avatar: normalizeUrl(user.avatar) || latest.avatar || "", nickname: user.username || user.nickname || latest.nickname || user_id }
        this.fl.set(user_id, ret)
        return ret
      },
      getAvatarUrl: () => (this.fl.get(user_id)?.avatar ?? info.avatar) || "",
      getChatHistory: (message_seq, count, reverseOrder = true) => this.getChatHistory("c2c", user_id, message_seq, count, reverseOrder),
      getMsg: message_id => this.getMsg("c2c", user_id, message_id),
      pickMember() {
        return this
      },
    }
  }

  pickGroup(group_id) {
    group_id = String(group_id)
    const self = this
    const info = this.gl.get(group_id) || {}
    const groupSdk = () => this.sdk.group(group_id)
    return {
      ...info,
      ...this.targetApi({ kind: "group", id: group_id }),
      group_id,
      name: info.group_name || info.name || group_id,
      group_name: info.group_name || info.name || group_id,
      getInfo: async () => {
        const latest = this.gl.get(group_id) || info
        const ret = await this.retryAuth(() => groupSdk().info()).catch(() => ({}))
        const group_name = ret.group_name || latest.group_name || ""
        if (ret.group_name || ret.union_group_openid) {
          if (ret.group_name) this.setGroupInfoCache(group_id, { name: ret.group_name, time: Date.now(), ttl: 3600000 })
          const group = this.gl.get(group_id)
          if (group) {
            if (ret.group_name) group.group_name = group.name = ret.group_name
            if (ret.union_group_openid) group.union_group_openid = String(ret.union_group_openid)
          }
        }
        return { ...latest, group_id, ...ret, group_name }
      },
      getBotState: async () => {
        const state = await this.retryAuth(() => groupSdk().botState())
        this.setBotStateCache(group_id, { state, time: Date.now() })
        return state
      },
      getMuteSetting: () => this.retryAuth(() => groupSdk().muteSetting()),
      getJoinRequests: options => this.retryAuth(() => groupSdk().joinRequests(options)),
      approveJoinRequest: (member_openid, options) => this.retryAuth(() => groupSdk().approveJoin(member_openid, options)),
      getBlacklist: options => this.retryAuth(() => groupSdk().blacklist(options)),
      updateBlacklist: options => this.retryAuth(() => groupSdk().updateBlacklist(options)),
      getAvatarUrl: () => "",
      getChatHistory: (message_seq, count, reverseOrder = true) => this.getChatHistory("group", group_id, message_seq, count, reverseOrder),
      getMsg: message_id => this.getMsg("group", group_id, message_id),
      pickMember: user_id => this.pickMember(group_id, user_id),
      getMemberArray: () => this.memberArray(group_id),
      getMemberList: async () => (await this.memberArray(group_id)).map(item => item.user_id),
      getMemberMap: async () => {
        await this.memberArray(group_id)
        const map = new Map()
        for (const [id, member] of this.gml.get(group_id) || []) map.set(id, { ...member })
        return map
      },
      get is_owner() {
        return self.gml.get(group_id)?.get(self.selfId)?.role === "owner"
      },
      get is_admin() {
        return ["owner", "admin"].includes(self.gml.get(group_id)?.get(self.selfId)?.role)
      },
      muteMember: (user_id, duration) => this.muteGroupMember(group_id, user_id, duration),
      kickMember: user_id => this.kickGroupMembers(group_id, [user_id]),
      kickMembers: user_ids => this.kickGroupMembers(group_id, user_ids),
    }
  }

  async memberArray(group_id) {
    const cached = [...(this.gml.get(group_id)?.values() || [])].map(item => ({ ...item }))
    const list = await this.retryAuth(() => this.sdk.getGroupMemberList(group_id)).catch(() => null)
    if (!Array.isArray(list)) return cached
    let gml = this.gml.get(group_id)
    if (!gml) this.gml.set(group_id, (gml = new Map()))
    const ret = []
    for (const member of list) {
      const user_id = String(member.member_openid || "")
      if (!user_id) continue
      const prev = gml.get(user_id) || {}
      const name = member.username || prev.nickname || user_id
      const item = { user_id, nickname: name, card: prev.card || name, role: member.member_role || prev.role || "", avatar: normalizeUrl(member.avatar) || prev.avatar || "" }
      gml.set(user_id, { ...prev, ...item })
      ret.push({ ...item })
    }
    return ret
  }

  pickMember(group_id, user_id) {
    group_id = String(group_id)
    user_id = String(user_id)
    const target = { kind: "group", id: group_id }

    if (user_id === this.selfId) {
      const getSelf = () => this.gml.get(group_id)?.get(this.selfId) || {}
      return {
        ...this.targetApi(target),
        group_id,
        user_id,
        get name() {
          return this.botName
        },
        get nickname() {
          return this.botName
        },
        get card() {
          return this.botName
        },
        get role() {
          return getSelf().role || ""
        },
        get avatar() {
          return this.avatar || ""
        },
        getInfo: async () => ({ user_id, nickname: this.botName, card: this.botName, role: getSelf().role || "" }),
        getAvatarUrl: () => this.avatar || "",
        get is_owner() {
          return getSelf().role === "owner"
        },
        get is_admin() {
          return ["owner", "admin"].includes(getSelf().role)
        },
      }
    }

    const info = this.gml.get(group_id)?.get(user_id) || {}
    const getMember = () => this.gml.get(group_id)?.get(user_id) || info
    return {
      ...info,
      ...this.targetApi(target),
      group_id,
      user_id,
      get name() {
        const m = getMember()
        return m.card || m.nickname || user_id
      },
      get nickname() {
        return getMember().nickname || user_id
      },
      get card() {
        return getMember().card || ""
      },
      get role() {
        return getMember().role || ""
      },
      get avatar() {
        return getMember().avatar || ""
      },
      sendMsg: msg => {
        const list = Array.isArray(msg) ? msg : [msg]
        const idx = list.findIndex(item => (typeof item === "string" || typeof item === "number" ? String(item).length > 0 : item && typeof item === "object" && (item.type === "text" ? String(item.text ?? item.data?.text ?? "").length > 0 : item.type === "face" || item.type === "node")))
        return this.sendTo(target, idx < 0 ? list : [...list.slice(0, idx), { type: "at", qq: user_id }, ...list.slice(idx)])
      },
      mute: duration => this.muteGroupMember(group_id, user_id, duration),
      kick: () => this.kickGroupMembers(group_id, [user_id]),
      getInfo: async () => {
        const latest = this.gml.get(group_id)?.get(user_id) || info
        const member = await this.retryAuth(() => this.sdk.getGroupMemberInfo(group_id, user_id)).catch(() => null)
        if (!member) return { ...latest, user_id, nickname: latest.nickname || user_id, card: latest.card || "", role: latest.role || "" }
        const name = member.username || latest.nickname || user_id
        const ret = { ...latest, user_id, nickname: name, card: latest.card || name, role: member.member_role || latest.role || "", avatar: normalizeUrl(member.avatar) || latest.avatar || "" }
        this.gml.get(group_id)?.set(user_id, ret)
        return ret
      },
      getAvatarUrl: () => getMember().avatar || "",
      get is_owner() {
        return getMember().role === "owner"
      },
      get is_admin() {
        return ["owner", "admin"].includes(getMember().role)
      },
    }
  }

  async recallMsg(target, message_id) {
    if (!message_id) return
    const entity = this.entity(target)
    const rets = []
    for (const id of Array.isArray(message_id) ? message_id : [message_id]) {
      rets.push(
        await this.retryAuth(() => entity.recall(id)).catch(err => {
          Bot.makeLog("debug", ["撤回消息失败", id, errorText(err)], this.selfId)
          return err
        }),
      )
    }
    return rets.length === 1 ? rets[0] : rets
  }

  async muteGroupMember(group_id, user_id, duration = DEFAULT_MUTE_SECONDS) {
    const group = this.sdk.group(group_id)
    const member_openid = String(user_id)
    const parsed = duration == null ? DEFAULT_MUTE_SECONDS : Number(duration)
    const seconds = Math.min(Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : DEFAULT_MUTE_SECONDS)), MAX_MUTE_SECONDS)
    if (seconds <= 0) return this.retryAuth(() => group.muteMembers([{ op: "del", member_openid, mute_expire_at: "" }]))
    const item = { op: "add", member_openid, mute_expire_at: toRfc3339(Date.now() + seconds * 1000) }
    try {
      return await this.retryAuth(() => group.muteMembers([item]))
    } catch (err) {
      if (!/已|存在|重复|exist|already|repeat/i.test(errorText(err))) throw err
      return this.retryAuth(() => group.muteMembers([{ ...item, op: "update" }]))
    }
  }

  async kickGroupMembers(group_id, user_ids) {
    const ids = (Array.isArray(user_ids) ? user_ids : [user_ids]).map(String).filter(Boolean)
    if (!ids.length) return
    const group = this.sdk.group(group_id)
    const results = []
    for (let i = 0; i < ids.length; i += 20) results.push(await this.retryAuth(() => group.removeMembers({ member_openids: ids.slice(i, i + 20) })))
    return results.length === 1 ? results[0] : results
  }
}

class QQBotAdapter {
  id = "QQBot"
  name = "QQ官方机器人"
  instances = []

  load() {
    const config = cfg.qqbot || {}
    if (!config.enable) return
    const bots = Array.isArray(config.bots) ? config.bots.filter(item => item && typeof item === "object" && !Array.isArray(item)) : []
    if (!bots.some(item => String(item.appid || "").trim() && String(item.secret || "").trim())) {
      return Bot.makeLog("warn", "QQ机器人未配置 appid 或 secret，跳过加载", this.id)
    }

    const ports = new Set()
    const appids = new Set()
    for (const [index, item] of bots.entries()) {
      const botConfig = { ...item }
      const appid = String(botConfig.appid || "").trim()
      const secret = String(botConfig.secret || "").trim()
      if (!appid || !secret) {
        Bot.makeLog("warn", `QQ机器人第 ${index + 1} 项未配置 appid 或 secret，已跳过`, this.id)
        continue
      }
      if (appids.has(appid)) {
        Bot.makeLog("warn", `QQ机器人 AppID ${appid} 重复，已跳过`, this.id)
        continue
      }
      appids.add(appid)
      botConfig.appid = appid
      botConfig.secret = secret
      if (botConfig.mode === "webhook") {
        const port = Math.min(65535, Math.max(1, Number(botConfig.webhook_port) || 6196))
        if (ports.has(port)) {
          Bot.makeLog("error", `QQ机器人 webhook 端口 ${port} 重复，已跳过 ${appid}`, this.id)
          continue
        }
        ports.add(port)
        botConfig.webhook_port = port
      }
      const instance = new QQBotInstance(botConfig)
      this.instances.push(instance)
      try {
        instance.init()
      } catch (err) {
        instance.logError(`QQ机器人 ${appid} 初始化失败`, err)
      }
    }
  }
}

Bot.adapter.push(new QQBotAdapter())
