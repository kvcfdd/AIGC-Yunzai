import { truncateToolContent } from "../memory/persist.js"

export const COMPACT_KEEP_RATIO = 0.25
export const COMPACT_MIN_TOOLS = 8

/** 主对话三层阈值：无媒体软阈值 / 有媒体软阈值 / 本轮硬阈值 */
export const NORMAL_CONTEXT_LAYERS = { soft: 0.1, softMedia: 0.12, hard: 0.16 }
export const MASTER_CONTEXT_LAYERS = { soft: 0.33, softMedia: 0.385, hard: 0.8 }

/** 主对话软阈值：本轮结束时达到则下轮请求裁剪历史 */
export function contextSoftThreshold(modelConfig, isMaster, hasMedia = false) {
  const window = Number(modelConfig?.context_window) || 0
  if (window <= 0) return 0
  const layers = isMaster ? MASTER_CONTEXT_LAYERS : NORMAL_CONTEXT_LAYERS
  return Math.floor(window * (hasMedia ? layers.softMedia : layers.soft))
}

/** 主对话硬阈值：本轮仍在进行时达到则压缩本轮内容 */
export function contextCompactionThreshold(modelConfig, isMaster) {
  const window = Number(modelConfig?.context_window) || 0
  if (window <= 0) return 0
  const layers = isMaster ? MASTER_CONTEXT_LAYERS : NORMAL_CONTEXT_LAYERS
  return Math.floor(window * layers.hard)
}

/** 软阈值裁剪时保留触发阈值的 15%，且至少保留 3 轮 */
export const CONTEXT_HISTORY_KEEP_RATIO = 0.15
export const CONTEXT_KEEP_MIN_ROUNDS = 3

/** 软阈值触发后保留的历史 token 预算 */
export function historyKeepBudget(softThreshold) {
  const threshold = Math.floor(Number(softThreshold) || 0)
  return threshold > 0 ? Math.floor(threshold * CONTEXT_HISTORY_KEEP_RATIO) : 0
}

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

/** 仅上下文 token 估算：消息 + 额外运行时上下文，不含 system prompt 与工具定义 */
export function estimateContextTokens(messages, extraText = "") {
  let total = estimateTextTokens(extraText)
  for (const m of messages || []) {
    if (!m || m.role === "system") continue
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
export function selectToolGroupsForCompaction(groups, keepRatio = COMPACT_KEEP_RATIO) {
  if (!groups?.length) return { remove: [], keep: [] }
  const ratio = Math.min(Math.max(Number(keepRatio) || COMPACT_KEEP_RATIO, 0), 1)
  const removeCount = Math.max(1, Math.floor(groups.length * (1 - ratio)))
  return { remove: groups.slice(0, removeCount), keep: groups.slice(removeCount) }
}

/** 压缩当前轮的工具历史：较早的工具结果按头 4089 + ... + 尾 1024 截断，
 *  保留最近 keepRatio 的工具结果原文。只改 content，不动 tool_call_id/媒体，
 *  因此不会破坏 assistant tool_calls 与 tool 结果的配对。
 *  @returns 实际截断的条数 */
export function compactToolHistory(messages, { keepRatio = COMPACT_KEEP_RATIO, minTools = COMPACT_MIN_TOOLS, minKeep = 2 } = {}) {
  const tools = (messages || []).filter(m => m?.role === "tool" && typeof m.content === "string")
  if (tools.length < minTools) return 0

  const ratio = Math.min(Math.max(Number(keepRatio) || COMPACT_KEEP_RATIO, 0), 1)
  const keep = Math.max(Math.max(1, Number(minKeep) || 2), Math.ceil(tools.length * ratio))
  let changed = 0

  for (const m of tools.slice(0, tools.length - keep)) {
    const next = truncateToolContent(m.content)
    if (next !== m.content) {
      m.content = next
      changed++
    }
  }
  return changed
}
