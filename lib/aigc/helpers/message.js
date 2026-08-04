import { faceName } from "./face.js"
import { dateStr } from "../conversation.js"

/**
 * 解析 LLM 回复中的 XML 标签 → [{ type: "reply"|"voice", text }]
 * 无标签返回空数组。
 *
 * 支持的标签:
 *   <reply>文本消息</reply>
 *   <voice>TTS 语音文本</voice>
 */
export function parseTaggedReply(text) {
  const parts = []
  const re = /<(reply|voice)>(.*?)<\/\1>/gs
  let m
  while ((m = re.exec(text)) !== null) {
    const content = m[2].trim()
    if (content) parts.push({ type: m[1], text: content })
  }
  return parts
}

/**
 * 格式化群聊消息时间戳 → 显示用时间字符串
 * - 今天 → "HH:mm"
 * - 昨天 → "昨天HH:mm"
 * - 更早 → "一天前"
 */
export function formatHistoryTime(timestamp) {
  if (!timestamp) return ""
  const now = new Date()
  const msgTime = new Date(timestamp * 1000)
  const pad = n => String(n).padStart(2, "0")

  const today = dateStr(now)
  const msgDate = dateStr(msgTime)

  if (msgDate === today) {
    return `${pad(msgTime.getHours())}:${pad(msgTime.getMinutes())}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (msgDate === dateStr(yesterday)) {
    return `昨天${pad(msgTime.getHours())}:${pad(msgTime.getMinutes())}`
  }

  return "一天前"
}

/**
 * 从群聊原始消息数组中提取所有发送者 QQ
 */
export function extractUsersFromHistory(rawMsgs, selfId) {
  const userIds = new Set()
  for (const msg of rawMsgs) {
    const senderId = msg.sender?.user_id
    if (senderId && String(senderId) !== String(selfId)) {
      userIds.add(String(senderId))
    }
  }
  return userIds
}

/**
 * 从 provider 响应构建待持久化的 assistant 消息对象
 */
export function buildAssistantMsg(res) {
  return {
    role: "assistant",
    content: res.content || null,
    ...(res.tool_calls && { tool_calls: res.tool_calls }),
    ...(res.reasoning_content && {
      reasoning_content: res.reasoning_content,
    }),
    ...(res.reasoning_parts && { reasoning_parts: res.reasoning_parts }),
  }
}

/**
 * 构建 user 消息的公共元数据
 */
export function userMsgMeta(e) {
  const meta = {
    time: Date.now(),
    chat_type: e.isGroup ? "群聊" : "私聊",
  }
  if (e.isGroup) meta.group_name = e.group_name || ""
  return meta
}

/**
 * 将 QQ 消息段重建为完整文本，保留 @/表情/图片/文件 等上下文。
 *
 * @param {object} msg — 原始 QQ 消息对象
 * @param {(qq: string) => string} resolveAtName — QQ号 → 显示名 的解析函数
 * @returns {string}
 */
export function extractMsgText(msg, resolveAtName) {
  const message = msg.message
  if (!message) {
    return (msg.raw_message || "").replace(/\[CQ:[^\]]+\]/g, "").trim()
  }
  if (typeof message === "string") return message
  if (!Array.isArray(message)) return ""

  const parts = []
  for (const seg of message) {
    if (seg.type === "text") {
      parts.push(seg.text || "")
    } else if (seg.type === "at") {
      parts.push(`@${resolveAtName(seg.qq)}`)
    } else if (seg.type === "image") {
      const url = seg.url || ""
      parts.push(url ? `[图片](${url})` : "[图片]")
    } else if (seg.type === "file") {
      parts.push("[文件]")
    } else if (seg.type === "face") {
      const name = faceName(seg.id)
      parts.push(name ? `[${name}]` : "[表情]")
    } else if (seg.type === "video") {
      const url = seg.url || seg.file || ""
      parts.push(url ? `[视频](${url})` : "[视频]")
    } else if (seg.type === "record" || seg.type === "audio") {
      parts.push("[语音]")
    } else if (seg.type === "json") {
      const data = typeof seg.data === "string" ? JSON.parse(seg.data) : seg.data || {}
      const meta = data?.meta?.detail_1 || data?.meta?.detail || data
      const title = meta?.title || meta?.desc || ""
      const url = meta?.url || meta?.qqdocurl || ""
      parts.push(title ? `[小程序: ${title}](${url})` : url ? `[分享](${url})` : "[分享]")
    } else if (seg.type === "markdown") {
      parts.push("[Markdown]")
    } else if (seg.type === "forward") {
      parts.push("[合并转发]")
    }
  }
  return parts.join("").trim()
}

/**
 * 格式化群聊历史消息数组 → 文本行。
 *
 * @param {Array} msgs — getChatHistory 返回的原始消息数组
 * @param {(qq: string) => string} resolveAtName — QQ号 → 显示名
 * @param {string} selfId — bot 自身 QQ
 * @param {object} masterCfg — cfg.master 配置 { [bot_id]: [master_qqs] }
 * @returns {string|null}
 */
export function formatGroupHistory(msgs, resolveAtName, selfId, masterCfg) {
  const lines = []
  for (const msg of msgs) {
    const sender = msg.sender || {}
    const name = sender.card || sender.nickname || "Unknown"
    const qq = sender.user_id || "?"
    const role = { owner: "群主", admin: "群管理员" }[sender.role] || ""
    const isMaster = masterCfg[selfId]?.includes(String(qq))
    const masterLabel = isMaster ? ", bot owner (master)" : ""

    const text = extractMsgText(msg, resolveAtName)
    if (!text) continue

    const timeStr = formatHistoryTime(msg.time)
    const timePart = timeStr ? `[${timeStr}] ` : ""

    lines.push(`${timePart}[${name}](QQ: ${qq}${role ? `, ${role}` : ""}${masterLabel}): ${text}`)
  }

  return lines.length ? lines.join("\n") : null
}
