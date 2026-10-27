import log from "../helpers/log.js"
import { buildAssistantMessage, stripQuotePrefix } from "../llm/message-builders.js"
import { createToolContext } from "../tools/tool-context.js"
import { normalizeToolResult } from "../tools/tool-result.js"
import { MASTER_ONLY_TOOLS } from "../tools/workspace.js"

/** 工具调用轮次上限 */
export const getMaxToolRounds = aigc => Math.min(Math.max(aigc?.max_tool_rounds ?? 5, 2), 10)

/**
 * 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则返回。
 * 采用 "API 增量请求，本地全量累积" 架构:
 *  - localPending[]  最终原子写入 SQLite 的完整对话记录
 *  - apiMessages[]   每轮实际发送给 API 的消息
 */
export async function runToolLoop({ provider, tools, toolServices, event, userMessages, history, systemPrompt, maxRounds, channel, modelConfig, signal, isAmbient = false, hasSkills = false, onInterimText }) {
  const toolDefs = tools.getDefinitions().filter(t => {
    const name = t.function?.name
    if (name === "skill" && !hasSkills) return false
    if (MASTER_ONLY_TOOLS.has(name) && !event?.isMaster) return false
    return true
  })
  const systemMsg = { role: "system", content: systemPrompt }
  const baseMessages = history.filter(m => m.role !== "system")

  // 本地全量记录 — 本轮结束时原子写入 SQLite
  const localPending = [...userMessages]

  for (let round = 0; round < maxRounds; round++) {
    // 首轮：系统提示词 + 历史 + 本轮输入；后续工具轮：完整历史 + 本轮累积
    const apiMessages = round === 0 ? [systemMsg, ...baseMessages, ...userMessages] : [systemMsg, ...baseMessages, ...localPending]

    const opts = { signal, tools: toolDefs, channel, modelConfig }

    const res = await provider.chat(apiMessages, opts)

    if (res.blocked) return { type: "blocked", res, localPending, baseMessages, systemMsg }
    if (res.failed) return { type: "failed", res, localPending, baseMessages, systemMsg }

    // 输出效验: 清除学舌的引用前缀
    if (res.content) res.content = stripQuotePrefix(res.content)

    // 服务端未给 tool_call id 时补一个，保证 assistant 与 tool 消息能对上
    if (res.tool_calls?.length) {
      for (let i = 0; i < res.tool_calls.length; i++) {
        if (!res.tool_calls[i].id) res.tool_calls[i].id = `call_${round}_${i}_${Date.now().toString(36)}`
      }
    }

    const assistantMsg = buildAssistantMessage(res)
    localPending.push(assistantMsg)

    // 工具调用
    if (res.tool_calls?.length) {
      // 中间文本同样尊重 no_reply 约定: 已读不回的内容不外发
      const interim = (res.content || "").trim()
      if (interim && !/^no_reply$/i.test(interim)) await onInterimText?.(res.content)

      const names = res.tool_calls
        .map(c => c.function?.name)
        .filter(Boolean)
        .join(",")
      log.info(`调用工具: ${names}`)

      const ctx = createToolContext({ event, signal, services: toolServices })
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

      const results = await Promise.all(
        res.tool_calls.map(async tc => {
          if (signal?.aborted) return { name: tc?.function?.name || "unknown", error: "Aborted" }
          try {
            const fnName = tc?.function?.name
            if (!fnName) return { name: "unknown", error: "tool_calls missing function.name" }
            let args = {}
            try {
              args = JSON.parse(tc?.function?.arguments || "{}")
            } catch {
              /* pass */
            }
            if (!args || typeof args !== "object") args = {}
            return await tools.execute(fnName, args, ctx)
          } catch (err) {
            return { name: tc?.function?.name || "unknown", error: err?.message || String(err) }
          }
        }),
      )

      // 工具执行结果摘要日志
      for (const r of results) {
        const ok = !("error" in r)
        const resultStr = ok ? (typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? "")) : r.error
        const preview = resultStr.length > 120 ? resultStr.slice(0, 120) + "..." : resultStr
        log.info(`工具 ${r.name}: ${ok ? "✅" : "❌"} ${preview}`)
      }

      const lastRound = round === maxRounds - 1
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const callId = res.tool_calls[i]?.id || `call_${i}`
        const callSig = res.tool_calls[i]?.signature || null
        const payload = "error" in r ? r.error : r.result
        const normalized = normalizeToolResult(payload)

        let content = normalized.content
        if (lastRound && i === results.length - 1) {
          content += `\n\n[系统提示] 你已达到最大工具调用轮次 (${maxRounds}轮)。请立即基于已获取的所有信息回复用户，不要再调用任何工具！！！如果信息不足，如实说明已掌握的情况即可。`
        }

        const toolMsg = {
          role: "tool",
          content,
          tool_call_id: callId,
          name: res.tool_calls[i]?.function?.name,
          signature: callSig,
          is_error: "error" in r,
        }
        if (normalized.images.length) toolMsg.images = normalized.images
        if (normalized.image_paths?.length) toolMsg.image_paths = normalized.image_paths
        if (normalized.videos.length) toolMsg.videos = normalized.videos
        if (normalized.video_paths?.length) toolMsg.video_paths = normalized.video_paths
        if (normalized.audios.length) toolMsg.audios = normalized.audios
        if (normalized.audio_paths?.length) toolMsg.audio_paths = normalized.audio_paths
        if (normalized.files.length) toolMsg.files = normalized.files
        if (normalized.file_paths?.length) toolMsg.file_paths = normalized.file_paths
        localPending.push(toolMsg)
      }
      continue
    }

    // 文本回复
    if (res.content) return { type: "text", res, localPending, baseMessages, systemMsg }

    log.warn(`空响应`)
    return { type: "empty", res, localPending, baseMessages, systemMsg }
  }

  // 工具轮次用尽：tool_choice="none" 强制文本回复
  const finalMessages = [systemMsg, ...baseMessages, ...localPending]
  const finalOpts = { signal, tool_choice: "none", channel, modelConfig }
  if (toolDefs.length) finalOpts.tools = toolDefs

  const finalReply = await provider.chat(finalMessages, finalOpts)
  if (finalReply.blocked) return { type: "blocked", res: finalReply, localPending, baseMessages, systemMsg }
  if (finalReply.failed) return { type: "failed", res: finalReply, localPending, baseMessages, systemMsg }
  if (finalReply.content) {
    localPending.push(buildAssistantMessage(finalReply))
    return { type: "final", res: finalReply, localPending, baseMessages, systemMsg }
  }

  return { type: "failed", finalReply, localPending, baseMessages, systemMsg }
}
