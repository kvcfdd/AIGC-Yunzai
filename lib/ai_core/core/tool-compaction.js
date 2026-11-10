/** 上下文阈值 */
export const CONTEXT_THRESHOLD_RATIO = { normal: 0.2, master: 0.65 }

/** 保留的最近轮数 */
export const CONTEXT_KEEP_TURNS = 10

/** 达到阈值时触发压缩；同时给输出预留 max_output_tokens 的空间 */
export function contextThreshold(modelConfig, isMaster) {
  const window = Number(modelConfig?.context_window) || 0
  if (window <= 0) return 0
  const ratio = isMaster ? CONTEXT_THRESHOLD_RATIO.master : CONTEXT_THRESHOLD_RATIO.normal
  const reserve = Math.min(Math.max(0, Number(modelConfig?.max_output_tokens) || 0), Math.floor(window / 2))
  return Math.min(Math.floor(window * ratio), Math.max(1, window - reserve))
}

/** 压缩时保留的最近轮数：1/10，至少 3 轮，最多 10 轮 */
export function keepTurnCount(totalTurns) {
  const total = Math.max(0, Math.floor(Number(totalTurns) || 0))
  return Math.max(3, Math.min(CONTEXT_KEEP_TURNS, Math.ceil(total / 10)))
}

/** 当前轮工具结果压缩为 4089...2089 */
export const CURRENT_TOOL_HEAD = 4089
export const CURRENT_TOOL_TAIL = 2089

function isCjkCode(cp) {
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
}

function isEmojiCode(cp) {
  return cp === 0x200d || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f000 && cp <= 0x1faff)
}

/** 粗略 token 估算：CJK 1/字、其他 0.3/字符、emoji 2/个；宁可偏大 */
export function estimateTextTokens(text) {
  if (!text) return 0
  let cjk = 0
  let emoji = 0
  let other = 0
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    if (isCjkCode(cp)) cjk++
    else if (isEmojiCode(cp)) emoji++
    else other++
  }
  return Math.ceil(cjk + emoji * 2 + other * 0.3)
}

/** 总输入 token 估算：消息 + 额外运行时上下文与工具定义
 *  用于 provider 未返回 usage 时的兜底，以及压缩后重新估算 */
export function estimateContextTokens(messages, extraText = "") {
  let total = estimateTextTokens(extraText)
  for (const m of messages || []) {
    if (!m) continue
    total += estimateTextTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))
    total += estimateTextTokens(m.reasoning_content)
    total += estimateTextTokens(m.runtime_context)
    if (m.tool_calls) total += estimateTextTokens(JSON.stringify(m.tool_calls))
    if (m.response_items) total += estimateTextTokens(JSON.stringify(m.response_items))
    total += (m.images?.length || 0) * 765
    total += (m.audios?.length || 0) * 500
    total += (m.videos?.length || 0) * 1000
    total += (m.files?.length || 0) * 500
  }
  return Math.ceil(total)
}

/** 收集工具调用组：assistant(tool_calls) + 紧随其后的 tool 结果 */
export function collectToolGroups(messages) {
  const groups = []
  const list = messages || []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m?.role !== "assistant" || !m.tool_calls?.length) continue
    const group = [i]
    let j = i + 1
    while (j < list.length && list[j]?.role === "tool") {
      group.push(j)
      j++
    }
    groups.push(group)
    i = j - 1
  }
  return groups
}

/** 选出要摘除的工具组：前 3/4，至少摘 1 组，保留最近 1/4 */
export function selectToolGroupsForCompaction(groups, keepRatio = 0.25) {
  if (!groups?.length) return { remove: [], keep: [] }
  const ratio = Math.min(Math.max(Number(keepRatio) || 0.25, 0), 1)
  const removeCount = Math.max(1, Math.floor(groups.length * (1 - ratio)))
  return { remove: groups.slice(0, removeCount), keep: groups.slice(removeCount) }
}
