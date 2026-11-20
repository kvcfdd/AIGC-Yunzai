import { randomInt } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Bot as QQBot, ReceiverMode, segment as sdkSegment } from "qq-official-bot"
import cfg from "../../lib/config/config.js"

// 群被动回复
const GROUP_PASSIVE_TTL = 110 * 1000
const GROUP_PASSIVE_LIMIT = 5
const GROUP_MSG_POOL_MAX = 100
// 单聊被动回复有效期
const C2C_PASSIVE_TTL = 4.5 * 60 * 1000
// 近期消息引用索引缓存有效期
const MESSAGE_REF_TTL = 4.5 * 60 * 1000
// 单条文本长度上限
const TEXT_LIMIT = 1800
// 语音下载上限
const AUDIO_MAX_BYTES = 25 * 1024 * 1024
// 外层重启退避
const RETRY_BASE = 10000
const RETRY_MAX = 300000
// 单次连接等待就绪的超时
const CONNECT_TIMEOUT = 30000
// 需要订阅的 Intent，平台拒绝时自动降级
const INTENT_SETS = [["GROUP_AND_C2C_EVENT", "GROUP_MEMBER", "INTERACTION"], ["GROUP_AND_C2C_EVENT", "GROUP_MEMBER"], ["GROUP_AND_C2C_EVENT", "INTERACTION"], ["GROUP_AND_C2C_EVENT"]]
// intent 无效/无权限的关闭码
const INTENT_CLOSE_CODES = [4013, 4014]
// 官方 API 不提供历史消息接口，只能缓存运行期间收到的消息
const HISTORY_MAX = 50
const HISTORY_CONVERSATIONS = 100
// 发送错误分类
const PASSIVE_ERROR = /msg_id|msg_seq|过期|无效|invalid|expired/i
const AUTH_ERROR = /11241|authorization/i
const MARKDOWN_ERROR = /markdown|不允许/i

/** 按字符上限切分文本，避免切断 emoji 等代理对 */
function splitText(text, limit) {
  if (text.length <= limit) return [text, ""]
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end = end > 1 ? end - 1 : Math.min(2, text.length)
  return [text.slice(0, end), text.slice(end)]
}

/** 防止文本里的 <qqbot-...> 被平台当成 at 标签 */
function sanitizeText(text) {
  return String(text).replace(/<qqbot-/gi, "<qqbot​-")
}

/** 补全 QQ 资源地址的协议 */
function normalizeUrl(url) {
  if (!url || typeof url !== "string") return ""
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith("//")) return `https:${url}`
  return `https://${url}`
}

/** 是否为腾讯 silk 语音 */
function isSilk(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 9) return false
  if (buffer[0] === 0x02) return buffer.subarray(1, 10).toString() === "#!SILK_V3"
  return buffer.subarray(0, 9).toString() === "#!SILK_V3"
}

/** 从路径或 URL 推断文件名 */
function fileNameFrom(value) {
  if (typeof value !== "string" || !value) return "file"
  if (/^(?:base64:\/\/|data:)/i.test(value)) return "file"
  try {
    if (/^https?:\/\//i.test(value)) return decodeURIComponent(new URL(value).pathname.split("/").pop() || "") || "file"
    return path.basename(value.replace(/^file:\/\//, "")) || "file"
  } catch {
    return "file"
  }
}

/** 读取语音源为 Buffer */
async function readAudioSource(source) {
  if (Buffer.isBuffer(source)) return source
  const value = String(source ?? "")
  if (!value) throw new Error("语音文件为空")
  if (value.startsWith("base64://")) return Buffer.from(value.slice(9), "base64")
  if (/^data:[^;]+;base64,/i.test(value)) return Buffer.from(value.replace(/^data:[^;]+;base64,/i, ""), "base64")
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载语音失败：HTTP ${res.status}`)
    if (Number(res.headers.get("content-length") || 0) > AUDIO_MAX_BYTES) throw new Error("语音文件过大")
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > AUDIO_MAX_BYTES) throw new Error("语音文件过大")
    return buffer
  }
  return fs.readFile(value.replace(/^file:\/\//, ""))
}

/** ffmpeg 转 PCM s16le */
function ffmpegToPcm(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] })
    const chunks = []
    let error = ""
    child.stdout.on("data", chunk => chunks.push(chunk))
    child.stderr.on("data", chunk => (error += chunk))
    child.on("error", reject)
    child.on("close", code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg 转换失败 (${code})：${error.slice(0, 200)}`))))
  })
}

