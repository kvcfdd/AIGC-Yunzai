import { extractMsgText } from "./message-format.js"
import { classifyFileExt } from "../media/ingest.js"

/** QQ号 → 显示名: 全体成员 / 群名片 / 昵称 / QQ号 */
export function resolveAtName(event, qq, bot = globalThis.Bot) {
  if (qq === "all") return "全体成员"
  try {
    if (event?.isGroup) {
      const gid = event.group_id
      const ml = bot?.gml?.get(Number(gid)) || bot?.gml?.get(String(gid))
      if (ml) {
        const info = ml.get(Number(qq)) || ml.get(String(qq))
        if (info) return info.card || info.nickname || String(qq)
      }

      const m = bot?.pickMember?.(gid, qq)
      if (m) return m.card || m.nickname || String(qq)
    } else {
      if (String(qq) === String(event?.user_id)) return event?.sender?.nickname || event?.friend?.nickname || String(qq)
      if (String(qq) === String(event?.self_id)) return bot?.[event?.self_id]?.nickname || String(qq)
    }
  } catch {
    // 避免解析异常导致流程中断
  }
  return String(qq)
}

/** 从原始消息段重建完整文本 — 文本仅占位不带 url */
export function getUserMessageText(event, resolve = qq => resolveAtName(event, qq)) {
  const text = extractMsgText(event, resolve, { withUrl: false })
  return text || event.msg?.trim() || ""
}

/** 单条输入 = 一个 turn：文本 + 该消息自带的媒体引用 */
export function buildTurn(event, text) {
  const turn = { text, imgs: [], videos: [], audios: [], files: [] }
  if (!Array.isArray(event.message)) return turn

  for (const seg of event.message) {
    const src = seg?.url || seg?.file
    if (!src) continue
    if (seg.type === "image") turn.imgs.push(src)
    else if (seg.type === "video") turn.videos.push(src)
    else if (seg.type === "record" || seg.type === "audio") turn.audios.push(src)
    else if (seg.type === "file") {
      const kind = classifyFileExt(seg.name)
      if (kind === "image") turn.imgs.push(src)
      else if (kind === "video") turn.videos.push(src)
      else if (kind === "audio") turn.audios.push(src)
      else turn.files.push(seg)
    }
  }
  return turn
}
