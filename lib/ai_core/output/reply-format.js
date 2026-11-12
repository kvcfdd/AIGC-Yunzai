import { faceId } from "../helpers/face.js"
import { stripQuotePrefix } from "../llm/message-builders.js"

export { stripQuotePrefix }

/** LLM 回复 → QQ 消息段: @name/@QQ 转为 at，[表情名] 转为表情 */
export function toMessageSegments(text, event) {
  if (typeof text !== "string" || !text) return text

  const parts = []
  let last = 0
  // @mention: 前面有无空格均可，后面必须空格或结尾；face: [中文/A-Z]
  const re = /(\s?)@([\p{Script=Han}\w]+)(?=\s|$)|\[([\p{Script=Han}\w]+)\]/gu
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", data: { text: text.slice(last, m.index) } })
    if (m[2]) {
      if (m[1]) parts.push({ type: "text", data: { text: m[1] } })
      const target = m[2]
      if (/^\d+$/.test(target)) {
        parts.push(segment.at(target))
      } else {
        let qq = null
        try {
          if (event?.isGroup) {
            const ml = Bot.gml?.get(event.group_id)
            if (ml)
              for (const [id, info] of ml) {
                if (info.card === target || info.nickname === target) {
                  qq = id
                  break
                }
              }
          }
        } catch {}
        qq ? parts.push(segment.at(qq)) : parts.push({ type: "text", data: { text: m[0] } })
      }
    } else if (m[3]) {
      const id = faceId(m[3])
      parts.push(id >= 0 ? { type: "face", id } : { type: "text", data: { text: m[0] } })
    }
    last = m.index + m[0].length
  }
  if (!parts.length) return text
  if (last < text.length) parts.push({ type: "text", data: { text: text.slice(last) } })
  return parts
}

/** 自动分条：连续换行作为消息分隔 */
const AUTO_SPLIT_RE = /\n\s*\n/
/** 代码块围栏 */
const CODE_FENCE_RE = /(^|\n)\s*(?:```|~~~)/
/** 代码行特征：缩进代码块、常见语句开头、箭头函数或括号/分号结尾 */
const CODE_LINE_RE = /^(?: {4,}\S|\s*(?:import|export|const|let|var|function|class|def|async|await|return|if|for|while|switch|try|catch|throw|#include|package|public|private|SELECT|INSERT|UPDATE|DELETE|CREATE)\b|.*(?:=>|[{};])\s*$)/
/** 语音段 */
const VOICE_TAG_RE = /<voice>([\s\S]*?)<\/voice>/gi
/** 文本中残留的协议标签，发送前清除避免泄漏给用户 */
const RESIDUAL_TAG_RE = /<\/?(?:reply|voice|xix)>/gi
/** QQ 表情标记 [表情名] */
const FACE_TAG_RE = /\[[\p{Script=Han}\w]{1,12}\]/gu
/** Unicode 表情：图形符号、旗帜、肤色、变体选择符、零宽连接符、键帽 */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu

/** 清除回复协议标签，避免模型输出原样泄漏 */
export function stripReplyTags(text) {
  return typeof text === "string" ? text.replace(RESIDUAL_TAG_RE, "") : text
}

/** 粗略判断回复是否为代码，避免自动分条把代码切散 */
function looksLikeCode(text) {
  if (CODE_FENCE_RE.test(text)) return true
  const lines = text.split("\n").filter(line => line.trim())
  if (lines.length < 2) return false
  const codeLines = lines.filter(line => CODE_LINE_RE.test(line)).length
  return codeLines >= 2 && codeLines / lines.length >= 0.5
}

/**
 * 解析 LLM 回复 → 消息段 [{ type: "text"|"voice", text }]
 *  - 文字与语音二选一：出现语音时只发一条语音，忽略文字与多余语音
 *  - maxChars 大于 0 时，非代码且短于该长度的纯文本按连续换行分条；0 表示关闭
 *  - 空内容返回空数组
 */
export function parseReplyParts(text, { maxChars = 0 } = {}) {
  if (typeof text !== "string") return []

  // 语音一次一条：取第一条非空 <voice>，其余内容一律丢弃
  const re = new RegExp(VOICE_TAG_RE.source, "gi")
  let m
  while ((m = re.exec(text)) !== null) {
    const voiceText = m[1].trim()
    if (voiceText) return [{ type: "voice", text: voiceText }]
  }

  // 纯文本：清除残留协议标签，按需自动分条
  const cleaned = stripReplyTags(text).trim()
  if (!cleaned) return []
  const limit = Number(maxChars)
  const pieces = Number.isFinite(limit) && limit > 0 && cleaned.length < limit && !looksLikeCode(cleaned) ? cleaned.split(AUTO_SPLIT_RE) : [cleaned]
  return pieces
    .map(piece => piece.trim())
    .filter(Boolean)
    .map(piece => ({ type: "text", text: piece }))
}

/** 语音合成前清洗文本：去除标签、QQ 表情、emoji 等不可朗读内容 */
export function sanitizeVoiceText(text) {
  if (typeof text !== "string") return ""
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/(\*\*|__|~~|`)(.+?)\1/gs, "$2")
    .replace(FACE_TAG_RE, "")
    .replace(EMOJI_RE, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
