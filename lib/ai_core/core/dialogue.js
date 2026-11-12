import cfg from "../config.js"
import log from "../helpers/log.js"
import { buildUserMessageMeta, STATUS_BAR } from "../llm/message-builders.js"
import { resolveModelConfig } from "../llm/model-config.js"
import { runWithUsageContext } from "../llm/token-usage.js"
import { buildTurn } from "../perception/turn-input.js"
import { SystemPromptBuilder } from "../perception/system-prompt.js"
import { MediaResolver, mediaResolved } from "../perception/media-resolver.js"
import { createReplySender } from "../output/reply-sender.js"
import { buildTurnTrace } from "../output/turn-trace.js"
import { parseReplyParts, stripQuotePrefix } from "../output/reply-format.js"
import { MEDIA_FIELDS } from "../memory/persist.js"
import { getMaxToolRounds, runToolLoop } from "./tool-loop.js"

const mediaResolver = new MediaResolver()

/** 请求耗时超过该阈值才引用触发消息，快速回复不引用 */
const QUOTE_AFTER_MS = 10_000

/**
 * 单轮对话编排 — 请求合并/排队 → 媒体预处理 → 系统提示词 → 工具循环 → 落盘 → 输出。
 *
 * @param {object} deps
 * @param {object} deps.provider   LLM provider
 * @param {object} deps.memory     记忆层
 * @param {object} deps.tools      工具注册中心
 * @param {object} deps.skills     技能仓库
 * @param {object} deps.scheduler 请求调度器
 * @param {object} [deps.config]   配置对象
 */
