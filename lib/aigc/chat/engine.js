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

// 请求合并/排队: self_id:user_id → { controller, pendingTurns, isAmbient, injected, group_id, done }
// 同一用户触发新对话时，取消上一轮未完成的请求，把本次输入追加为独立 user 消息重发
// 定时/后台注入与用户输入不互相打断: 按到达先后排队, 先到方结束后(done)再入场
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

    // 分流模型，影响模型族条件行为
    const mainModel = cfg.aigc?.gemini?.model || ""
    const effectiveModel = isAmbient ? cfg.aigc?.ambient?.model || "gemini-3-5-flash" : mainModel
    const removeAudio = /^gemma/i.test(effectiveModel)

    // 请求合并/排队: 用户输入之间沿用打断合并(非水群请求把本次输入追加为独立的 user 消息)
    // 用户输入与定时/后台注入互不打断合并 —— 按到达先后排队
    // 后到方在排队期间先完成媒体转码, 等先到方结束并落盘后重新入场
    const isInjected = !!this.e?._injected
    let turns = [turn]
    let merged = false // 打断合并入场
    while (true) {
      const existing = activeRequests.get(reqKey(this.e))
      if (!existing || existing.injected === isInjected) {
        if (existing) {
          existing.controller.abort()
          if (existing.isAmbient) {
            log.info(`用户 ${this.e.user_id} 切换到at对话`)
          } else if (existing.pendingTurns?.length) {
            turns = [...existing.pendingTurns, turn]
            merged = true
          }
        }
        break
      }
      // 类型不同 → 排队等待; 排队期间先把媒体转码好
      log.info(`用户 ${this.e.user_id} 的${isInjected ? "注入任务" : "输入"}与${existing.injected ? "注入任务" : "对话"}撞车，排队等待对方结束`)
      for (const t of turns) {
        if (!t.imgs.length && !t.videos.length && !t.audios.length && !t.files.length) continue
        try {
          await this._resolveTurnMedia(t, removeAudio)
        } catch (err) {
          log.debug(`排队期间媒体转码失败，入场后重试: ${err.message}`)
          t.imgRes = t.vidRes = t.audRes = t.fileRes = undefined
        }
      }
      await existing.done
    }
    const controller = new AbortController()
    const done = Promise.withResolvers()
    activeRequests.set(reqKey(this.e), { controller, isAmbient, injected: isInjected, pendingTurns: turns, group_id: this.e.isGroup ? String(this.e.group_id) : null, done: done.promise })

    const key = con().sessionKey(this.e.self_id, this.e.user_id)
    const label = isAmbient ? "主动插话" : "对话"

    try {
      if (!isAmbient) await con().addActiveUser(dateStr(), this.e.self_id, this.e.user_id)
      log.info(`用户 ${this.e.user_id} ${merged ? `合并请求 (共${turns.length}条输入)` : `发起${label}`}`)

      const systemPrompt = await this._buildSystem(
        turns.map(t => t.text),
        effectiveModel,
        isAmbient,
      )
      // 逐 turn 解析媒体 —— 排队期已解析(data URI)的直接复用，避免重复下载/编码；
      // 被中断请求留下的占位结果([图像异常]等)需重新解析
      if (removeAudio && turns.some(t => t.audios.length)) log.debug(`模型 ${effectiveModel} 不支持音频输入，已忽略语音`)
      for (const t of turns) {
        await this._resolveTurnMedia(t, removeAudio, controller.signal)
      }
      await this._replyLoop(key, turns, systemPrompt, controller.signal, isAmbient)
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`用户 ${this.e.user_id} 打断`)
        return false
      }
      log.error(`${label}异常: ${err.message}`)
      // 定时/后台注入请求失败静默处理, 不打扰用户
      if (!isAmbient && !this.e?._injected) await this.reply("我有些累了，请让我休息一会儿", true)
    } finally {
      if (activeRequests.get(reqKey(this.e))?.controller === controller) {
        activeRequests.delete(reqKey(this.e))
      }
      done.resolve()
    }
  }

  /** 逐 turn 解析媒体 —— 正式触发与排队期预转码共用; 已解析(data URI)直接复用 */
  async _resolveTurnMedia(t, removeAudio, signal) {
    if (!mediaResolved(t.imgRes)) t.imgRes = await provider.resolveImages(t.imgs, signal)
    if (!mediaResolved(t.vidRes) || t.vidRes.rmAudio !== !!removeAudio) {
      t.vidRes = await provider.resolveVideo(t.videos, removeAudio, signal)
      if (t.vidRes) t.vidRes.rmAudio = !!removeAudio
    }
    t.audRes = removeAudio ? null : mediaResolved(t.audRes) ? t.audRes : await provider.resolveAudio(t.audios, signal)
    if (!mediaResolved(t.fileRes)) t.fileRes = await provider.resolveFiles(t.files, signal)
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

  /** 思维链重建：子模型按 配置系统提示词 + 长期记忆 + 近15轮历史 + 本轮经过 + 原始英文摘要
   *  以主模型立场逆推中文思考过程。返回重建文本；失败/超时/空回复返回 null */
  async _reconstructThinking(res, reconCtx, localPending, signal, tr) {
    const model = tr.model || "gemini-3.6-flash"
    if (!model) return null
    log.info("思维链重建中")

    // 压缩空白/去掉媒体路径标记([xx](path) → [xx])/截断
    const clean = s =>
      String(s ?? "")
        .replace(/\[([^\]]*)\]\([^)\n]*\)/g, "[$1]")
        .trim()
        .replace(/\s*\n\s*/g, "\n")
        .slice(0, 1500)

    // 消息 → 文本行: 用户文本/工具结果/工具调用
    // assistant 调用工具前的过渡文本与工具行一起保留
    const msgLine = m => {
      if (m.role === "user") return [`用户: ${clean(m.content) || "(空)"}`]
      if (m.role === "tool") return [`(工具 ${m.name || "unknown"} 返回): ${clean(m.content) || "(空)"}`]
      if (m.role === "assistant") {
        const lines = []
        if (m.content) lines.push(`助手: ${clean(m.content)}`)
        for (const tc of m.tool_calls || []) {
          lines.push(`助手调用工具 ${tc.function?.name || "?"}: ${String(tc.function?.arguments ?? "").slice(0, 300)}`)
        }
        if (!lines.length) lines.push("助手: (无文本)")
        return lines
      }
      return []
    }

    // 最近 15 轮
    // 从尾部按"用户消息"倒推整轮，工具调用/结果随所在轮次一起保留，避免截断拆散半个回合
    const hist = reconCtx?.history || []
    const recent = []
    for (let i = hist.length - 1; i >= 0; i--) {
      recent.unshift(hist[i])
      if (recent.filter(m => m.role === "user").length >= 15) break
    }
    const historyLines = recent.flatMap(msgLine)

    // 本轮经过: 逐条展开，最后一条无工具调用的 assistant 单独作最终答复
    const roundLines = []
    for (let i = 0; i < localPending.length; i++) {
      const m = localPending[i]
      const isFinal = i === localPending.length - 1 && m.role === "assistant" && !m.tool_calls?.length
      if (!isFinal) roundLines.push(...msgLine(m))
    }

    // 长期记忆注入
    let memories = ""
    try {
      if (this.e) memories = (await con().getMemories(this.e.self_id, this.e.user_id)) || ""
    } catch (err) {
      log.debug(`记忆读取失败: ${err.message}`)
    }

    const cfgPrompt = clean(cfg.aigc?.system_prompt) || clean(reconCtx?.system) || "(无)"
    const finalText = clean(res.content) || "(无)"
    const origSummary = clean(res.reasoning_content)

    const payload = `请以简体中文、第一人称，站在主模型(即最终答复的发出者)的立场，还原其在给出最终答复前经历的思考过程(思维链)。

要求:
1. 直接输出思考过程正文，不要任何前缀、标题外包装或解释性文字。
2. 思考是主模型向内的内心推演: 不要出现对用户的对话感(如"我会告诉用户…")，不要复述将要说出口的话，不要提及本任务或"重建/翻译/摘要/提示词"等字样。
3. 思考需与最终答复的观点、语气、人设一致; 可在适当处用简短标题/列表排版，详略与素材中的英文摘要大致相当。
4. 以素材为真实脉络，允许适度补充自然的内心活动与措辞、让思考更有人的语气，但不得与最终答复矛盾，不得虚构素材中不存在的关键信息。
5. 思维的"质感"要随本轮情况自然变化，不要套固定桥段: 简单明确的事可以直接果断地得出结论，不需要硬演犹豫; 含糊、敏感或需要拿捏分寸的事，可以自然地迟疑、反问自己、掂量几种说法的分量，试错后收敛; 需要做选择的事，可以在心里比较方案、权衡后果再定; 事实性问答则以核对与组织为主。自我怀疑只在语境真的需要时出现——宁缺毋滥; 一旦出现就要收得住，整条思路的落点必须与最终答复一致，不得虚构素材中不存在的关键事实。
6. 质感示意(只示范"犹豫如何长在具体语境里"，场景与素材不同，禁止照搬句式): 对方说"随便啦"，但语气不太对——是气话还是真无所谓？先别当成随口一说，上次没接住话让她闷了一整天。直接追问又怕扫兴……算了，先顺着哄一句，看她接不接。

===== 主模型设定(人设参考，思考须符合该设定应该有的思维方式，但不要复述设定内容) =====
${cfgPrompt}

${memories ? `===== 长期记忆(主模型与用户的记忆提供参考) =====\n<user_memories>\n${memories}\n</user_memories>\n\n` : ""}===== 最近对话(早 → 新) =====
${historyLines.join("\n") || "(无)"}

===== 本轮对话经过 =====
${roundLines.join("\n") || "(无)"}

===== 主模型最终答复 =====
${finalText}

${origSummary ? `===== 主模型原始思考摘要(英文，仅作线索参考，不要逐句直译或照抄) =====\n${origSummary}` : ""}`

    try {
      const timeout = tr.timeout_ms ?? 30000
      const child = await Bot.sleep(
        timeout,
        provider.chat(
          [
            { role: "system", content: "你是写作转写助手，负责把对话材料转写成自然的中文第一人称内心思考记录。只输出正文。" },
            { role: "user", content: payload },
          ],
          { model, stateful: false, channel: "reconstruct", max_tokens: 65536, signal },
        ),
      )
      if (child === Bot.sleepTimeout) {
        log.warn("思维链重建超时，降级原始摘要")
        return null
      }
      const text = String(child?.content || "").trim()
      if (!text || /^no_reply$/i.test(text)) {
        log.warn(`思维链重建返回空内容，降级原始摘要`)
        return null
      }
      return text
    } catch (err) {
      if (err?.name === "AbortError") throw err
      return null
    }
  }

  /** 终结本轮文本回复：输出效验 → no_reply 检查 → (思维链重建)? → 落盘 → 清理请求标记 → 发送。
   *  no_reply 时完整落盘并返回 false。
   *  @param {object} [reconCtx] 思维链重建素材: { system: 完整系统提示词, history: 落盘历史 }，
   *    仅 thinking_reconstruct.enable 开启时使用
   *  @param {string} [warnMsg] 非空时在发送前记录一条降级日志 */
  async _finishTextReply(res, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote, reconCtx = null, warnMsg) {
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

    // 思维链重建：show_thinking + thinking_reconstruct.enable 同时开启且本轮有思维链时，
    // 不直接发送，先由子模型按对话脉络逆推中文思维链再展示。置于落盘之前 ——
    // 重建期间被用户打断(AbortError)则整轮不落盘不发送，与新请求合并重发，
    // 避免"已落盘却未发送"的半成品进入历史
    // 定时任务/后台任务触发不展示思维链，重建一并跳过，避免无效调用
    const tr = cfg.aigc?.thinking_reconstruct
    if (res.reasoning_content && cfg.aigc?.show_thinking && tr?.enable && !this.e?._injected) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const reconstructed = await this._reconstructThinking(res, reconCtx, localPending, signal, tr)
      if (reconstructed) {
        res.reasoning_content = reconstructed
        log.info("思维链重建成功!")
      }
    }

    // 落盘
    await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)

    // 本轮已终结: 条件移除自己的请求标记,此后同用户新触发即全新请求
    if (activeRequests.get(reqKey(this.e))?.controller?.signal === signal) {
      activeRequests.delete(reqKey(this.e))
    }

    // 落盘前已被新请求中止 → 不再发送本次回复
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // 定时任务/后台任务触发不转发思维链，只发正文
    if (res.reasoning_content && cfg.aigc?.show_thinking && !this.e?._injected) {
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
    const ambientModel = isAmbient ? cfg.aigc?.ambient?.model || "gemini-3-5-flash" : undefined
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
        // 水群与定时/后台注入静默丢弃
        if (isAmbient || this.e?._injected) return false
        return this.reply("内容被安全策略拦截", true)
      }

      // 输出效验: 清除学舌的引用前缀, 再落盘与发送
      if (res.content) res.content = this._stripQuotePrefix(res.content)

      const assistantMsg = buildAssistantMsg(res)
      localPending.push(assistantMsg)

      // 工具调用
      if (res.tool_calls?.length) {
        // 中间文本同样尊重 no_reply 约定: 已读不回的内容不外发
        const interim = (res.content || "").trim()
        if (interim && !/^no_reply$/i.test(interim)) await this._sendReply(res.content, false)

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
        return this._finishTextReply(res, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote, { system: systemMsg.content, history: baseMessages })
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
      return this._finishTextReply(finalReply, sessionKey, localPending, stateful, prevIactId, signal, isAmbient, replyQuote, { system: systemMsg.content, history: baseMessages }, "工具轮次超限，降级回复成功")
    }
    log.error(`全部失败`)
    // 水群与定时/后台注入静默丢弃
    if (isAmbient || this.e?._injected) return false
    return this.reply("请求失败", true)
  }
}

Object.assign(AigcChatCore.prototype, systemMethods)
