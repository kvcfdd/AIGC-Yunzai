/** 本轮过程轨迹 → 转发文本段。
 *
 *  覆盖本轮触发后到最终输出前的所有操作:
 *  思维链、工具调用、工具结果、中间输出。
 *  最终答复正文由正常回复发送，不重复放进轨迹。
 */

/** 单个文本段上限，转发内容最多 200 字 */
const MAX_SECTION_CHARS = 200
/** 工具调用参数上限 */
const MAX_ARGS_CHARS = 200

function clip(text, max) {
  const s = String(text ?? "").trim()
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s
}

/** 思维链文本 — 不同适配器可能只给 reasoning_parts */
function reasoningText(m) {
  if (m.reasoning_content) return m.reasoning_content
  return (m.reasoning_parts || [])
    .map(p => p?.text)
    .filter(Boolean)
    .join("")
}

/**
 * @param {Array<object>} messages 本轮 localPending 消息（含 user/assistant/tool）
 * @param {{ maxChars?: number }} [opts]
 * @returns {string[]} 每个转发节点一段文本；无内容时返回空数组
 */
export function buildTurnTrace(messages = [], { maxChars = MAX_SECTION_CHARS } = {}) {
  const nodes = []
  const lastIndex = messages.length - 1

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue

    if (m.role === "assistant") {
      const parts = []

      const thinking = reasoningText(m)
      if (thinking) parts.push(`【思考】\n${clip(thinking, maxChars)}`)

      for (const tc of m.tool_calls || []) {
        const name = tc?.function?.name || "unknown"
        const args = clip(tc?.function?.arguments ?? "", MAX_ARGS_CHARS) || "{}"
        parts.push(`【调用工具】${name}\n${args}`)
      }

      // 最终答复正文已由正常回复发出，轨迹只保留它的思考
      if (m.content && i !== lastIndex) parts.push(`【中间输出】\n${clip(m.content, maxChars)}`)

      if (parts.length) nodes.push(parts.join("\n\n"))
      continue
    }

    if (m.role === "tool") {
      const name = m.name || "unknown"
      const label = m.is_error ? `【工具结果】${name}（失败）` : `【工具结果】${name}`
      nodes.push(`${label}\n${clip(m.content, maxChars) || "(空)"}`)
    }
    // user 消息是本轮触发输入，聊天里已可见，不重复转发
  }

  return nodes
}
