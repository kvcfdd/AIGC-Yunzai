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

/**
 * 解析 LLM 回复中的 XML 标签 → [{ type: "reply"|"voice", text }]
 * 无标签返回空数组。
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