export function createDialogue({ provider, memory, tools, skills, scheduler, schedule, config = cfg, logger = log, redis = globalThis.redis }) {
  const toolServices = {
    config,
    memory,
    provider,
    tools,
    schedule,
    skills,
    redis,
    logger,
    bot: globalThis.Bot,
    injectMessage: params => globalThis.Bot.aigc.injectMessage(params),
  }

  /** 逐 turn 解析媒体 —— 正式触发与排队期预转码共用; 已解析(data URI)直接复用 */
  async function resolveTurnMedia(t, signal) {
    if (!mediaResolved(t.imgRes)) t.imgRes = await mediaResolver.resolveImages(t.imgs, signal)
    if (!mediaResolved(t.vidRes)) t.vidRes = await mediaResolver.resolveVideo(t.videos, signal)
    if (!mediaResolved(t.audRes)) t.audRes = await mediaResolver.resolveAudio(t.audios, signal)
    if (!mediaResolved(t.fileRes)) t.fileRes = await mediaResolver.resolveFiles(t.files, signal)
  }

  /** 单个 turn → user 消息 */
  function toUserMessage(t) {
    return {
      role: "user",
      content: t.text,
      ...buildUserMessageMeta(t.event),
      ...(t.imgRes ? { images: t.imgRes.uris, image_paths: t.imgRes.paths } : {}),
      ...(t.vidRes ? { videos: t.vidRes.uris, video_paths: t.vidRes.paths } : {}),
      ...(t.audRes ? { audios: t.audRes.uris, audio_paths: t.audRes.paths } : {}),
      ...(t.fileRes?.files?.length ? { files: t.fileRes.files, file_paths: t.fileRes.file_paths } : {}),
    }
  }

  /** 终结本轮文本回复：输出效验 → no_reply 检查 → 落盘 → 转发本轮过程 → 发送 */
  async function finishTextReply({ result, event, sid, controller, sender, signal, isAmbient, isInjected, requestedAt }) {
    const { res, localPending } = result
    const fullPending = result.fullPending || localPending
    res.content = stripQuotePrefix(res.content)
    const text = (res.content || "").trim()

    // 已被新请求中止 → 不再落盘，不发送
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // 完整记录写入只增不减的历史表，实际上下文写入可增减的上下文表
    const persistRound = async () => {
      const saved = await memory.appendRound(sid, fullPending, { persist: !isAmbient, contextMsgs: localPending })
      if (isAmbient) return
      if (saved?.contextAppendFailed) {
        log.warn(`实际上下文追加失败，下一次请求回退到完整历史重新估算`)
        // 下一轮会从历史表重播种，旧基线不再代表实际上下文，清零以触发全量估算
        memory.setSessionTokens?.(event.self_id, event.user_id, 0)
      }
    }

    // 本轮已落盘后登记轮末压缩：不 await，回复不等待压缩，但下一轮会等待它完成
    const scheduleCompaction = () => {
      if (isAmbient || !result.deferredCompact) return
      memory.beginCompaction?.(event.self_id, event.user_id, result.deferredCompact())
    }

    // no_reply: 不发送回复，但完整落盘保留对话结构
    if (!text || /^no_reply$/i.test(text)) {
      await persistRound()
      scheduleCompaction()
      return false
    }

    // 解析 XML 标签
    const parts = parseReplyParts(text)

    // 落盘
    await persistRound()

    // 本轮已终结: 条件移除自己的请求标记，此后同用户新触发即全新请求
    scheduler.delete(event, controller)

    // 先登记压缩再发送，避免新消息在发送期间到达时读到压缩前的上下文
    scheduleCompaction()

    // 注入触发/旁听不转发过程，只发正文
    if (config.aigc?.show_thinking && !isInjected && !isAmbient) {
      const trace = buildTurnTrace(fullPending, { usage: result.usage })
      if (trace.length) await sender.sendTurnTrace(trace)
    }

    if (result.type === "final") log.warn("工具轮次超限，降级回复成功")
    const quote = !isAmbient && Date.now() - requestedAt > QUOTE_AFTER_MS
    return parts.length ? sender.sendParts(parts, quote) : false
  }

  /** 对外入口 — 为本轮所有模型调用绑定用量归属 */
  async function run(args) {
    return runWithUsageContext(args?.event, () => runTurn(args))
  }

  async function runTurn({ event, userMsg, isAmbient = false, reply }) {
    const requestedAt = Date.now()
    const turn = buildTurn(event, userMsg)
    turn.event = event
    const isInjected = !!event?._injected
    const sender = createReplySender({ event, reply, config })
    const context = new SystemPromptBuilder({ event, skills, tools, config })
    context.setKnowledgeQuery(turn.text)

    // 请求合并/排队: 用户输入之间沿用打断合并(非旁听请求把本次输入追加为独立的 user 消息)
    // 用户输入与定时注入互不打断合并 —— 按到达先后排队
    let turns = [turn]
    let carryMessages = null
    let requestCarryFullMessages = null
    let merged = false
    while (true) {
      const existing = scheduler.get(event)
      if (!existing || existing.injected === isInjected) {
        if (existing) {
          if (isAmbient) return false
          // 工具执行或上下文压缩期间的新输入不打断当前请求，追加到本轮请求
          // 落盘保持工具结果之后的真实顺序。这条消息会成为下一次请求的最新 user
          // 回复目标与环境上下文都切到它的 event，并在消息到达时实时取一次环境上下文
          if ((existing.phase === "tools" || existing.phase === "compacting") && !existing.isAmbient && existing.appendMessages) {
            // 先同步入队：工具可能在这一刻返回并 drain，异步解析完再补媒体/环境会丢消息
            const appended = toUserMessage(turn)
            existing.appendMessages.push(appended)
            existing.event = turn.event
            // 插话到达后回复目标切到插话，引用计时也从插话时刻重新开始
            existing.requestedAt = requestedAt
            existing.sender = sender
            existing.contextBuilder = context
            existing.group_id = event.isGroup ? String(event.group_id) : null
            const settle = async () => {
              try {
                await resolveTurnMedia(turn, existing.controller.signal)
              } catch (err) {
                log.debug(`工具执行/压缩中追加消息的媒体转码失败: ${err.message}`)
              }
              const resolved = toUserMessage(turn)
              for (const key of MEDIA_FIELDS) {
                if (resolved[key]?.length) appended[key] = resolved[key]
              }
              try {
                existing.pendingRuntimeContext = await context.buildRuntimeContext(isAmbient, { signal: existing.controller.signal })
              } catch (err) {
                existing.pendingRuntimeContext = null
                log.warn(`工具阶段追加消息的环境上下文获取失败: ${err.message}`)
              }
            }
            existing.appendPending = existing.appendPending ? existing.appendPending.then(settle, settle) : settle()
            log.info(`用户 ${event.user_id} 工具执行/压缩中追加一条消息`)
            return false
          }
          existing.controller.abort()
          if (existing.isAmbient) {
            log.info(`用户 ${event.user_id} 切换到at对话`)
          } else {
            // 本轮已产生的消息分为模型上下文与完整记录；中断后两者分别沿用
            let buffered = existing.localPending?.length ? [...existing.localPending] : null
            let bufferedFull = existing.fullPending?.length ? [...existing.fullPending] : buffered ? [...buffered] : null
            if (!buffered && existing.carryMessages?.length) {
              const pending = existing.pendingTurns || []
              for (const t of pending) {
                try {
                  await resolveTurnMedia(t)
                } catch (err) {
                  log.debug(`中断合并时媒体转码失败: ${err.message}`)
                }
              }
              const pendingMessages = pending.map(toUserMessage)
              buffered = [...existing.carryMessages, ...pendingMessages]
              bufferedFull = [...(existing.carryFullMessages || existing.carryMessages), ...pendingMessages]
            }
            if (buffered) {
              // 等追加消息的媒体/环境补齐，避免带着未解析的媒体进入新请求
              if (existing.appendPending) {
                try {
                  await existing.appendPending
                } catch (err) {
                  log.warn(`中断合并时追加消息处理失败: ${err.message}`)
                }
              }
              // 旧请求的轮次状态栏在新请求里已失效
              for (const m of buffered) if (m?.[STATUS_BAR]) delete m[STATUS_BAR]
              carryMessages = buffered
              requestCarryFullMessages = bufferedFull
              turns = [turn]
            } else if (existing.pendingTurns?.length) {
              turns = [...existing.pendingTurns, turn]
            }
            merged = true
          }
        }
        break
      }
      log.info(`用户 ${event.user_id} 的${isInjected ? "注入任务" : "输入"}与${existing.injected ? "注入任务" : "对话"}撞车，排队等待对方结束`)
      for (const t of turns) {
        if (!t.imgs.length && !t.videos.length && !t.audios.length && !t.files.length) continue
        try {
          await resolveTurnMedia(t)
        } catch (err) {
          log.debug(`排队期间媒体转码失败，入场后重试: ${err.message}`)
          t.imgRes = t.vidRes = t.audRes = t.fileRes = undefined
        }
      }
      await existing.done
    }

    const controller = new AbortController()
    const done = Promise.withResolvers()
    const request = {
      controller,
      isAmbient,
      injected: isInjected,
      requestedAt,
      pendingTurns: turns,
      carryMessages,
      carryFullMessages: requestCarryFullMessages,
      event,
      sender,
      contextBuilder: context,
      group_id: event.isGroup ? String(event.group_id) : null,
      done: done.promise,
      appendMessages: [],
      phase: "model",
    }
    scheduler.set(event, request)

    const sid = memory.sessionKey(event.self_id, event.user_id)
    const label = isAmbient ? "主动插话" : "对话"
    const inputCount = turns.length + (carryMessages || []).filter(m => m.role === "user").length

    try {
      log.info(`用户 ${event.user_id} ${merged ? `合并请求 (共${inputCount}条输入)` : `发起${label}`}`)

      const systemPrompt = await context.buildSystemPrompt()
      const channel = isAmbient ? "ambient" : "main"
      const selection = isAmbient ? config.aigc?.proactive_group_chat : config.aigc
      const modelConfig = resolveModelConfig(selection, config.aigc)
      let history = []
      let historySummary = ""
      if (!isAmbient) {
        // 上一轮的轮末压缩完成后才能读取上下文，避免读到压缩中间态
        await memory.awaitCompaction?.(event.self_id, event.user_id)
        const loaded = await memory.getMessages(event.self_id, event.user_id)
        history = loaded?.messages || []
        historySummary = loaded?.summary || ""
      }
      const runtimeContext = await context.buildRuntimeContext(isAmbient, { signal: controller.signal })
      // 逐 turn 解析媒体 —— 排队期已解析(data URI)的直接复用，避免重复下载/编码；
      // 被中断请求留下的占位结果([图像异常]等)需重新解析
      for (const t of turns) {
        await resolveTurnMedia(t, controller.signal)
      }

      const userMessages = turns.map(toUserMessage)
      const hasSkills = (await skills.list()).length > 0
      const maxRounds = getMaxToolRounds(config.aigc)

      const result = await runToolLoop({
        provider,
        tools,
        toolServices,
        event,
        userMessages,
        carryMessages,
        carryFullMessages: requestCarryFullMessages,
        history,
        historySummary,
        systemPrompt,
        runtimeContext,
        buildRuntimeContext: () => (request.contextBuilder || context).buildRuntimeContext(isAmbient, { signal: controller.signal }),
        maxRounds,
        channel,
        modelConfig,
        signal: controller.signal,
        hasSkills,
        contextCompaction: { isMaster: !!event.isMaster, trackSession: !isAmbient },
        runtime: request,
        onInterimText: text => request.sender.sendParts(parseReplyParts(text), false),
      })

      if (result.type === "blocked") {
        log.warn(`安全拦截  ${result.res?.finishReason}`)
        if (isAmbient || isInjected) return false
        return request.sender.send("内容被安全策略拦截", true)
      }

      if (result.type === "empty") return

      if (result.type === "failed") {
        log.error(`全部失败`)
        if (!controller.signal.aborted) controller.abort()
        if (isAmbient || isInjected) return false
        return request.sender.send("请求失败", true)
      }

      return await finishTextReply({
        result,
        event,
        sid,
        controller,
        sender: request.sender,
        signal: controller.signal,
        isAmbient,
        isInjected,
        requestedAt: request.requestedAt,
      })
    } catch (err) {
      // 本轮异常结束 → 派生任务一并中止；正常回复完成则不中止
      if (!controller.signal.aborted) controller.abort()
      if (err?.name === "AbortError") {
        log.info(`用户 ${event.user_id} 打断`)
        return false
      }
      if (err?.code === "UNSUPPORTED_MEDIA") {
        log.error(`${label}媒体能力配置错误: ${err.message}`)
        if (!isAmbient && !isInjected) await request.sender.send("当前模型不支持该媒体类型，请关闭对应的 media 开关", true)
        return
      }
      if (err?.code === "UNSUPPORTED_ADAPTER" || err?.code === "MODEL_CONFIG_NOT_FOUND" || err?.code === "MODEL_REQUIRED" || err?.code === "INVALID_INCLUDE") {
        log.error(`${label}模型配置错误: ${err.message}`)
        if (!isAmbient && !isInjected) await request.sender.send("模型配置错误，请检查 aigc.models / model_config / adapter 配置", true)
        return
      }
      log.error(`${label}异常: ${err.message}`)
      // 定时注入请求失败静默处理, 不打扰用户
      if (!isAmbient && !isInjected) await request.sender.send("我有些累了，请让我休息一会儿", true)
    } finally {
      scheduler.delete(event, controller)
      done.resolve()
    }
  }

  return {
    run,
    abort: event => scheduler.abort(event),
    abortAll: () => scheduler.abortAll(),
    scheduler,
  }
}
