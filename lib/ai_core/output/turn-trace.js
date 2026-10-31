import { formatUsage } from "../llm/usage.js"

/** 本轮过程轨迹 → 转发文本段。
 *
 *  按发生顺序逐段输出:
 *  - 每段思维链单独一条
 *  - 每轮工具调用/工具结果/中间输出共用一条，空行隔开
 *  - 最后一条为本轮全部请求的 token 用量合计
 *
 *  最终答复正文由正常回复发送，不重复放进轨迹。
 */

/** 思维链上限 2000 字 */
const MAX_THINKING_CHARS = 2000
/** 工具结果/中间输出上限 200 字 */
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
 * @param {{ maxChars?: number, thinkingChars?: number, usage?: object }} [opts]
 * @returns {string[]} 每个转发节点一段文本；无内容时返回空数组
 */
export function buildTurnTrace(messages = [], { maxChars = MAX_SECTION_CHARS, thinkingChars = MAX_THINKING_CHARS, usage } = {}) {
  const nodes = []
  let actionSections = null
  const lastIndex = messages.length - 1

  const flushActions = () => {
    if (actionSections?.length) nodes.push(actionSections.join("\n\n"))
    actionSections = null
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue

    if (m.role === "assistant") {
      flushActions()

      const thinking = reasoningText(m)
      if (thinking) nodes.push(clip(thinking, thinkingChars))

      if (m.tool_calls?.length) {
        actionSections = m.tool_calls.map(tc => {
          const name = tc?.function?.name || "unknown"
          const args = clip(tc?.function?.arguments ?? "", MAX_ARGS_CHARS) || "{}"
          return `【调用工具】${name}\n${args}`
        })
        // 最终答复正文已由正常回复发出，轨迹只保留它的思考；no_reply 中间输出不转发
        const interim = String(m.content ?? "").trim()
        if (interim && i !== lastIndex && !/^no_reply$/i.test(interim)) actionSections.push(`【中间输出】\n${clip(interim, maxChars)}`)
      }
      continue
    }

    if (m.role === "tool") {
      const name = m.name || "unknown"
      const label = m.is_error ? `【工具结果】${name}（失败）` : `【工具结果】${name}`
      const section = `${label}\n${clip(m.content, maxChars) || "(空)"}`
      if (actionSections) actionSections.push(section)
      else actionSections = [section]
    }
    // user 消息是本轮触发输入，聊天里已可见，不重复转发
  }
  flushActions()

  if (usage) nodes.push(formatUsage(usage))
  return nodes
}
