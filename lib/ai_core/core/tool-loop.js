import log from "../helpers/log.js"
import { buildAssistantMessage, stripQuotePrefix } from "../llm/message-builders.js"
import { createToolContext } from "../tools/tool-context.js"
import { normalizeToolResult } from "../tools/tool-result.js"
import { addUsage, emptyUsage } from "../llm/usage.js"

/** 思考轮次上限 */
export const getMaxToolRounds = aigc => Math.min(Math.max(aigc?.max_tool_rounds ?? 30, 2), 50)

/** 各适配器表示“输出被截断”的 finishReason */
const TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens", "model_context_window_exceeded", "incomplete", "budget_exceeded", "max_output_tokens"])
const isTruncated = res => TRUNCATED_FINISH_REASONS.has(String(res?.finishReason || "").toLowerCase())

/**
 * 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则返回。
 * 采用 "API 增量请求，本地全量累积" 架构:
 *  - localPending[]  最终原子写入 SQLite 的完整对话记录
 *  - apiMessages[]   每轮实际发送给 API 的消息
 */
export async function runToolLoop({ provider, tools, toolServices, event, userMessages, history, systemPrompt, runtimeContext, maxRounds, channel, modelConfig, signal, hasSkills = false, onInterimText, runtime }) {
  const getToolDefs = () =>
    tools.getDefinitions().filter(t => {
      if (t.function?.name === "skill" && !hasSkills) return false
      return true
    })
  const systemMsg = { role: "system", content: systemPrompt }
  const baseMessages = history.filter(m => m.role !== "system")

  // 环境信息只附加到 API 请求的最后一条 user 上，localPending 保持干净（不落库）
  const withRuntimeContext = messages => {
    if (!runtimeContext) return messages
    const out = messages.slice()
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]?.role === "user") {
        out[i] = { ...out[i], runtime_context: runtimeContext }
        break
      }
    }
    return out
  }

  // Anthropic 显式缓存断点：标记历史部分最后一条消息
  const withCacheBreak = messages => {
    if (!baseMessages.length) return messages
    const out = messages.slice()
    const index = baseMessages.length // [system, ...baseMessages, ...current]
    if (out[index]) out[index] = { ...out[index], cache_break: true }
    return out
  }

  const buildApiMessages = messages => withCacheBreak(withRuntimeContext(messages))

  // 本地全量记录 — 本轮结束时原子写入 SQLite
  const localPending = [...userMessages]
  // 本轮所有 API 调用的 token 用量合计
  const usage = emptyUsage()

  // 工具执行期间追加的用户消息：请求里排在工具结果之后，落盘时移到本轮 user 输入之后
  const appendedMessages = []
  const originalToolContent = new Map()
  const setPhase = phase => {
    if (runtime) runtime.phase = phase
  }
  const appendedText = m => {
    const notes = []
    if (m.images?.length) notes.push("[图片]")
    if (m.audios?.length) notes.push("[音频]")
    if (m.videos?.length) notes.push("[视频]")
    if (m.files?.length) notes.push("[文件]")
    return `${m.content || ""}${notes.join("")}`
  }
  const drainAppended = () => {
    const list = runtime?.appendMessages?.splice?.(0) || []
    if (!list.length) return
    if (modelConfig.adapter === "anthropic") {
      const toolMsg = [...localPending].reverse().find(m => m.role === "tool")
      if (toolMsg) {
        // Anthropic 不允许 user 插在中间：并入最后一条工具结果
        if (!originalToolContent.has(toolMsg)) originalToolContent.set(toolMsg, toolMsg.content)
        const notes = list.map(m => `[用户消息追加]${appendedText(m)}`).join("\n")
        toolMsg.content = `${toolMsg.content || ""}${toolMsg.content ? "\n" : ""}---\n${notes}`
        appendedMessages.push(...list)
        return
      }
    }
    appendedMessages.push(...list)
    localPending.push(...list)
  }
  const finish = result => {
    setPhase("model")
    // 恢复 Anthropic 工具结果原文，追加消息在落盘顺序中移到本轮 user 输入之后
    for (const [msg, content] of originalToolContent) msg.content = content
    if (appendedMessages.length) {
      const moved = new Set(appendedMessages)
      const head = localPending.slice(0, userMessages.length)
      const rest = localPending.slice(userMessages.length).filter(m => !moved.has(m))
      localPending.length = 0
      localPending.push(...head, ...appendedMessages, ...rest)
    }
    return { ...result, localPending }
  }

  for (let round = 0; round < maxRounds; round++) {
    const toolDefs = getToolDefs()
    // 首轮：系统提示词 + 历史 + 本轮输入；后续工具轮：完整历史 + 本轮累积
    const apiMessages = buildApiMessages(round === 0 ? [systemMsg, ...baseMessages, ...userMessages] : [systemMsg, ...baseMessages, ...localPending])

    const opts = { signal, tools: toolDefs, channel, modelConfig }

    setPhase("model")
    const res = await provider.chat(apiMessages, opts)
    addUsage(usage, res.usage)

    if (res.blocked) return finish({ type: "blocked", res, localPending, baseMessages, systemMsg, usage })
    if (res.failed) return finish({ type: "failed", res, localPending, baseMessages, systemMsg, usage })

    // 输出被截断时，未完成的工具调用参数不可信，不能执行
    if (isTruncated(res)) {
      if (res.tool_calls?.length) {
        log.warn(`模型输出被截断 (${res.finishReason})，已丢弃 ${res.tool_calls.length} 个未完成工具调用`)
        res.tool_calls = undefined
      }
      if (!res.content) {
        log.warn(`模型输出被截断 (${res.finishReason}) 且无文本内容`)
        return finish({ type: "failed", res, localPending, baseMessages, systemMsg, usage })
      }
    }

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
      setPhase("tools")
      // 中间文本同样尊重 no_reply 约定: 已读不回的内容不外发
      const interim = (res.content || "").trim()
      if (interim && !/^no_reply$/i.test(interim)) await onInterimText?.(res.content)

      const names = res.tool_calls
        .map(c => c.function?.name)
        .filter(Boolean)
        .join(",")
      log.info(`调用工具: ${names}`)

      const ctx = createToolContext({ event, signal, services: toolServices, turnMessages: localPending })
      if (signal?.aborted) {
        setPhase("model")
        throw new DOMException("Aborted", "AbortError")
      }

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

      // 工具执行期间被打断 → 丢弃本批结果，直接结束本轮
      if (signal?.aborted) {
        setPhase("model")
        throw new DOMException("Aborted", "AbortError")
      }

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

      // 工具执行期间追加的用户消息：排在本次工具结果之后
      drainAppended()
      setPhase("model")
      continue
    }

    // 文本回复
    if (res.content) return finish({ type: "text", res, localPending, baseMessages, systemMsg, usage })

    log.warn(`空响应`)
    return finish({ type: "empty", res, localPending, baseMessages, systemMsg, usage })
  }

  // 工具轮次用尽：tool_choice="none" 强制文本回复
  const finalMessages = buildApiMessages([systemMsg, ...baseMessages, ...localPending])
  const finalToolDefs = getToolDefs()
  const finalOpts = { signal, tool_choice: "none", channel, modelConfig }
  if (finalToolDefs.length) finalOpts.tools = finalToolDefs

  const finalReply = await provider.chat(finalMessages, finalOpts)
  addUsage(usage, finalReply.usage)
  if (finalReply.blocked) return finish({ type: "blocked", res: finalReply, localPending, baseMessages, systemMsg, usage })
  if (finalReply.failed) return finish({ type: "failed", res: finalReply, localPending, baseMessages, systemMsg, usage })
  if (isTruncated(finalReply) && !finalReply.content) {
    log.warn(`强制回复被截断 (${finalReply.finishReason}) 且无文本内容`)
    return finish({ type: "failed", finalReply, localPending, baseMessages, systemMsg, usage })
  }
  if (finalReply.content) {
    localPending.push(buildAssistantMessage(finalReply))
    return finish({ type: "final", res: finalReply, localPending, baseMessages, systemMsg, usage })
  }

  return finish({ type: "failed", finalReply, localPending, baseMessages, systemMsg, usage })
}
