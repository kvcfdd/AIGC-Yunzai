import cfg from "../../config/config.js"
import common from "../../common/common.js"
import log from "../helpers/log.js"
import conversation, { dateStr } from "../conversation.js"
import toolRegistry from "../tools/registry.js"
import provider from "../provider.js"
import voice from "../voice/index.js"
import { parseTaggedReply, buildAssistantMsg, userMsgMeta, extractMsgText } from "../helpers/message.js"
import { faceId } from "../helpers/face.js"
import { classifyFileExt } from "../provider/media.js"
import { pluginSkills } from "../skills/index.js"
import { systemMethods } from "./system.js"

const con = () => conversation
const tools = () => toolRegistry
const getMaxToolRounds = () => Math.min(Math.max(cfg.aigc?.max_tool_rounds ?? 5, 2), 10)

// 请求合并: self_id:user_id → { controller, pendingTurns, isAmbient, group_id }
// 同一用户触发新对话时，取消上一轮未完成的请求，把本次输入追加为独立 user 消息重发
// pendingTurns 元素 { text, imgs, videos, audios, files, imgRes, vidRes, audRes, fileRes }
export const activeRequests = new Map()

/** activeRequests 的 key — 同时验证 bot(self_id) 与用户 */
export const reqKey = e => `${e.self_id}:${e.user_id}`

/** 媒体解析结果是否可直接复用: 全部项编码成功(data URI)，无异常占位符。
 *  打断合并复用 turn 时，被中断请求可能留下占位结果，需重新解析 */
const mediaResolved = res => !!res && (res.uris || res.files)?.every?.(u => u.startsWith("data:"))
/** 对话引擎 — 输出处理、系统提示词、工具调用循环、落盘。
 *  插件子类(plugins/system/aigc.js)负责规则门控与命令入口 */