/** 音频转腾讯 silk，返回 silk Buffer */
async function toSilk(source, name = "voice") {
  const buffer = await readAudioSource(source)
  if (isSilk(buffer)) {
    if (buffer[0] === 0x02) return buffer
    return Buffer.concat([Buffer.from([0x02]), buffer])
  }

  await Bot.mkdir("temp/qqbot")
  const ext = path.extname(String(name || "")) || ".audio"
  const temp = path.resolve("temp/qqbot", `${Date.now().toString(36)}${randomInt(1000, 9999)}${ext}`)
  try {
    await fs.writeFile(temp, buffer)
    const pcm = await ffmpegToPcm(temp)
    const { encode } = await import("silk-wasm")
    const { data } = await encode(pcm, 24000)
    return Buffer.from(data)
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
  useMarkdown = false
  passiveReply = true
  retryTimer = null
  retryDelay = RETRY_BASE
  started = false
  stopped = false
  startToken = 0
  startAbort = null
  intentIndex = 0
  intentRetry = false
  fl = new Map()
  gl = new Map()
  gml = new Map()
  c2cSources = new Map()
  groupMsgPool = new Map()
  messageRefs = new Map()
  groupInfo = new Map()
  botStates = new Map()
  botMentionIds = new Map()
  seen = new Map()
  histories = new Map() // `${kind}:${id}` -> { seq, messages }

  constructor(config) {
    this.config = config
  }

  get botName() {
    return this.nickname || this.sdk?.nickname || this.name
  }

  makeLog(msg) {
    return Bot.String(msg).replace(/base64:\/\/.*?(,|]|")/g, "base64://...$1")
  }

  /** 只记录错误消息与堆栈，避免把 SDK 请求头里的凭据写进日志 */
  logError(msg, err) {
    Bot.makeLog("error", [msg, err?.stack || err?.message || String(err)], this.selfId)
  }

  init() {
    const config = this.config

    this.appid = String(config.appid || "").trim()
    this.secret = String(config.secret || "").trim()

    this.mode = config.mode === "webhook" ? "webhook" : "websocket"
    this.useMarkdown = !!config.markdown
    this.passiveReply = config.passive_reply !== false
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
      dataDir: "data/qqbot",
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
    this.sdk.receiver?.on?.("close", (code, reason) => this.onReceiverClose(code, reason))

    this.start().catch(err => this.handleStartError(err))
  }

  currentIntents() {
    return INTENT_SETS[Math.min(this.intentIndex, INTENT_SETS.length - 1)]
  }

  /** 当前 Intent 集合被平台拒绝时，按预设顺序静默降级；返回是否还有可尝试的集合 */
  fallbackIntents() {
    if (this.intentIndex >= INTENT_SETS.length - 1) return false
    this.intentIndex += 1
    if (this.sdk?.config) this.sdk.config.intents = this.currentIntents()
    return true
  }

  stopForever(msg) {
    this.stopped = true
    this.started = false
    this.startToken += 1
    clearTimeout(this.retryTimer)
    Bot.makeLog("error", msg, this.selfId)
    this.startAbort?.(new Error(msg))
    try {
      this.sdk?.sessionManager?.stop?.()
    } catch {}
  }

  handleStartError(err) {
    if (this.stopped) return
    const retrySoon = this.intentRetry
    this.intentRetry = false
    if (!retrySoon) this.logError("QQ机器人启动失败", err)
    this.scheduleStart(retrySoon ? 1000 : undefined)
  }

  onReceiverClose(code, reason) {
    // 自己调用 sessionManager.stop() 引起的关闭，交给 start()/scheduleStart() 处理
    if (this.sdk.sessionManager?.userClose) return
    const numeric = Number(code)
    if ([4914, 4915].includes(numeric)) return this.stopForever("QQ机器人已下架或封禁，停止自动重连")
    if (INTENT_CLOSE_CODES.includes(numeric) || /intent/i.test(String(reason || ""))) {
      const wasStarted = this.started
      this.startToken += 1
      this.started = false
      if (!this.fallbackIntents()) return this.stopForever(`QQ机器人订阅基础 Intent 被平台拒绝（${numeric}），停止自动重连`)
      this.intentRetry = true
      // 启动阶段还没有可用的 start() 结果，直接中断等待，由 catch 按新 Intent 重试
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
    if (token !== this.startToken) return
    if (this.sdk.receiver && !this.sdk.receiver.isReady) throw new Error("QQ机器人连接未就绪")
    if (!this.setupBot()) return
    this.started = true
    this.retryDelay = RETRY_BASE
    await this.loadSelf()
    if (token !== this.startToken || !this.started) return
    Bot.makeLog("mark", `QQ机器人已连接：${this.nickname || this.selfId}（Intent: ${this.currentIntents().join(", ")}）`, this.selfId)
    try {
      this.emitConnect()
    } catch (err) {
      this.logError("QQ机器人 connect 事件处理失败", err)
    }
  }

  async loadSelf() {
    try {
      const info = await this.sdk.getSelfInfo()
      if (info?.username) this.nickname = info.username
      if (info?.avatar) this.avatar = normalizeUrl(info.avatar)
      if (!this.sdk.self_id && info?.id) this.sdk.self_id = String(info.id)
    } catch (err) {
      Bot.makeLog("debug", ["获取机器人信息失败", err.message], this.selfId)
    }
  }

  bindEvents() {
    const onMessage = event => Promise.resolve(this.onMessage(event)).catch(err => this.logError("处理 QQ机器人消息失败", err))
    for (const name of ["message.group", "message.private.friend"]) this.sdk.on(name, onMessage)

    const onNotice = (name, handler) =>
      this.sdk.on(name, event => {
        try {
          handler(event)
        } catch (err) {
          this.logError(`处理 QQ机器人 ${name} 事件失败`, err)
        }
      })
    for (const [name, handler] of [
      // 群成员加入/退出
      ["notice.group.member.increase", event => this.onGroupMemberNotice(event, "increase")],
      ["notice.group.member.decrease", event => this.onGroupMemberNotice(event, "decrease")],
      // 机器人被拉入/移出群
      ["notice.group.increase", event => this.onGroupChangeNotice(event, "increase")],
      ["notice.group.decrease", event => this.onGroupChangeNotice(event, "decrease")],
      // 好友添加/删除
      ["notice.friend.increase", event => this.onFriendNotice(event, "increase")],
      ["notice.friend.decrease", event => this.onFriendNotice(event, "decrease")],
      // 主动消息接收开关
      ["notice.group.receive_open", event => this.onReceiveNotice(event, "group")],
      ["notice.group.receive_close", event => this.onReceiveNotice(event, "group")],
      ["notice.friend.receive_open", event => this.onReceiveNotice(event, "friend")],
      ["notice.friend.receive_close", event => this.onReceiveNotice(event, "friend")],
      // 入群申请
      ["notice.group.join_request", event => this.onGroupJoinRequest(event)],
      // 订阅消息授权状态
      ["notice.group.subscribe", event => this.onSubscribeNotice(event, "group")],
      ["notice.friend.subscribe", event => this.onSubscribeNotice(event, "friend")],
      // 按钮/快捷菜单等互动
      ["notice.group.action", event => this.onActionNotice(event, "group")],
      ["notice.friend.action", event => this.onActionNotice(event, "friend")],
    ])
      onNotice(name, handler)
  }

  // 事件转换
  async onMessage(event) {
    if (!event) return
    // 重复推送按 message_id 去重
    const messageId = String(event.message_id || event.event_id || "")
    if (messageId && this.isDuplicate(messageId)) return
    if (event.message_type === "group") return this.handleGroupMessage(event)
    if (event.message_type === "private") return this.handlePrivateMessage(event)
  }

  async handleGroupMessage(event) {
    const group_id = String(event.group_id || event.group_openid || "")
    const sender = event.sender || {}
    const user_id = String(sender.user_openid || event.user_id || "")
    if (!group_id || !user_id) return

    const nickname = String(sender.user_name || sender.member_nickname || user_id)
    const card = String(sender.member_nickname || nickname)
    const avatar = normalizeUrl(sender.avatar)
    const role = this.memberRole(sender.permissions)
    const cached_name = this.gl.get(group_id)?.group_name
    const group_name = String(event.group_name || (cached_name && cached_name !== group_id ? cached_name : "") || group_id)
    if (!event.group_name && group_name === group_id) {
      void this.getGroupName(group_id).then(name => {
        if (!name) return
        const group = this.gl.get(group_id)
        if (group && (!group.group_name || group.group_name === group_id)) group.group_name = group.name = name
      })
    }
    const selfMention = (Array.isArray(event.mentions) ? event.mentions : []).find(mention => this.isSelfMention(mention, this.gl.get(group_id)?.botOpenid || ""))
    if (selfMention?.member_openid) {
      const group = this.gl.get(group_id) || {}
      group.botOpenid = String(selfMention.member_openid)
      this.gl.set(group_id, group)
    }
    const atBot = event.sub_type === "at" || this.detectSelfMention(event) || !this.isGroupAllMessages(group_id)
    const segments = this.convertSegments(event, atBot)
    const message_id = String(event.message_id || event.id || "")

    this.gl.set(group_id, { ...(this.gl.get(group_id) || {}), group_id, group_name, name: group_name })
    let gml = this.gml.get(group_id)
    if (!gml) this.gml.set(group_id, (gml = new Map()))
    gml.set(user_id, { ...(gml.get(user_id) || {}), user_id, nickname, card, avatar, ...(role ? { role } : {}) })
    gml.set(this.selfId, { ...(gml.get(this.selfId) || {}), user_id: this.selfId, nickname: this.botName, card: this.botName, avatar: this.avatar || "" })

    this.rememberMessage("group", group_id, event)
    void this.refreshGroupState(group_id)
    Bot.makeLog("info", `群消息${atBot ? "[@]" : ""}：[${group_name}, ${card}] ${this.makeLog(event.raw_message)}`, `${this.selfId} <= ${group_id}, ${user_id}`, true)
    const data = {
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      self_id: this.selfId,
      user_id,
      group_id,
      group_name,
      sender: { user_id, nickname, card, avatar, ...(role ? { role } : {}) },
      message: segments,
      raw_message: event.raw_message || "",
      message_id,
      msg_idx: event.msg_idx,
      time: this.eventTime(event),
      raw: this.rawEvent(event),
    }
    data.message_seq = this.recordHistory("group", group_id, data)
    Bot.em("message.group.normal", data)
  }

  async handlePrivateMessage(event) {
    const sender = event.sender || {}
    const user_id = String(sender.user_openid || event.user_id || "")
    if (!user_id) return

    const nickname = String(sender.user_name || user_id)
    const avatar = normalizeUrl(sender.avatar)
    const segments = this.convertSegments(event, false)
    const message_id = String(event.message_id || event.id || "")

    this.fl.set(user_id, { ...(this.fl.get(user_id) || {}), user_id, nickname, avatar })
    this.rememberMessage("c2c", user_id, event)
    Bot.makeLog("info", `好友消息：[${nickname}] ${this.makeLog(event.raw_message)}`, `${this.selfId} <= ${user_id}`, true)
    const data = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      self_id: this.selfId,
      user_id,
      sender: { user_id, nickname, card: nickname, avatar },
      message: segments,
      raw_message: event.raw_message || "",
      message_id,
      msg_idx: event.msg_idx,
      time: this.eventTime(event),
      raw: this.rawEvent(event),
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
    const group_id = String(event.group_id || "")
    const user_id = String(event.user_id || event.user_openid || "")
    if (!group_id || !user_id) return
    this.emitNotice("group", type, event, { group_id, user_id, operator_id: event.operator_id })
    if (type === "decrease") this.gml.get(group_id)?.delete(user_id)
  }

  /** 机器人自身被加入/移出群 */
  onGroupChangeNotice(event, type) {
    const group_id = String(event.group_id || "")
    if (!group_id) return
    const cached = this.gl.get(group_id)
    const group_name = cached?.group_name && cached.group_name !== group_id ? cached.group_name : group_id
    if (type === "increase") this.gl.set(group_id, { ...(cached || {}), group_id, group_name, name: group_name })
    this.emitNotice("group", type, event, {
      group_id,
      group_name,
      user_id: this.selfId,
      operator_id: event.operator_id,
    })
    if (type === "increase") {
      void this.getGroupName(group_id).then(name => {
        if (!name) return
        const group = this.gl.get(group_id)
        if (group && (!group.group_name || group.group_name === group_id)) group.group_name = group.name = name
      })
      return
    }
    this.gl.delete(group_id)
    this.gml.delete(group_id)
    this.groupInfo.delete(group_id)
    this.botStates.delete(group_id)
    this.groupMsgPool.delete(group_id)
    this.botMentionIds.delete(group_id)
    this.histories.delete(`group:${group_id}`)
  }

  onFriendNotice(event, type) {
    const user_id = String(event.user_id || "")
    if (!user_id) return
    this.emitNotice("friend", type, event, { user_id })
    if (type === "decrease") {
      this.fl.delete(user_id)
      this.c2cSources.delete(user_id)
      this.histories.delete(`c2c:${user_id}`)
    } else this.fl.set(user_id, { ...(this.fl.get(user_id) || {}), user_id })
  }

  /** 群/单聊主动消息接收开关变化 */
  onReceiveNotice(event, type) {
    const sub_type = String(event.sub_type || "")
    const group_id = type === "group" ? String(event.group_id || "") : ""
    const user_id = String(type === "friend" ? event.user_id || "" : event.operator_id || "")
    if (!sub_type || (type === "group" && !group_id) || !user_id) return
    this.emitNotice(type, sub_type, event, {
      ...(group_id ? { group_id } : {}),
      user_id,
      operator_id: event.operator_id,
    })
  }

  /** 入群申请 */
  onGroupJoinRequest(event) {
    const group_id = String(event.group_id || "")
    const user_id = String(event.user_id || "")
    if (!group_id || !user_id) return
    const verify = event.verify_info
    const comment = typeof verify === "string" ? verify : verify?.verify_message || ""
    const request = {
      post_type: "request",
      request_type: "group",
      sub_type: "add",
      self_id: this.selfId,
      group_id,
      user_id,
      comment,
      flag: event.join_request_id,
      time: this.eventTime({ timestamp: event.apply_at }),
      raw: this.rawEvent(event),
    }
    request.approve = (approve = true, reason = "") => {
      const decline = !approve
      return this.sdk.group(group_id).approveJoin(user_id, {
        op: decline ? "decline" : "approve",
        join_request_id: event.join_request_id,
        ...(decline && reason ? { reject_reason: String(reason) } : {}),
      })
    }
    Bot.em("request.group.add", request)
  }

  /** 订阅消息授权状态 */
  onSubscribeNotice(event, type) {
    const group_id = String(event.group_id || "")
    const user_id = String(event.user_id || "")
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
    const group_id = type === "group" ? String(event.group_id || "") : ""
    const user_id = String(event.operator_id || "")
    if (!user_id || (type === "group" && !group_id)) return
    this.emitNotice(type, "action", event, {
      ...(group_id ? { group_id } : {}),
      user_id,
      operator_id: user_id,
      interaction_type: event.interaction_type,
      data: event.data,
      notice_id: event.notice_id,
      event_id: event.event_id,
      application_id: event.application_id,
      version: event.version,
      replyAction: code => event.reply(code),
    })
  }

  isDuplicate(message_id) {
    const now = Date.now()
    const time = this.seen.get(message_id)
    if (time && now - time < 60000) return true
    if (this.seen.size > 256)
      for (const [key, value] of this.seen)
        if (now - value > 60000) {
          this.seen.delete(key)
        }
    this.seen.set(message_id, now)
    return false
  }

  memberRole(permissions) {
    const role = Array.isArray(permissions) ? permissions[0] : ""
    if (role === "owner" || role === "admin") return role
    return role ? "member" : ""
  }

  eventTime(event) {
    const raw = event?.timestamp ?? event?.time
    const time = Number(raw)
    if (Number.isFinite(time) && time > 0) return time > 1e12 ? Math.floor(time / 1000) : time
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

  isSelfMention(mention, selfOpenid = "") {
    if (!mention || typeof mention !== "object") return false
    if (mention.is_you === true) return true
    const ids = [mention.id, mention.member_openid, mention.user_openid].filter(Boolean).map(String)
    if (ids.includes(this.selfId)) return true
    if (selfOpenid && ids.includes(String(selfOpenid))) return true
    if (this.sdk?.self_id && ids.includes(String(this.sdk.self_id))) return true
    const name = this.nickname || this.sdk?.nickname || ""
    if (name && [mention.username, mention.member_nick, mention.member_nickname].some(value => value && String(value) === name)) return true
    if (mention.bot === true && !this.sdk?.self_id) return true
    return false
  }

  detectSelfMention(event) {
    const key = String(event.group_id || "")
    const selfOpenid = this.gl.get(key)?.botOpenid || ""
    let ids = this.botMentionIds.get(key)
    for (const mention of Array.isArray(event.mentions) ? event.mentions : []) {
      if (!this.isSelfMention(mention, selfOpenid)) continue
      if (key && mention.id) {
        if (!ids) this.botMentionIds.set(key, (ids = new Set()))
        ids.add(String(mention.id))
      }
      return true
    }
    if (!ids?.size && !selfOpenid) return false

    const message = Array.isArray(event.message) ? event.message : [event.message]
    for (const elem of message) {
      if (elem?.type !== "at") continue
      const id = String(elem.data?.user_id ?? elem.data?.member_openid ?? "")
      if (id && (id === selfOpenid || ids?.has(id))) return true
    }
    return false
  }

  convertSegments(event, atBot) {
    const list = Array.isArray(event.message) ? event.message : event.message ? [event.message] : []
    const key = String(event.group_id || "")
    const selfMentionIds = this.botMentionIds.get(key)
    const selfOpenid = this.gl.get(key)?.botOpenid || ""
    const mentions = Array.isArray(event.mentions) ? event.mentions : []
    const segments = []

    const pushText = text => {
      if (!text) return
      const last = segments[segments.length - 1]
      if (last?.type === "text") last.text += text
      else segments.push({ type: "text", text })
    }

    const pushAt = raw => {
      const id = String(raw ?? "")
      if (!id) return
      if (id === "all" || id === "everyone") {
        segments.push({ type: "at", qq: "all", name: "全体成员" })
        return
      }
      const mention = mentions.find(item => String(item.id) === id || String(item.member_openid) === id)
      const isSelf = this.isSelfMention(mention, selfOpenid) || id === this.selfId || id === selfOpenid || (this.sdk?.self_id && id === String(this.sdk.self_id)) || !!selfMentionIds?.has(id)
      if (isSelf && key && mention?.id) {
        if (!this.botMentionIds.has(key)) this.botMentionIds.set(key, new Set())
        this.botMentionIds.get(key).add(String(mention.id))
      }
      segments.push({ type: "at", qq: isSelf ? this.selfId : id, name: mention?.username || mention?.member_nickname || mention?.member_nick || "" })
    }

    // 处理 SDK 未解析的 @ 标记
    const pushTextWithMentions = text => {
      if (!text) return
      const pattern = /<qqbot-at-user\s+id="([^"]*)"\s*\/?>|<qqbot-at-everyone\s*\/?>|<@!?([^>]+)>/g
      let last = 0
      for (const match of text.matchAll(pattern)) {
        pushText(text.slice(last, match.index))
        pushAt(match[0].startsWith("<qqbot-at-everyone") ? "all" : match[1] || match[2])
        last = match.index + match[0].length
      }
      pushText(text.slice(last))
    }

    for (const elem of list) {
      if (typeof elem === "string") {
        pushTextWithMentions(elem)
        continue
      }
      const type = elem?.type
      const data = elem?.data || {}
      switch (type) {
        case "text":
          pushTextWithMentions(data.text)
          break
        case "at":
          pushAt(data.user_id === "all" ? "all" : (data.user_id ?? data.member_openid))
          break
        case "face":
          segments.push({ type: "face", id: Number(data.id) })
          break
        case "image":
          segments.push({ type: "image", url: normalizeUrl(data.url || data.file), file: data.url || data.file, name: data.name })
          break
        case "audio":
          segments.push({ type: "record", url: normalizeUrl(data.voice_wav_url || data.url), file: data.voice_wav_url || data.url, name: data.name })
          break
        case "video":
          segments.push({ type: "video", url: normalizeUrl(data.url || data.file), file: data.url || data.file, name: data.name })
          break
        case "file": {
          const url = data.url || data.file
          segments.push({ type: "file", url: normalizeUrl(url), file: url, name: data.name, size: data.size })
          break
        }
        case "reply": {
          const refIdx = String(data.ref_idx || data.id || "")
          const kind = event.group_id ? "group" : "c2c"
          const convId = String(event.group_id || event.sender?.user_openid || event.user_id || "")
          const quoted = refIdx && convId ? this.getMsg(kind, convId, refIdx) : null
          segments.push({ type: "reply", id: quoted?.message_id || refIdx, ref_idx: data.ref_idx })
          break
        }
        case "markdown":
          pushTextWithMentions(data.content || "")
          break
        default:
          break
      }
    }

    if (atBot && !segments.some(item => item.type === "at" && item.qq === this.selfId)) segments.unshift({ type: "at", qq: this.selfId, name: this.botName })
    return segments
  }

  // 发送
  entity(target) {
    if (target.kind === "group") return this.sdk.group(target.id)
    if (target.kind === "c2c") return this.sdk.user(target.id)
    throw new Error(`未知发送目标：${target.kind}`)
  }

  /** 好友/群/群成员对象共用的发送方法 */
  targetApi(target) {
    return {
      sendMsg: msg => this.sendTo(target, msg),
      sendFile: (file, name) => this.sendTo(target, { type: "file", file, name }),
      sendForwardMsg: msg => this.sendTo(target, { type: "node", data: Array.isArray(msg?.data) ? msg.data : Array.isArray(msg) ? msg : [msg] }),
      recallMsg: message_id => this.recallMsg(target, message_id),
    }
  }

  rememberMessage(kind, id, event) {
    const message_id = String(event?.message_id || event?.id || "")
    if (!id || !message_id) return
    const entry = { id: message_id, msg_idx: event.msg_idx, time: Date.now(), used: 0 }
    this.messageRefs.set(message_id, entry)
    if (this.messageRefs.size > 500) {
      const now = Date.now()
      for (const [key, item] of this.messageRefs) if (now - item.time > MESSAGE_REF_TTL) this.messageRefs.delete(key)
    }
    if (kind !== "group") {
      this.c2cSources.set(id, entry)
      return
    }
    let list = this.groupMsgPool.get(id)
    if (!list) this.groupMsgPool.set(id, (list = []))
    if (list.some(item => item.id === message_id)) return
    list.push(entry)
    this.pruneMsgPool(list)
    if (list.length > GROUP_MSG_POOL_MAX) list.splice(0, list.length - GROUP_MSG_POOL_MAX)
  }

  /** 缓存收到的消息，返回本次会话内递增的 message_seq */
  recordHistory(kind, id, data) {
    if (!id) return 0
    const key = `${kind}:${id}`
    let entry = this.histories.get(key)
    if (entry) {
      // 移到末尾，Map 顺序即最近使用顺序
      this.histories.delete(key)
      this.histories.set(key, entry)
    } else {
      if (this.histories.size >= HISTORY_CONVERSATIONS) this.histories.delete(this.histories.keys().next().value)
      entry = { seq: 0, messages: [] }
      this.histories.set(key, entry)
    }
    const message_seq = ++entry.seq
    entry.messages.push({
      message_id: data.message_id,
      message_seq,
      user_id: data.user_id,
      group_id: data.group_id,
      time: data.time,
      sender: { ...data.sender },
      message: Array.isArray(data.message) ? data.message.map(segment => ({ ...segment })) : data.message,
      raw_message: data.raw_message,
      msg_idx: data.msg_idx,
    })
    if (entry.messages.length > HISTORY_MAX) entry.messages.splice(0, entry.messages.length - HISTORY_MAX)
    return message_seq
  }

  copyHistoryMessage(item) {
    return {
      ...item,
      sender: { ...item.sender },
      message: Array.isArray(item.message) ? item.message.map(segment => ({ ...segment })) : item.message,
    }
  }

  /** 本地会话记录：返回 message_seq 及之前的消息；不存在时按时间戳兼容私聊历史调用 */
  getChatHistory(kind, id, message_seq, count = 20, reverseOrder = true) {
    const entry = this.histories.get(`${kind}:${id}`)
    if (!entry?.messages.length) return []
    const list = entry.messages
    let end = list.length
    const seq = Number(message_seq)
    if (Number.isFinite(seq) && seq > 0) {
      const index = list.findIndex(item => item.message_seq === seq)
      if (index >= 0) end = index + 1
      else {
        const timeIndex = list.findIndex(item => item.time > seq)
        if (timeIndex >= 0) end = timeIndex
      }
    }
    const size = Math.min(HISTORY_MAX, Math.max(1, Number(count) || 20))
    const result = list.slice(Math.max(0, end - size), end).map(item => this.copyHistoryMessage(item))
    return reverseOrder === false ? result.reverse() : result
  }

  getMsg(kind, id, message_id) {
    const entry = this.histories.get(`${kind}:${id}`)
    const key = String(message_id || "")
    if (!entry || !key) return null
    const found = entry.messages.find(item => String(item.message_id) === key || (item.msg_idx && String(item.msg_idx) === key))
    return found ? this.copyHistoryMessage(found) : null
  }

  pruneMsgPool(list) {
    const now = Date.now()
    while (list.length && (now - list[0].time >= GROUP_PASSIVE_TTL || list[0].used >= GROUP_PASSIVE_LIMIT)) list.shift()
  }

  /** 取一条 110 秒内、回复次数未满的群消息 ID；每次发送消耗一次 */
  pickMsgId(group_id) {
    const list = this.groupMsgPool.get(group_id)
    if (!list?.length) return undefined
    this.pruneMsgPool(list)
    const entry = list[0]
    if (!entry) return undefined
    entry.used += 1
    if (entry.used >= GROUP_PASSIVE_LIMIT) list.shift()
    return entry
  }

  /** 只查不消耗，用于引用消息时取 msg_idx */
  getMessageRef(message_id) {
    const entry = this.messageRefs.get(message_id)
    if (!entry) return undefined
    if (Date.now() - entry.time > MESSAGE_REF_TTL) {
      this.messageRefs.delete(message_id)
      return undefined
    }
    return entry
  }

  pickPassiveSource(target) {
    if (!this.passiveReply) return undefined
    if (target.kind === "group") {
      const entry = this.pickMsgId(target.id)
      return entry ? { id: entry.id, msg_idx: entry.msg_idx } : undefined
    }
    const entry = this.c2cSources.get(target.id)
    if (!entry) return undefined
    if (Date.now() - entry.time > C2C_PASSIVE_TTL) {
      this.c2cSources.delete(target.id)
      return undefined
    }
    return { id: entry.id, msg_idx: entry.msg_idx }
  }

  // 兼容本项目内部 segment 与 OneBot 的 { type, data } 两种写法
  normalizeSegment(segment) {
    if (segment === undefined || segment === null) return null
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
      case "file": {
        const type = segment.type === "audio" ? "record" : segment.type
        return {
          type,
          file: segment.file ?? segment.url ?? data?.file ?? data?.url ?? raw,
          url: segment.url ?? data?.url,
          name: segment.name ?? data?.name ?? segment.file_name ?? data?.file_name,
        }
      }
      case "node":
        return { type: "node", data: Array.isArray(segment.data) ? segment.data : Array.isArray(data?.data) ? data.data : [] }
      case "markdown":
        return { type: "markdown", data: segment.data ?? data?.data }
      case "face":
        return { type: "face", id: Number(segment.id ?? data?.id ?? raw) }
      default:
        return segment
    }
  }

  async sendTo(target, msg) {
    if (!target?.id) throw new Error("发送目标为空")
    const list = Array.isArray(msg) ? msg : [msg]
    const segments = []
    for (const item of list) {
      const segment = this.normalizeSegment(item)
      if (segment) segments.push(segment)
    }

    const context = { reply: null, replyUsed: false }
    const replySegment = segments.find(item => item.type === "reply")
    if (replySegment) this.applyReply(replySegment, context)
    const results = []
    let inline = []

    const sendBatch = async elements => {
      if (!elements.length) return
      if (context.reply && !context.replyUsed) {
        elements = [context.reply, ...elements]
        context.replyUsed = true
      }
      results.push(await this.dispatchSend(target, elements))
    }

    const flushInline = async () => {
      if (!inline.length) return
      let batch = []
      let length = 0
      const flush = async () => {
        if (!batch.length) return
        const value = batch
        batch = []
        length = 0
        await sendBatch(value)
      }
      for (const element of inline) {
        if (element.type === "text") {
          let rest = element.data.text || ""
          while (rest.length) {
            const room = TEXT_LIMIT - length
            if (room <= 0) {
              await flush()
              continue
            }
            const [part, remain] = splitText(rest, room)
            rest = remain
            batch.push(sdkSegment.text(sanitizeText(part)))
            length += part.length
            if (length >= TEXT_LIMIT) await flush()
          }
        } else {
          if (length >= TEXT_LIMIT) await flush()
          batch.push(element)
          length += 1
        }
      }
      await flush()
      inline = []
    }

    for (const segment of segments) {
      if (segment.type === "reply") continue
      switch (segment.type) {
        case "text":
          inline.push(sdkSegment.text(segment.text))
          break
        case "at":
          if (target.kind === "group" && segment.qq && segment.qq !== this.selfId && segment.qq !== String(this.sdk?.self_id || "")) inline.push(sdkSegment.at(segment.qq))
          break
        case "face":
          inline.push(sdkSegment.face(Number(segment.id) || 0))
          break
        case "node": {
          const text = this.forwardText(segment.data)
          if (text) inline.push(sdkSegment.text(text))
          break
        }
        case "markdown":
          await flushInline()
          await sendBatch([sdkSegment.markdown(sanitizeText(segment.data?.content ?? segment.data ?? ""))])
          break
        case "image":
          await flushInline()
          await sendBatch([sdkSegment.image(segment.file ?? segment.url, { url: segment.url, name: segment.name })])
          break
        case "video":
          await flushInline()
          await sendBatch([sdkSegment.video(segment.file ?? segment.url, { url: segment.url, name: segment.name })])
          break
        case "record": {
          await flushInline()
          const silk = await toSilk(segment.file ?? segment.url, segment.name || "voice")
          const base = path.basename(String(segment.name || "voice"), path.extname(String(segment.name || ""))) || "voice"
          await sendBatch([sdkSegment.audio(silk, { name: `${base}.silk` })])
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

    const done = results.filter(Boolean)
    if (done.length === 1) return done[0]
    const message_id = done.map(item => item?.id ?? item?.message_id).filter(Boolean)
    return done.length ? { data: done, message_id } : null
  }

  applyReply(segment, context) {
    const id = String(segment.id || "")
    const refIdx = String(segment.ref_idx || "")
    if (!id && !refIdx) return
    const ref = id ? this.getMessageRef(id) : undefined
    if (ref?.msg_idx) {
      context.reply = sdkSegment.reply({ ref_idx: ref.msg_idx })
      return
    }
    if (refIdx || /^REFIDX_/i.test(id)) context.reply = sdkSegment.reply({ ref_idx: refIdx || id })
    else Bot.makeLog("debug", ["QQ机器人无法引用该消息", id], this.selfId)
  }

  async dispatchSend(target, elements) {
    let sendElements = elements
    if (this.useMarkdown && elements.length) {
      const texts = elements.filter(item => item.type === "text")
      const rest = elements.filter(item => item.type !== "text")
      if (texts.length && rest.every(item => item.type === "reply")) {
        sendElements = [...rest, sdkSegment.markdown(sanitizeText(texts.map(item => item.data.text).join("")))]
      }
    }

    try {
      return await this.sendEntities(target, sendElements)
    } catch (err) {
      if (!MARKDOWN_ERROR.test(err.message)) throw err
      if (sendElements !== elements) return this.sendEntities(target, elements)
      const plain = elements.flatMap(item => {
        if (item.type === "markdown") return [sdkSegment.text(sanitizeText(item.data.content || ""))]
        if (item.type === "at") return []
        return [item]
      })
      if (!plain.length) throw err
      return this.sendEntities(target, plain)
    }
  }

  /** 令牌失效时刷新一次再重试，文本/文件发送共用 */
  async retryAuth(fn) {
    try {
      return await fn()
    } catch (err) {
      if (!AUTH_ERROR.test(err.message)) throw err
      Bot.makeLog("debug", ["Authorization 失效，刷新令牌后重试", err.message], this.selfId)
      await this.sdk.sessionManager.getAccessToken()
      return fn()
    }
  }

  async sendEntities(target, elements) {
    const entity = this.entity(target)
    const source = this.pickPassiveSource(target)
    const label = { group: "群", c2c: "好友" }[target.kind] || target.kind
    Bot.makeLog("info", `发送${label}消息：${this.makeLog(this.describeElements(elements))}`, `${this.selfId} => ${target.id}`, true)

    let ret
    try {
      ret = await this.retryAuth(() => entity.send(elements, source))
    } catch (err) {
      if (source && PASSIVE_ERROR.test(err.message)) {
        Bot.makeLog("debug", ["被动回复失败，改为主动发送", err.message], this.selfId)
        ret = await this.retryAuth(() => entity.send(elements))
      } else throw err
    }
    const result = { ...(ret || {}) }
    if (result.id !== undefined && result.message_id === undefined) result.message_id = result.id
    return result
  }

  describeElements(elements) {
    return elements
      .map(item => {
        if (item.type === "text") return item.data?.text || ""
        if (item.type === "markdown") return item.data?.content || ""
        return `<${item.type}>`
      })
      .join("")
  }

  async sendFileTo(target, segment, context) {
    if (target.kind !== "group" && target.kind !== "c2c") throw new Error("当前会话不支持发送文件")
    const entity = this.entity(target)
    const name = segment.name || fileNameFrom(segment.file ?? segment.url)
    const uploaded = await this.retryAuth(() => entity.upload(segment.file ?? segment.url, { fileType: 4, fileName: name, sendMessage: false }))
    if (!uploaded?.file_info) throw new Error("上传文件失败")

    // 上传可能较久，传完再取被动回复的 msg_id
    const source = this.pickPassiveSource(target)
    const endpoint = target.kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`
    const payload = { content: "", msg_type: 7, media: { file_info: uploaded.file_info }, msg_seq: randomInt(1, 1_000_000) }
    if (source?.id) payload.msg_id = source.id
    const refIdx = String(context?.reply?.data?.ref_idx || "")
    if (refIdx && !context.replyUsed) {
      payload.message_reference = { message_id: refIdx }
      context.replyUsed = true
    }
    const post = () => this.sdk.request.post(endpoint, payload, { timeout: 60000 })

    Bot.makeLog("info", `发送文件：${name}`, `${this.selfId} => ${target.id}`, true)
    try {
      const { data } = await this.retryAuth(post)
      return { ...(data || {}), message_id: data?.id }
    } catch (err) {
      if (!payload.msg_id || !PASSIVE_ERROR.test(err.message)) throw err
      delete payload.msg_id
      const { data } = await this.retryAuth(post)
      return { ...(data || {}), message_id: data?.id }
    }
  }

  forwardText(nodes) {
    if (!Array.isArray(nodes)) nodes = [nodes]
    const lines = []
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue
      const name = node.nickname || node.name || node.data?.name || node.user_id || ""
      const content = node.message ?? node.content ?? node.data?.content ?? ""
      const list = Array.isArray(content) ? content : [content]
      let line = ""
      for (const segment of list) {
        if (typeof segment === "string") line += segment
        else if (segment?.type === "text") line += segment.text ?? segment.data?.text ?? ""
        else if (segment?.type === "at") line += `@${segment.name || segment.qq || segment.data?.qq || ""}`
        else if (segment?.type === "image") line += "[图片]"
        else if (segment?.type === "record" || segment?.type === "audio") line += "[语音]"
        else if (segment?.type === "video") line += "[视频]"
        else if (segment?.type === "file") line += `[文件:${segment.name || segment.data?.name || ""}]`
      }
      lines.push(`${name ? `${name}: ` : ""}${line}`)
    }
    return lines.length ? ["[合并转发]", ...lines].join("\n") : ""
  }

  /** 由 bot_state 的 recv_msg_setting 决定；未知时按只收到 @/上下文消息处理 */
  isGroupAllMessages(group_id) {
    return this.gl.get(group_id)?.allMessages === true
  }

  async refreshGroupState(group_id) {
    try {
      const state = await this.ensureBotState(group_id)
      if (!state) return
      const group = this.gl.get(group_id)
      if (group && state.recv_msg_setting) group.allMessages = state.recv_msg_setting === "all"
      if (group && state.member_openid) group.botOpenid = String(state.member_openid)
      const gml = this.gml.get(group_id)
      if (gml) {
        const self = gml.get(this.selfId) || { user_id: this.selfId, nickname: this.botName, card: this.botName, avatar: this.avatar || "" }
        self.role = state.member_role || ""
        gml.set(this.selfId, self)
      }
    } catch {}
  }

  ensureBotState(group_id) {
    const cached = this.botStates.get(group_id)
    if (cached && Date.now() - cached.time < 600000) return Promise.resolve(cached.state)
    if (cached?.promise) return cached.promise

    const promise = this.sdk
      .group(group_id)
      .botState()
      .then(state => {
        this.botStates.set(group_id, { state, time: Date.now() })
        return state
      })
      .catch(() => {
        this.botStates.set(group_id, { state: null, time: Date.now() })
        return null
      })
    this.botStates.set(group_id, { ...(cached || {}), promise })
    return promise.finally(() => {
      const entry = this.botStates.get(group_id)
      if (entry?.promise) delete entry.promise
    })
  }

  async getGroupName(group_id) {
    const cached = this.groupInfo.get(group_id)
    if (cached && Date.now() - cached.time < (cached.ttl || 3600000)) return cached.name
    if (cached?.promise) return cached.promise

    const promise = this.sdk
      .group(group_id)
      .info()
      .then(info => {
        const name = info?.group_name || ""
        this.groupInfo.set(group_id, { name, time: Date.now(), ttl: name ? 3600000 : 300000 })
        return name
      })
      .catch(() => {
        this.groupInfo.set(group_id, { name: "", time: Date.now(), ttl: 300000 })
        return ""
      })
    this.groupInfo.set(group_id, { ...(cached || {}), promise })
    try {
      return await promise
    } finally {
      const entry = this.groupInfo.get(group_id)
      if (entry?.promise) delete entry.promise
    }
  }

  // Bot 对象
  setupBot() {
    const self_id = this.selfId
    if (Bot.bots[self_id]) {
      if (Bot.bots[self_id].adapter === this) return true
      Bot.makeLog("error", [`QQ机器人 AppID ${self_id} 已存在同名 Bot，跳过加载`], this.id)
      return false
    }

    const adapter = this
    Bot[self_id] = {
      adapter: this,
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
      sendApi: (method, url, data) => adapter.sdk.request({ method, url, data }).then(res => res.data),
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

  emitConnect() {
    Bot.em(`connect.${this.selfId}`, { self_id: this.selfId, time: Math.floor(Date.now() / 1000) })
  }

  pickFriend(user_id) {
    user_id = String(user_id)
    const info = this.fl.get(user_id) || {}
    const target = { kind: "c2c", id: user_id }
    return {
      ...info,
      ...this.targetApi(target),
      user_id,
      name: info.nickname || user_id,
      nickname: info.nickname || user_id,
      avatar: info.avatar || "",
      getInfo: async () => {
        const user = await this.sdk
          .user(user_id)
          .info()
          .catch(() => null)
        if (!user) return { user_id, nickname: info.nickname || user_id }
        const avatar = normalizeUrl(user.avatar) || info.avatar || ""
        const ret = { user_id, ...user, avatar, nickname: user.username || info.nickname || user_id }
        this.fl.set(user_id, { ...info, ...ret })
        return ret
      },
      getAvatarUrl: () => info.avatar || "",
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
    const target = { kind: "group", id: group_id }
    return {
      ...info,
      ...this.targetApi(target),
      group_id,
      name: info.group_name || info.name || group_id,
      group_name: info.group_name || info.name || group_id,
      getInfo: async () => {
        const ret = await this.sdk
          .group(group_id)
          .info()
          .catch(() => ({}))
        if (ret.group_name) {
          this.groupInfo.set(group_id, { name: ret.group_name, time: Date.now(), ttl: 3600000 })
          const group = this.gl.get(group_id)
          if (group) group.group_name = group.name = ret.group_name
        }
        return { group_id, ...ret, group_name: ret.group_name || info.group_name || "" }
      },
      getAvatarUrl: () => "",
      getChatHistory: (message_seq, count, reverseOrder = true) => this.getChatHistory("group", group_id, message_seq, count, reverseOrder),
      getMsg: message_id => this.getMsg("group", group_id, message_id),
      pickMember: user_id => this.pickMember(group_id, user_id),
      getMemberArray: () => this.memberArray(group_id),
      getMemberList: async () => (await this.memberArray(group_id)).map(item => item.user_id),
      getMemberMap: async () => {
        await this.memberArray(group_id)
        return this.gml.get(group_id) || new Map()
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
    const cached = [...(this.gml.get(group_id)?.values() || [])]
    const list = await this.sdk.getGroupMemberList(group_id).catch(() => null)
    if (!Array.isArray(list)) return cached
    let gml = this.gml.get(group_id)
    if (!gml) this.gml.set(group_id, (gml = new Map()))
    const ret = []
    for (const member of list) {
      const user_id = String(member.member_openid || "")
      if (!user_id) continue
      const prev = gml.get(user_id) || {}
      const name = member.username || prev.nickname || user_id
      const item = { user_id, nickname: name, card: prev.card || name, role: member.member_role || prev.role || "", avatar: prev.avatar || "" }
      gml.set(user_id, { ...prev, ...item })
      ret.push(gml.get(user_id))
    }
    return ret
  }

  pickMember(group_id, user_id) {
    group_id = String(group_id)
    user_id = String(user_id)
    const target = { kind: "group", id: group_id }

    if (user_id === this.selfId) {
      const name = this.botName
      const role = this.gml.get(group_id)?.get(this.selfId)?.role || ""
      return {
        ...this.targetApi(target),
        group_id,
        user_id,
        name,
        nickname: name,
        card: name,
        role,
        avatar: this.avatar || "",
        getInfo: async () => ({ user_id, nickname: name, card: name, role }),
        getAvatarUrl: () => this.avatar || "",
        is_owner: role === "owner",
        is_admin: role === "owner" || role === "admin",
      }
    }

    const info = this.gml.get(group_id)?.get(user_id) || {}
    return {
      ...info,
      ...this.targetApi(target),
      group_id,
      user_id,
      name: info.card || info.nickname || user_id,
      nickname: info.nickname || user_id,
      card: info.card || "",
      avatar: info.avatar || "",
      sendMsg: msg => this.sendTo(target, [{ type: "at", qq: user_id }, ...(Array.isArray(msg) ? msg : [msg])]),
      getInfo: async () => {
        const member = await this.sdk.getGroupMemberInfo(group_id, user_id).catch(() => null)
        if (!member) return info
        const name = member.username || info.nickname || user_id
        const ret = { ...info, user_id, nickname: name, card: info.card || name, role: member.member_role || info.role }
        const gml = this.gml.get(group_id)
        if (gml) gml.set(user_id, { ...info, ...ret })
        return ret
      },
      getAvatarUrl: () => info.avatar || "",
      is_owner: info.role === "owner",
      is_admin: info.role === "owner" || info.role === "admin",
    }
  }

  async recallMsg(target, message_id) {
    if (!message_id) return
    const ids = Array.isArray(message_id) ? message_id : [message_id]
    const entity = this.entity(target)
    const rets = []
    for (const id of ids) {
      rets.push(
        await entity.recall(id).catch(err => {
          Bot.makeLog("debug", ["撤回消息失败", id, err.message], this.selfId)
          return err
        }),
      )
    }
    return rets.length === 1 ? rets[0] : rets
  }

  async muteGroupMember(group_id, user_id, duration) {
    const group = this.sdk.group(group_id)
    const seconds = Number(duration) || 0
    if (seconds <= 0) return group.unmute(String(user_id))
    return group.mute(String(user_id), new Date(Date.now() + seconds * 1000).toISOString())
  }

  async kickGroupMembers(group_id, user_ids) {
    const ids = (Array.isArray(user_ids) ? user_ids : [user_ids]).map(String).filter(Boolean)
    if (!ids.length) return
    const group = this.sdk.group(group_id)
    const results = []
    // 官方限制单次最多 20 个
    for (let i = 0; i < ids.length; i += 20) results.push(await group.removeMembers({ member_openids: ids.slice(i, i + 20) }))
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
    const usable = bots.filter(item => String(item.appid || "").trim() && String(item.secret || "").trim())
    if (!usable.length) return Bot.makeLog("warn", "QQ机器人未配置 appid 或 secret，跳过加载", this.id)

    const ports = new Set()
    for (const [index, item] of bots.entries()) {
      const botConfig = { ...item }
      const appid = String(botConfig.appid || "").trim()
      const secret = String(botConfig.secret || "").trim()
      if (!appid || !secret) {
        Bot.makeLog("warn", `QQ机器人第 ${index + 1} 项未配置 appid 或 secret，已跳过`, this.id)
        continue
      }
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
