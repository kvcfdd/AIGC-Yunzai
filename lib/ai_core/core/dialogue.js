import cfg from "../config.js"
import log from "../helpers/log.js"
import { buildUserMessageMeta } from "../llm/message-builders.js"
import { resolveModelConfig } from "../llm/model-config.js"
import { buildTurn } from "../perception/turn-input.js"
import { SystemPromptBuilder } from "../perception/system-prompt.js"
import { MediaResolver, mediaResolved } from "../perception/media-resolver.js"
import { createReplySender } from "../output/reply-sender.js"
import { buildTurnTrace } from "../output/turn-trace.js"
import { parseReplyParts, stripQuotePrefix } from "../output/reply-format.js"
import { getMaxToolRounds, runToolLoop } from "./tool-loop.js"

const mediaResolver = new MediaResolver()

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

  /** 终结本轮文本回复：输出效验 → no_reply 检查 → 落盘 → 转发本轮过程 → 发送 */
  async function finishTextReply({ result, event, sid, controller, sender, signal, isAmbient, isInjected }) {
    const { res, localPending } = result
    res.content = stripQuotePrefix(res.content)
    const text = (res.content || "").trim()

    // 已被新请求中止 → 不再落盘，不发送
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // no_reply: 不发送回复，但完整落盘保留对话结构
    if (!text || /^no_reply$/i.test(text)) {
      await memory.appendRound(sid, localPending, { persist: !isAmbient })
      return false
    }

    // 解析 XML 标签
    const parts = parseReplyParts(text)

    // 落盘
    await memory.appendRound(sid, localPending, { persist: !isAmbient })

    // 本轮已终结: 条件移除自己的请求标记，此后同用户新触发即全新请求
    scheduler.delete(event, controller)

    // 落盘前已被新请求中止 → 不再发送本次回复
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // 定时任务触发不转发过程，只发正文
    if (config.aigc?.show_thinking && !isInjected) {
      const trace = buildTurnTrace(localPending)
      if (trace.length) await sender.sendTurnTrace(trace)
    }

    if (result.type === "final") log.warn("工具轮次超限，降级回复成功")
    return parts.length ? sender.sendParts(parts, !isAmbient) : false
  }

  async function run({ event, userMsg, isAmbient = false, reply }) {
    const turn = buildTurn(event, userMsg)
    const isInjected = !!event?._injected
    const sender = createReplySender({ event, reply, config })
    const context = new SystemPromptBuilder({ event, skills, tools, config })

    // 请求合并/排队: 用户输入之间沿用打断合并(非水群请求把本次输入追加为独立的 user 消息)
    // 用户输入与定时注入互不打断合并 —— 按到达先后排队
    let turns = [turn]
    let merged = false
    while (true) {
      const existing = scheduler.get(event)
      if (!existing || existing.injected === isInjected) {
        if (existing) {
          existing.controller.abort()
          if (existing.isAmbient) {
            log.info(`用户 ${event.user_id} 切换到at对话`)
          } else if (existing.pendingTurns?.length) {
            turns = [...existing.pendingTurns, turn]
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
    scheduler.set(event, { controller, isAmbient, injected: isInjected, pendingTurns: turns, group_id: event.isGroup ? String(event.group_id) : null, done: done.promise })

    const sid = memory.sessionKey(event.self_id, event.user_id)
    const label = isAmbient ? "主动插话" : "对话"

    try {
      log.info(`用户 ${event.user_id} ${merged ? `合并请求 (共${turns.length}条输入)` : `发起${label}`}`)

      const systemPrompt = await context.buildSystemPrompt(isAmbient)
      const history = isAmbient ? [] : await memory.getMessages(event.self_id, event.user_id)
      const runtimeContext = await context.buildRuntimeContext(isAmbient)
      // 逐 turn 解析媒体 —— 排队期已解析(data URI)的直接复用，避免重复下载/编码；
      // 被中断请求留下的占位结果([图像异常]等)需重新解析
      for (const t of turns) {
        await resolveTurnMedia(t, controller.signal)
      }

      const userMessages = turns.map(t => ({
        role: "user",
        content: t.text,
        ...buildUserMessageMeta(event),
        ...(t.imgRes ? { images: t.imgRes.uris, image_paths: t.imgRes.paths } : {}),
        ...(t.vidRes ? { videos: t.vidRes.uris, video_paths: t.vidRes.paths } : {}),
        ...(t.audRes ? { audios: t.audRes.uris, audio_paths: t.audRes.paths } : {}),
        ...(t.fileRes?.files?.length ? { files: t.fileRes.files, file_paths: t.fileRes.file_paths } : {}),
      }))

      const hasSkills = !isAmbient && (await skills.list()).some(s => !s.masterOnly || event.isMaster)
      const maxRounds = getMaxToolRounds(config.aigc)
      const channel = isAmbient ? "ambient" : "main"
      const selection = isAmbient ? config.aigc?.proactive_group_chat : config.aigc
      const modelConfig = resolveModelConfig(selection, config.aigc)

      const result = await runToolLoop({
        provider,
        tools,
        toolServices,
        event,
        userMessages,
        history,
        systemPrompt,
        runtimeContext,
        maxRounds,
        channel,
        modelConfig,
        signal: controller.signal,
        hasSkills,
        onInterimText: text => sender.send(text, false),
      })

      if (result.type === "blocked") {
        log.warn(`安全拦截  ${result.res?.finishReason}`)
        if (isAmbient || isInjected) return false
        return sender.send("内容被安全策略拦截", true)
      }

      if (result.type === "empty") return

      if (result.type === "failed") {
        log.error(`全部失败`)
        if (isAmbient || isInjected) return false
        return sender.send("请求失败", true)
      }

      return await finishTextReply({
        result,
        event,
        sid,
        controller,
        sender,
        signal: controller.signal,
        isAmbient,
        isInjected,
      })
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`用户 ${event.user_id} 打断`)
        return false
      }
      if (err?.code === "UNSUPPORTED_API" || err?.code === "MODEL_CONFIG_NOT_FOUND") {
        log.error(`${label}模型配置错误: ${err.message}`)
        if (!isAmbient && !isInjected) await sender.send("模型配置错误，请检查 aigc.models / model_config / api 配置", true)
        return
      }
      log.error(`${label}异常: ${err.message}`)
      // 定时注入请求失败静默处理, 不打扰用户
      if (!isAmbient && !isInjected) await sender.send("我有些累了，请让我休息一会儿", true)
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