export class AigcChatCore extends plugin {
  /** 输出效验 */
  _stripQuotePrefix(text) {
    if (typeof text !== "string" || !text) return text
    return text.replace(/^\[引用[^\]]*\]\s*/, "").trim()
  }

  /** LLM 回复 → QQ 消息段: @name/@QQ 转为 at，[表情名] 转为表情 */
  _processContent(text) {
    if (typeof text !== "string" || !text) return text

    const parts = []
    let last = 0
    // @mention: 前面有无空格均可，后面必须空格或结尾；face: [中文/A-Z]
    const re = /(\s?)@([\p{Script=Han}\w]+)(?=\s|$)|\[([\p{Script=Han}\w]+)\]/gu
    let m
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ type: "text", data: { text: text.slice(last, m.index) } })
      if (m[2]) {
        if (m[1]) parts.push({ type: "text", data: { text: m[1] } })
        const target = m[2]
        if (/^\d+$/.test(target)) {
          parts.push(segment.at(target))
        } else {
          let qq = null
          try {
            if (this.e?.isGroup) {
              const ml = Bot.gml?.get(this.e.group_id)
              if (ml)
                for (const [id, info] of ml) {
                  if (info.card === target || info.nickname === target) {
                    qq = id
                    break
                  }
                }
            }
          } catch {}
          qq ? parts.push(segment.at(qq)) : parts.push({ type: "text", data: { text: m[0] } })
        }
      } else if (m[3]) {
        const id = faceId(m[3])
        parts.push(id >= 0 ? { type: "face", id } : { type: "text", data: { text: m[0] } })
      }
      last = m.index + m[0].length
    }
    if (!parts.length) return text
    if (last < text.length) parts.push({ type: "text", data: { text: text.slice(last) } })
    return parts
  }

  /** 发送纯文本回复 */
  async _sendReply(text, quote = true) {
    return this.reply(text, quote)
  }

  /** 处理带标签的回复：<reply> 发文本，<voice> 转语音，支持混排多条 */
  async _sendTaggedReply(parts, quote = true) {
    let quoted = false
    for (let i = 0; i < parts.length; i++) {
      const { type, text } = parts[i]
      if (!text) continue
      if (type === "voice") {
        try {
          const vcfg = cfg.aigc?.voice || {}
          if (vcfg.api_key && vcfg.voice_id) {
            const audioUrl = await voice.tts(text)
            await this.e.reply(segment.record(audioUrl))
          } else {
            const shouldQuote = !quoted && quote
            await this.reply(text, shouldQuote)
            quoted = true
          }
        } catch (err) {
          log.error(`语音转换失败，降级为文本: ${err.message}`)
          const shouldQuote = !quoted && quote
          await this.reply(text, shouldQuote)
          quoted = true
        }
      } else {
        const shouldQuote = !quoted && quote
        await this.reply(text, shouldQuote)
        quoted = true
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, Math.random() * 1000 + 1000))
    }
  }

  reply(msg = "", quote = false, data = {}) {
    if (this.e && !this.e.isGroup) quote = false
    return super.reply(this._processContent(msg), quote, data)
  }

  /** 从原始消息段重建完整文本 — 与群聊历史共用同一提取逻辑。
   *  文本仅占位不带 url；群聊历史保持带 url */
  _getUserMsg() {
    const text = extractMsgText(this.e, qq => this._resolveAtName(qq), { withUrl: false })
    return text || this.e.msg?.trim() || ""
  }

  /** 对话主流程: 请求合并 → 媒体预处理 → 系统提示词 → 回复循环 */
  async _runDialogue(userMsg, isAmbient) {
    // 单条输入 = 一个 turn：文本 + 该消息自带的媒体
    const turn = { text: userMsg, imgs: [], videos: [], audios: [], files: [] }
    if (Array.isArray(this.e.message)) {
      for (const seg of this.e.message) {
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
    }

    // 请求合并：上一轮未完成时取消旧请求；非水群请求把本次输入追加为独立的 user 消息
    let turns = [turn]
    const existing = activeRequests.get(reqKey(this.e))
    if (existing) {
      existing.controller.abort()
      if (existing.isAmbient) {
        log.info(`用户 ${this.e.user_id} 切换到at对话`)
      } else if (existing.pendingTurns?.length) {
        turns = [...existing.pendingTurns, turn]
      }
    }
    const controller = new AbortController()
    activeRequests.set(reqKey(this.e), { controller, isAmbient, pendingTurns: turns, group_id: this.e.isGroup ? String(this.e.group_id) : null })

    const key = con().sessionKey(this.e.self_id, this.e.user_id)
    // 主动插话不落盘，不计入当日活跃用户
    if (!isAmbient) await con().addActiveUser(dateStr(), this.e.self_id, this.e.user_id)

    const label = isAmbient ? "主动插话" : "对话"
    log.info(`用户 ${this.e.user_id} 发起${label}`)

    // 分流模型，影响模型族条件行为
    const mainModel = cfg.aigc?.gemini?.model || ""
    const effectiveModel = isAmbient ? cfg.aigc?.ambient?.model || "gemini-3-flash-preview" : mainModel

    try {
      const systemPrompt = await this._buildSystem(
        turns.map(t => t.text),
        effectiveModel,
        isAmbient,
      )
      // 逐 turn 解析媒体 —— 各 user 消息独立携带各自输入时的媒体。
      // 打断合并复用的 turn 若已完整解析(data URI)则直接复用，避免重复下载/编码；
      // 被中断请求留下的占位结果([图像异常]等)需重新解析
      const removeAudio = /^gemma/i.test(effectiveModel)
      if (removeAudio && turns.some(t => t.audios.length)) log.debug(`模型 ${effectiveModel} 不支持音频输入，已忽略语音`)
      for (const t of turns) {
        if (!mediaResolved(t.imgRes)) t.imgRes = await provider.resolveImages(t.imgs, controller.signal)
        if (!mediaResolved(t.vidRes) || t.vidRes.rmAudio !== !!removeAudio) {
          t.vidRes = await provider.resolveVideo(t.videos, removeAudio, controller.signal)
          if (t.vidRes) t.vidRes.rmAudio = !!removeAudio
        }
        t.audRes = removeAudio ? null : mediaResolved(t.audRes) ? t.audRes : await provider.resolveAudio(t.audios, controller.signal)
        if (!mediaResolved(t.fileRes)) t.fileRes = await provider.resolveFiles(t.files, controller.signal)
      }
      await this._replyLoop(key, turns, systemPrompt, controller.signal, isAmbient)
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`用户 ${this.e.user_id} 打断`)
        return false
      }
      log.error(`${label}异常: ${err.message}`)
      if (!isAmbient) await this.reply("我有些累了，请让我休息一会儿", true)
    } finally {
      if (activeRequests.get(reqKey(this.e))?.controller === controller) {
        activeRequests.delete(reqKey(this.e))
      }
    }
  }

  /** 清理临时标记/媒体编码后原子落盘本轮对话，并更新交互 ID
   *  isAmbient 为 true 时直接不落盘 */
  async _persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient = false) {
    if (isAmbient) return
    for (const m of localPending) {
      delete m._sent
      this._applyMediaPathMarkers(m)
      delete m.images
      delete m.image_paths
      delete m.videos
      delete m.video_paths
      delete m.audios
      delete m.audio_paths
      delete m.files
      delete m.file_paths
    }
    await con().appendMessages(sessionKey, localPending)
    if (stateful && prevIactId) await con().setInteractionId(this.e.self_id, this.e.user_id, prevIactId)
  }

  /** 落盘前把媒体编码替换为 [xx](本地路径) 引用：
   *  用户消息按占位符顺序逐个替换，无路径的标为已过期；工具消息在文本后追加路径标记 */
  _applyMediaPathMarkers(m) {
    // 占位符可能带原始 URL（extractMsgText 提取为 [xx](url)），替换时一并吞掉避免双重标记；
    // 文件类占位符带文件名（[文件: name]），替换后保留文件名
    const kinds = [
      { list: m.images, paths: m.image_paths, label: "图片", re: /\[图片(?::\s*([^)\]\n]*))?\](?:\([^)\n]*\))?/g, hasName: true },
      { list: m.videos, paths: m.video_paths, label: "视频", re: /\[视频(?::\s*([^)\]\n]*))?\](?:\([^)\n]*\))?/g, hasName: true },
      { list: m.audios, paths: m.audio_paths, label: "语音", re: /\[语音(?::\s*([^)\]\n]*))?\](?:\([^)\n]*\))?/g, hasName: true },
      { list: m.files, paths: m.file_paths, label: "文件", re: /\[文件(?::\s*([^)\]\n]*))?\](?:\([^)\n]*\))?/g, hasName: true },
    ]
    for (const { list, paths, label, re, hasName } of kinds) {
      if (!list?.length) continue
      const filePaths = (paths || []).filter(Boolean)
      let content = m.content || ""
      if (m.role === "user") {
        // 用户消息的占位符与媒体数组同序，逐个替换；无路径的标为已过期
        let idx = 0
        content = content.replace(re, (...args) => {
          const p = (paths || [])[idx++]
          const name = hasName ? args[1] : null
          if (!p) return name ? `[${label}: ${name} 已过期]` : `[${label}已过期]`
          return name ? `[${label}: ${name}](${p})` : `[${label}](${p})`
        })
        // 占位符少于媒体数，剩余路径追加到文本末尾
        const extra = (paths || []).slice(idx).filter(Boolean)
        if (extra.length) content += "\n" + extra.map(p => `[${label}](${p})`).join("\n")
      } else if (filePaths.length) {
        const markers = filePaths.map(p => `[${label}](${p})`).join("\n")
        content = content ? `${content}\n${markers}` : markers
      }
      m.content = content || null
    }
  }

  /** 终结本轮文本回复：输出效验 → no_reply 检查 → 落盘 → 清理请求标记 → 发送。
   *  no_reply 时完整落盘并返回 false。
   *  @param {string} [warnMsg] 非空时在发送前记录一条降级日志 */
  async _finishTextReply(res, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote, warnMsg) {
    // 输出效验: 清除学舌的引用前缀, 再落盘与发送
    res.content = this._stripQuotePrefix(res.content)
    const text = (res.content || "").trim()

    // 已被新请求中止 → 不再落盘，不发送
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // no_reply: 不发送回复，但完整落盘保留对话结构
    if (!text || /^no_reply$/i.test(text)) {
      await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)
      return false
    }

    // 解析 XML 标签
    const taggedParts = parseTaggedReply(text)

    // 落盘
    await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)

    // 本轮已终结: 条件移除自己的请求标记,此后同用户新触发即全新请求
    if (activeRequests.get(reqKey(this.e))?.controller?.signal === signal) {
      activeRequests.delete(reqKey(this.e))
    }

    // 落盘前已被新请求中止 → 不再发送本次回复
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    if (res.reasoning_content && cfg.aigc?.show_thinking) {
      const thinkingMsg = await common.makeForwardMsg(this.e, [{ type: "text", data: { text: res.reasoning_content } }])
      await this.reply(thinkingMsg)
    }

    if (warnMsg) log.warn(warnMsg)
    return taggedParts.length ? this._sendTaggedReply(taggedParts, replyQuote) : this._sendReply(res.content, replyQuote)
  }

  /** 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则发送并退出。
   *  采用 "API 增量请求，本地全量累积" 架构：
   *  - localPending[]  最终原子写入 LevelDB 的完整对话记录
   *  - apiMessages[]   每轮实际发送给 API 的消息
   *  有状态模式：通过 previous_interaction_id 让服务端管理上下文。
   *  主动插话：固定无状态 + ambient.model 分流，可用工具/记忆/上下文，但整轮不落盘。 */
  async _replyLoop(sessionKey, userTurns, systemPrompt, signal, isAmbient = false) {
    // userTurns: 本轮要落盘/发送的 user 消息数组，按输入顺序；打断合并的多条输入各自独立成一条
    const stateful = isAmbient ? false : (cfg.aigc?.gemini?.stateful ?? true)
    const ambientModel = isAmbient ? cfg.aigc?.ambient?.model || "gemini-3-flash-preview" : undefined
    // 注入轮次禁用 agent 工具，防止任务失败注入后递归派单死循环；
    // 无可用技能时不暴露 skill 工具
    const hasSkills = !isAmbient && (await pluginSkills.list()).length > 0
    const toolDefs = tools()
      .getDefinitions()
      .filter(t => {
        const name = t.function?.name
        if (this.e._injected && name === "agent") return false
        if (name === "skill" && !hasSkills) return false
        return true
      })
    const replyQuote = !isAmbient // 插话不引用，at 对话引用
    const rawHistory = isAmbient ? [] : await con().getMessages(this.e.self_id, this.e.user_id)
    const baseMessages = rawHistory.filter(m => m.role !== "system")
    const systemMsg = { role: "system", content: systemPrompt }

    // 本地全量记录 — 本方法结束时原子写入 LevelDB
    const localPending = []

    // 用户消息始终排在本地记录首位；打断合并的多条输入各自独立成一条 user 消息，
    // 各自携带媒体；*_paths 为缓存文件路径，落盘时转为 [xx](路径) 标记
    const userMsgs = userTurns.map(t => ({
      role: "user",
      content: t.text,
      ...userMsgMeta(this.e),
      ...(t.imgRes ? { images: t.imgRes.uris, image_paths: t.imgRes.paths } : {}),
      ...(t.vidRes ? { videos: t.vidRes.uris, video_paths: t.vidRes.paths } : {}),
      ...(t.audRes ? { audios: t.audRes.uris, audio_paths: t.audRes.paths } : {}),
      ...(t.fileRes?.files?.length ? { files: t.fileRes.files, file_paths: t.fileRes.file_paths } : {}),
    }))
    localPending.push(...userMsgs)

    let prevIactId
    if (stateful) {
      prevIactId = await con().getInteractionId(this.e.self_id, this.e.user_id)
    } else {
      // 主动插话是临时无状态请求，不清理正常对话的交互 ID
      if (!isAmbient) await con().clearInteractionId(this.e.self_id, this.e.user_id)
      prevIactId = null
    }
    const maxRounds = getMaxToolRounds()

    for (let round = 0; round < maxRounds; round++) {
      // 构建本轮 API 请求的消息
      let apiMessages
      if (round === 0) {
        // 有状态+已有上下文 → 仅发增量；否则带历史
        apiMessages = stateful && prevIactId ? [systemMsg, ...userMsgs] : [systemMsg, ...baseMessages, ...userMsgs]
      } else {
        // 后续工具轮：有状态 → 仅发送未发送过的 tool 结果
        //            无状态 → 发送完整历史 + 本轮累积
        const unsentTools = localPending.filter(m => m.role === "tool" && !m._sent)
        apiMessages = stateful && prevIactId ? [systemMsg, ...unsentTools] : [systemMsg, ...baseMessages, ...localPending]
        // 标记这些 tool 消息为已发送，下轮不再重复
        for (const m of unsentTools) m._sent = true
      }

      const opts = {
        signal,
        stateful,
        tools: toolDefs,
        channel: isAmbient ? "ambient" : "main",
      }
      if (ambientModel) opts.model = ambientModel
      if (stateful && prevIactId) {
        opts.previous_interaction_id = prevIactId
      }

      let res
      try {
        res = await provider.chat(apiMessages, opts)
      } catch (err) {
        // 有状态模式下 interaction_id 过期 → 清理缓存，带完整历史降级重试
        if (err?.code === "SESSION_EXPIRED" && stateful && prevIactId) {
          log.warn(`Interaction ID 过期，清理本地缓存并使用全量历史重试`)
          await con().clearInteractionId(this.e.self_id, this.e.user_id)
          prevIactId = null
          delete opts.previous_interaction_id
          apiMessages = round === 0 ? [systemMsg, ...baseMessages, ...userMsgs] : [systemMsg, ...baseMessages, ...localPending]
          res = await provider.chat(apiMessages, opts)
        } else {
          throw err
        }
      }

      // 滚动更新交互 ID
      if (stateful && res.interaction_id) {
        prevIactId = res.interaction_id
      }

      if (res.blocked) {
        log.warn(`安全拦截  ${res.finishReason}`)
        if (isAmbient) return false
        return this.reply("内容被安全策略拦截", true)
      }

      // 输出效验: 清除学舌的引用前缀, 再落盘与发送
      if (res.content) res.content = this._stripQuotePrefix(res.content)

      const assistantMsg = buildAssistantMsg(res)
      localPending.push(assistantMsg)

      // 工具调用
      if (res.tool_calls?.length) {
        if (res.content) await this._sendReply(res.content, false)

        const names = res.tool_calls
          .map(c => c.function?.name)
          .filter(Boolean)
          .join(",")
        log.info(`调用工具: ${names}`)

        // media: 本轮已解析的多模态输入，供 agent 等工具转发给子架构
        const ctx = {
          user_id: this.e.user_id,
          event: this.e,
          signal,
          media: {
            images: userMsgs.flatMap(m => m.images || []),
            videos: userMsgs.flatMap(m => m.videos || []),
            audios: userMsgs.flatMap(m => m.audios || []),
            files: userMsgs.flatMap(m => m.files || []),
          },
        }
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
              return await tools().execute(fnName, args, ctx)
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

          // 延迟任务协议: 工具返回 { deferred: true, message: "..." }
          // → 把 message 当 tool result 传给 LLM，后台任务结束后走 injectMessage
          const isDeferred = payload && typeof payload === "object" && payload.deferred && payload.message
          let tContent, tImages, tVideos, tAudios, tFiles, tImagePaths, tVideoPaths, tAudioPaths, tFilePaths
          if (isDeferred) {
            tContent = payload.message
            log.info(`工具 ${r.name} 返回 deferred，任务将在后台执行`)
          } else if (payload && typeof payload === "object") {
            if (Array.isArray(payload.images)) {
              tImages = payload.images
              tImagePaths = payload.image_paths
              tContent = payload.text || "图片获取成功"
            }
            if (Array.isArray(payload.videos)) {
              tVideos = payload.videos
              tVideoPaths = payload.video_paths
              tContent = payload.text || "视频获取成功"
            }
            if (Array.isArray(payload.audios)) {
              tAudios = payload.audios
              tAudioPaths = payload.audio_paths
              tContent = payload.text || "音频获取成功"
            }
            if (Array.isArray(payload.files)) {
              tFiles = payload.files
              tFilePaths = payload.file_paths
              tContent = payload.text || "文件获取成功"
            }
          }
          if (!tContent) {
            tContent = typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
          }
          if (lastRound && i === results.length - 1) {
            tContent += `\n\n[系统提示] 你已达到最大工具调用轮次 (${maxRounds}轮)。请立即基于已获取的所有信息回复用户，不要再调用任何工具！！！如果信息不足，如实说明已掌握的情况即可。`
          }
          localPending.push({
            role: "tool",
            content: tContent,
            tool_call_id: callId,
            name: res.tool_calls[i]?.function?.name,
            signature: callSig,
            _sent: false,
            ...(tImages?.length ? { images: tImages } : {}),
            ...(tImagePaths?.length ? { image_paths: tImagePaths } : {}),
            ...(tVideos?.length ? { videos: tVideos } : {}),
            ...(tVideoPaths?.length ? { video_paths: tVideoPaths } : {}),
            ...(tAudios?.length ? { audios: tAudios } : {}),
            ...(tAudioPaths?.length ? { audio_paths: tAudioPaths } : {}),
            ...(tFiles?.length ? { files: tFiles } : {}),
            ...(tFilePaths?.length ? { file_paths: tFilePaths } : {}),
          })
        }
        continue
      }

      // 文本回复
      if (res.content) {
        return this._finishTextReply(res, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote)
      }

      log.warn(`空响应`)
      return
    }

    // 工具轮次用尽：tool_choice="none" 强制文本回复
    const unsentTools = localPending.filter(m => m.role === "tool" && !m._sent)
    const finalMessages = stateful && prevIactId ? [systemMsg, ...unsentTools] : [systemMsg, ...baseMessages, ...localPending]
    for (const m of unsentTools) m._sent = true

    const finalOpts = { signal, stateful, tool_choice: "none", channel: isAmbient ? "ambient" : "main" }
    if (ambientModel) finalOpts.model = ambientModel
    if (stateful && prevIactId) {
      finalOpts.previous_interaction_id = prevIactId
    }
    if (toolDefs.length) finalOpts.tools = toolDefs

    const finalReply = await provider.chat(finalMessages, finalOpts)

    if (stateful && finalReply.interaction_id) {
      prevIactId = finalReply.interaction_id
    }

    if (finalReply.content) {
      localPending.push(buildAssistantMsg(finalReply))
      return this._finishTextReply(finalReply, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote, "工具轮次超限，降级回复成功")
    }
    log.error(`全部失败`)
    if (isAmbient) return false
    return this.reply("请求失败", true)
  }
}

Object.assign(AigcChatCore.prototype, systemMethods)
