import tools from "./registry.js"
import conversation from "../conversation.js"
import log from "../helpers/log.js"
import { formatMsgTime } from "../helpers/time.js"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_TEXT = 500 // 用户/助手单条上限
const MAX_TOOL_TEXT = 200 // 工具结果单条上限
const MAX_TOTAL = 8000 // 总输出上限
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/

const today = () => formatMsgTime(Date.now()).slice(0, 10)

/** YYYY-MM-DD → 当日 00:00:00.000 时间戳 */
function dayStart(s) {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** YYYY-MM-DD → 当日 23:59:59.999 时间戳（d+1 自动进位月/年） */
function dayEnd(s) {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d + 1).getTime() - 1
}

/** 单行裁剪 */
function clip(text, max) {
  if (typeof text !== "string") return ""
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 单条消息 → 展示行，无内容返回空串 */
function messageLine(m, ts) {
  if (m.role === "user") {
    const t = clip(m.content, MAX_TEXT)
    return t ? `${ts} 用户: ${t}` : ""
  }
  if (m.role === "assistant") {
    const t = clip(m.content, MAX_TEXT)
    if (t) return `${ts} 我: ${t}`
    const names = (m.tool_calls || []).map(tc => tc.function?.name).filter(Boolean)
    return names.length ? `${ts} 我: [调用工具: ${names.join(", ")}]` : ""
  }
  if (m.role === "tool") {
    const t = clip(m.content, MAX_TOOL_TEXT)
    return t ? `${ts} 工具(${m.name || "unknown"}): ${t}` : ""
  }
  return ""
}

/** 未命中时告诉模型「实际存在什么」，让下一次调用有的放矢 */
async function noHitReport(selfId, userId, opts, start, end, keyword) {
  const span = await conversation.historySpan(selfId, userId)
  if (!span) return `用户 ${userId} 没有任何对话记录。`

  const spanText = `该用户共有 ${span.turns} 轮对话，时间跨度 ${formatMsgTime(span.first).slice(0, 10)} ~ ${formatMsgTime(span.last).slice(0, 10)}。`
  const range = start || end ? `${start || "最早"} ~ ${end || "最新"}` : null

  // 范围内有记录，只是关键词没命中
  if (keyword) {
    const inRange = await conversation.countHistory(selfId, userId, { startMs: opts.startMs, endMs: opts.endMs })
    if (inRange > 0) {
      return range ? `在 ${range} 内找到 ${inRange} 轮对话，但没有包含"${keyword}"的记录。可尝试更换关键词或放宽时间范围。` : `共找到 ${inRange} 轮对话，但没有包含"${keyword}"的记录。可尝试更换关键词。`
    }
  }

  return range ? `在 ${range} 内没有找到对话记录。${spanText}` : `${spanText}没有匹配的记录。`
}

tools.register({
  name: "chat_history",
  description: `检索与当前用户的过往对话记录。历史跨天长期保留，而上下文里只自动携带最近若干轮，
更早的内容需要本工具才能看到。

用途: 回忆更早聊过的事，例如"上次说的那个网站""前几天推荐的那家店"。
上下文里已经有的近期对话无需调用本工具。

参数:
- keyword: 关键词，对用户发言与你的回复作文本子串匹配，省略则不按关键词过滤。
  空格分隔的多个词之间是"且"关系，须同时出现才算命中(最多 5 个)，可用来缩小范围。
- start_date / end_date: 时间范围，格式 YYYY-MM-DD，闭区间，可只给一端。
  当前时间见系统提示词，据此换算"昨天""上周"这类说法。
- limit: 最多返回轮数，默认 20，上限 50。命中过多时返回最新的若干轮。

说明:
- 只能检索当前对话用户自己的记录，无法查询其他人的历史。
- 按轮返回: 命中一轮即返回该轮完整对话(含你调用工具的一行摘要)，工具调用的详细结果不完整返回。
- 历史里的图片/视频/文件只有文字标记，且缓存文件可能已被清理任务删除(标记为"已过期")。
- 本工具只读，不会修改或删除任何记录。
- 水群(主动插话)的对话不落盘，检索不到属于正常。
- 没有命中时，结果会说明该用户实际的记录时间跨度，据此调整范围或关键词后重试。`,

  parameters: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "关键词，子串匹配用户发言与你回复的正文；空格分隔多个词时须同时命中，省略则不按关键词过滤" },
      start_date: { type: "string", description: "起始日期 YYYY-MM-DD（含当日），省略则不限制起点" },
      end_date: { type: "string", description: "结束日期 YYYY-MM-DD（含当日），省略则不限制终点" },
      limit: { type: "number", description: "最多返回轮数，默认 20，上限 50" },
    },
    required: [],
  },

  execute: async (args, ctx) => {
    const e = ctx?.event
    const selfId = e?.self_id
    const userId = ctx?.user_id ?? e?.user_id
    if (!selfId || !userId) return "检索失败: 无法确定当前会话身份"

    let start = args?.start_date ? String(args.start_date).trim() : ""
    let end = args?.end_date ? String(args.end_date).trim() : ""
    for (const [label, v] of [
      ["start_date", start],
      ["end_date", end],
    ]) {
      if (v && !RE_DATE.test(v)) return `${label} 格式不对: ${v}。请用 YYYY-MM-DD 格式（如 ${today()}），今天的日期见系统提示词中的当前时间。`
    }

    // 先交换日期再换算 —— YYYY-MM-DD 的字典序即时间序。
    // 若交换换算后的时间戳，起点会变成 end 当日 23:59:59.999、终点变成 start 当日
    // 00:00:00.000，两端各自只剩端点那一瞬: 模型把范围给反了就几乎必然查空，
    // 却会被告知「在该范围内没有记录」—— 记录其实在
    if (start && end && start > end) [start, end] = [end, start]
    const startMs = start ? dayStart(start) : null
    const endMs = end ? dayEnd(end) : null

    const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : ""
    // 只认数字: Number(null) 与 Number("") 都是 0，会被下面的下界夹成 1，
    // 于是「省略 limit」反而只返回 1 轮
    const rawLimit = args?.limit == null || args.limit === "" ? NaN : Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT
    const opts = { startMs, endMs, keyword: keyword || null }

    log.info(`chat_history 检索 用户${userId}${keyword ? ` 关键词「${keyword}」` : ""}${start || end ? ` 范围 ${start || "最早"}~${end || "最新"}` : ""}`)

    const entries = await conversation.searchHistory(selfId, userId, { ...opts, limit })
    if (!entries.length) return noHitReport(selfId, userId, opts, start, end, keyword)

    const matched = await conversation.countHistory(selfId, userId, opts)

    // 先按轮分组 —— entries 由 queryTurns 按 (轮次, id) 升序返回
    const groups = []
    for (const { turn, created_at, msg } of entries) {
      const line = messageLine(msg, `[${formatMsgTime(created_at)}]`)
      if (!line) continue
      const last = groups[groups.length - 1]
      if (last?.turn === turn) last.lines.push(line)
      else groups.push({ turn, lines: [line] })
    }

    // 从最新一轮往前装填，超预算时丢弃最旧的轮次。
    // 正序 break 会反过来留下最旧的若干轮 —— 与工具自述的「命中过多时返回最新的
    // 若干轮」正好相反，而默认 limit 下这是常见情形，不是边角
    const kept = []
    let used = 0
    let overflow = false
    for (let i = groups.length - 1; i >= 0; i--) {
      const body = groups[i].lines.reduce((n, l) => n + l.length + 1, 0)
      const sep = kept.length ? 1 : 0
      // 至少保留最新一轮: 返回空块比返回略超预算的一轮更无用
      if (kept.length && used + sep + body > MAX_TOTAL) {
        overflow = true
        break
      }
      used += sep + body
      kept.unshift(groups[i])
    }
    const lines = kept.flatMap((g, i) => (i ? ["", ...g.lines] : g.lines))

    const notes = []
    if (matched > limit) notes.push(`[命中 ${matched} 轮，仅返回最新 ${limit} 轮；可缩小时间范围继续检索]`)
    if (overflow) notes.push("[已达输出上限，请缩小时间范围或使用关键词]")

    const attrs = [`user="${userId}"`]
    if (start || end) attrs.push(`range="${start || "最早"} ~ ${end || "最新"}"`)
    if (keyword) attrs.push(`keyword="${keyword.replace(/"/g, "'")}"`)
    // 统计实际渲染出的轮次 —— 用 entries 会把被 MAX_TOTAL 截掉的部分也算进去，
    // 于是 rounds= 与「已达输出上限」的提示自相矛盾
    attrs.push(`rounds="${kept.length}"`)

    return [`<conversation_history ${attrs.join(" ")}>`, ...lines, ...(notes.length ? ["", ...notes] : []), "</conversation_history>"].join("\n")
  },
})
