import cfg from "../../lib/config/config.js"
import runtime from "../../lib/aigc/runtime.js"
import common from "../../lib/common/common.js"
import { formatDate } from "../../lib/aigc/helpers/time.js"
import { faceName, faceId } from "../../lib/aigc/helpers/face.js"
import log from "../../lib/aigc/helpers/log.js"

const con = () => Bot.aigc.conversation
const tools = () => Bot.aigc.tools
const kb = () => Bot.aigc.knowledge
const MAX_TOOL_ROUNDS = 6

/** AIGC 入口：被 @ 且无命令匹配时触发，支持工具调用、长期记忆、知识库检索 */
export class AigcFallback extends plugin {
  constructor() {
    super({
      name: "AIGC",
      dsc: "AIGC 对话",
      event: "message",
      priority: 999999999,
      rule: [
        { reg: /^#关闭aigc$/i, fnc: "aigcOff" },
        { reg: /^#开启aigc$/i, fnc: "aigcOn" },
        { reg: /^#结束对话$/i, fnc: "clearMemory" },
        { reg: /^#清除记忆$/i, fnc: "clearMemory" },
        { reg: /^#结束全部对话$/i, fnc: "clearAllMemory", permission: "master" },
        { reg: /^#知识库添加(.+)$/i, fnc: "kbAdd" },
        { reg: /^#知识库删除\s*(\S+)$/i, fnc: "kbRemove" },
        { reg: /^#知识库列表$/i, fnc: "kbList" },
        { reg: /^#知识库清除$/i, fnc: "kbClear" },
        { reg: /^(.+)$/, fnc: "aigcChat", log: false },
      ],
    })
  }

  /** LLM 回复 → QQ 消息段: @name/@QQ 转为 at，[表情名] 转为表情 */
  _processContent(text) {
    if (typeof text !== "string" || !text) return text

    const parts = []
    let last = 0
    // @mention: 前面有无空格均可，后面必须空格或结尾；face: [中文/A-Z]
    const re = /(\s?)@([\p{Script=Han}\w]+)(?=\s|$)|\[([\p{Script=Han}A-Z]+)\]/gu
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
              if (ml) for (const [id, info] of ml) {
                if (info.card === target || info.nickname === target) { qq = id; break }
              }
            }
          } catch { }
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

  /** 按 <x><x><x> 分隔符拆分为多条消息依次发送 */
  async _splitReply(text) {
    const parts = text.split(/<x><x><x>/)
    if (parts.length <= 1) return this.reply(text, true)
    for (let i = 0; i < parts.length; i++) {
      const t = parts[i].trim()
      if (!t) continue
      await this.reply(t, i === 0)
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, Math.random() * 1000 + 1000))
    }
  }

  reply(msg = "", quote = false, data = {}) {
    if (this.e && !this.e.isGroup) quote = false
    return super.reply(this._processContent(msg), quote, data)
  }

  // 全局开关

  async aigcOff() {
    if (!this.e.isMaster) return false
    await runtime.setEnable(false)
    return this.reply("AIGC已关闭", true)
  }

  async aigcOn() {
    if (!this.e.isMaster) return false
    await runtime.setEnable(true)
    return this.reply("AIGC已开启", true)
  }

  // 记忆 / 对话清除

  async clearMemory() {
    const key = con().sessionKey(
      this.e.self_id,
      this.e.user_id,
      this.e.isGroup ? this.e.group_id : "",
    )
    const mems = await Bot.aigc.memory.getAll(this.e.user_id)
    const msgs = await con().getMessages(key)
    const hasMem = Object.keys(mems).length > 0
    const hasConv = msgs.length > 0

    await Bot.aigc.memory.clear(this.e.user_id)
    await con().clearSession(key)

    if (hasMem || hasConv) {
      log.info(`用户 ${this.e.user_id} 清除了会话`)
      return this.reply("AIGC记忆已清除", true)
    }
    return this.reply("暂无记忆缓存", true)
  }

  async clearAllMemory() {
    if (!this.e.isMaster) return false
    await Bot.aigc.memory.clearAll()
    await con().clearAll()
    log.info("管理员清除了全部用户的记忆和会话")
    return this.reply("已清除全部用户的记忆与对话缓存", true)
  }

  // 知识库管理

  async kbAdd() {
    if (!this.e.isMaster) return false
    const content = this.e.msg.replace(/^#知识库添加/i, "").trim()
    if (!content) return this.reply("请输入要添加的内容，格式：#知识库添加 <内容>", true)
    const r = await kb().add(content)
    if (r.error) return this.reply(`添加失败：${r.error}`, true)
    return this.reply(`已添加知识 [${r.id}]：${r.content}`, true)
  }

  async kbRemove() {
    if (!this.e.isMaster) return false
    const id = this.e.msg.replace(/^#知识库删除\s*/i, "").trim()
    if (!id) return this.reply("请输入要删除的知识 ID，格式：#知识库删除 <id>", true)
    const r = await kb().remove(id)
    if (r.error) return this.reply(`删除失败：${r.error}`, true)
    return this.reply(`已删除知识 [${r.id}]`, true)
  }

  async kbList() {
    if (!this.e.isMaster) return false
    const docs = await kb().list()
    if (!docs.length) return this.reply("知识库为空", true)
    const lines = docs.map((d) => `[${d.id}] ${d.content}`)
    return this.reply(lines.join("\n"), true)
  }

  async kbClear() {
    if (!this.e.isMaster) return false
    await kb().clear()
    return this.reply("已清除全部知识库内容", true)
  }

  // AIGC 对话主流程

  /** at 目标 → 显示名: 全体成员 / 群名片 / QQ号 */
  _resolveAtName(qq) {
    if (qq === "all") return "全体成员"
    try {
      if (this.e?.isGroup) {
        const m = Bot.pickMember(this.e.group_id, qq)
        return m.card || m.nickname || String(qq)
      }
    } catch { }
    return String(qq)
  }

  /** 从原始消息段重建完整文本，保留 @ 和图片等上下文 */
  _getUserMsg() {
    const segs = this.e.message
    if (!segs?.length) return this.e.msg?.trim() || ""

    const parts = []
    for (const seg of segs) {
      if (seg.type === "text") {
        parts.push(seg.text || "")
      } else if (seg.type === "at") {
        if (seg.qq == this.e.self_id) continue
        parts.push(` @${this._resolveAtName(seg.qq)} `)
      } else if (seg.type === "file") {
        parts.push("[文件]")
      } else if (seg.type === "face") {
        const name = faceName(seg.id)
        parts.push(name ? `[${name}]` : "[表情]")
      }
    }
    return parts.join("").trim()
  }

  async aigcChat() {
    if (cfg.aigc?.enable === false) return false
    if (this.e._synthetic) return false
    if (this.e.isPrivate && cfg.aigc?.private_enable === false && !this.e.isMaster) return false

    // 黑名单检查
    const blacklist = cfg.aigc?.qq_blacklist
    if (blacklist?.length) {
      const uid = String(this.e.user_id)
      for (const qq of blacklist) {
        if (String(qq) === uid) return false
      }
    }

    if (this.e.isGroup) {
      if (!this.e.atBot) return false

      const whitelist = cfg.aigc?.group_whitelist
      if (whitelist?.length) {
        const gid = String(this.e.group_id)
        if (!whitelist.some(g => String(g) === gid)) return false
      }
    }

    const userMsg = this._getUserMsg()
    if (!userMsg) return false

    // 前缀过滤（如 "[自动回复]"）
    const prefixFilter = cfg.aigc?.prefix_filter
    if (prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) return false

    // 并发锁：同一用户上一轮未结束时拒绝新请求，5 分钟自动过期
    const lockKey = `aigc:lock:${this.e.user_id}`
    if (await redis.get(lockKey)) return false
    await redis.set(lockKey, "1", { EX: 300 })

    const key = con().sessionKey(
      this.e.self_id,
      this.e.user_id,
      this.e.isGroup ? this.e.group_id : "",
    )

    log.info(`用户 ${this.e.user_id} 发起对话`)

    await con().setSystem(key, await this._buildSystem(userMsg))

    const images = this.e.img?.length ? this.e.img : null

    try {
      await this._replyLoop(key, userMsg, images)
    } catch (err) {
      log.error(`对话异常: ${err.message}`)
      const code = err.code ? `，错误码 ${err.code}` : ""
      await this.reply(`请求失败${code}，请稍后重试`, true)
    } finally {
      await redis.del(lockKey)
    }
  }

  /** 构建 system prompt：基础提示词 + 时间 + 工具规则 + 记忆 + 知识库 + 环境上下文 */
  async _buildSystem(userMsg) {
    const systemPrompt = `你的名字叫${cfg.aigc?.bot_name || "AIGC Bot"}，${cfg.aigc?.system_prompt || "You are an intelligent chatbot assistant."}`
      + (cfg.aigc?.split_reply ? `如果你想要一次回复多条消息，请使用 <x><x><x> 分割文本，例如：第一条消息内容<x><x><x>第二条消息内容<x><x><x>第三条消息内容，系统会帮你分为3条消息依次发送。` : "")

    const timeStr = formatDate(new Date(), "full")
    const toolRules = "You may call tools for up to 4 consecutive rounds. After that, stop calling tools and reply to the user based on the information you already have, even if incomplete."
    const parts = [
      `${systemPrompt}Current time: ${timeStr}. Take timeliness into account when answering.${toolRules}`,
    ]

    const memCtx = await Bot.aigc.memory.toContext(this.e.user_id)
    if (memCtx) parts.push(memCtx)

    const kbCtx = await kb().toContext(userMsg)
    if (kbCtx) parts.push(kbCtx)

    const envCtx = await this._buildEnvContext()
    if (envCtx) parts.push(envCtx)

    return parts.join("\n")
  }

  /** 构建聊天环境上下文：私聊/群聊信息、群内最近消息 */
  async _buildEnvContext() {
    const e = this.e

    if (e.isGroup) {
      let botCard = ""
      try { botCard = e.group?.pickMember?.(e.self_id)?.card || "" } catch { }
      const botName = botCard || Bot[e.self_id]?.nickname || ""

      const card = e.sender?.card || e.sender?.nickname || ""
      const role = { owner: "群主", admin: "群管理员", member: "群成员" }[e.member?.role] || e.member?.role || "群成员"
      const sex = { male: "男", female: "女", unknown: "未知" }[e.member?.sex] || e.member?.sex || "未知"

      const avatar = `https://q.qlogo.cn/g?b=qq&s=0&nk=${e.user_id}`
      let ctx = `You are in a group chat. Group: "${e.group_name || "Unknown"}" (ID: ${e.group_id}). Your nickname in this group: ${botName}. Your QQ: ${e.self_id}. Current speaker: [${card}](qq:${e.user_id},sex:${sex},role:${role},avatar:${avatar}).`

      const histCount = cfg.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        const history = await this._getGroupHistory(histCount)
        if (history) ctx += `\nRecent group chat history:\n${history}`
      }

      return ctx
    }

    const avatar = `https://q.qlogo.cn/g?b=qq&s=0&nk=${e.user_id}`
    return `You are in a private chat. User: ${e.sender?.nickname || "Unknown"} (QQ: ${e.user_id}, avatar: ${avatar}).`
  }

  /** 获取群聊最近 N 条消息 */
  async _getGroupHistory(count) {
    try {
      const e = this.e
      if (!e.group?.getChatHistory) return null

      const msgSeq = e.message_seq
      if (!msgSeq) return null

      const msgs = await e.group.getChatHistory(msgSeq, count, true)
      if (!msgs?.length) return null

      const lines = []
      for (const msg of msgs) {
        const sender = msg.sender || {}
        const name = sender.card || sender.nickname || "Unknown"
        const qq = sender.user_id || "?"
        const sex = { male: "男", female: "女", unknown: "未知" }[sender.sex] || sender.sex || "未知"
        const role = { owner: "群主", admin: "群管理员", member: "群成员" }[sender.role] || sender.role || "群成员"
        let time = ""
        if (msg.time) {
          const d = new Date(msg.time * 1000)
          time = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
        }

        const text = this._extractMsgText(msg)
        if (!text) continue

        const meta = [`qq:${qq}`, `sex:${sex}`, `role:${role}`]
        if (time) meta.push(`time:${time}`)
        lines.push(`[${name}](${meta.join(",")}): ${text}`)
      }

      return lines.length ? lines.join("\n") : null
    } catch (err) {
      log.warn(`群聊记录获取失败: ${err.message}`)
      return null
    }
  }

  /** 从群聊历史消息段重建完整文本，保留 @/表情/图片/文件 */
  _extractMsgText(msg) {
    const message = msg.message
    if (!message) {
      return (msg.raw_message || "").replace(/\[CQ:[^\]]+\]/g, "").trim()
    }
    if (typeof message === "string") return message
    if (!Array.isArray(message)) return ""

    const parts = []
    for (const seg of message) {
      if (seg.type === "text") {
        parts.push(seg.text || "")
      } else if (seg.type === "at") {
        parts.push(` @${this._resolveAtName(seg.qq)} `)
      } else if (seg.type === "image") {
        parts.push("[图片]")
      } else if (seg.type === "file") {
        parts.push("[文件]")
      } else if (seg.type === "face") {
        const name = faceName(seg.id)
        parts.push(name ? `[${name}]` : "[表情]")
      } else if (seg.type === "video") {
        parts.push("[视频]")
      } else if (seg.type === "record" || seg.type === "audio") {
        parts.push("[语音]")
      }
    }
    return parts.join("").trim()
  }

  /** 发送回复：检查语音标识 → 若开启则转语音，否则纯文本 */
  async _sendReply(text) {
    try {
      const emo_switch = await Bot.aigc.voice.consume(this.e.user_id)
      if (emo_switch) {
        const audioUrl = await Bot.aigc.voice.tts(text, emo_switch)
        return this.e.reply(segment.record(audioUrl))
      }
    } catch (err) {
      log.error(`语音转换失败，降级为文本: ${err.message}`)
    }
    return this._splitReply(text)
  }

  /** 从 provider 响应构建待持久化的 assistant 消息 */
  _buildAssistantMsg(res) {
    return {
      role: "assistant",
      content: res.content || null,
      ...(res.tool_calls && { tool_calls: res.tool_calls }),
      ...(res.reasoning_content && { reasoning_content: res.reasoning_content }),
      ...(res.reasoning_parts && { reasoning_parts: res.reasoning_parts }),
    }
  }

  /** 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则发送并退出。
   *  整轮对话在内存中累积，最终回复生成后才原子写入缓存，避免中途死机留下残缺记录。 */
  async _replyLoop(sessionKey, userMsg, images) {
    const baseMessages = await con().getMessages(sessionKey)
    const pending = []
    let userPushed = false

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messages = [...baseMessages, ...pending]
      if (!userPushed) {
        const um = { role: "user", content: userMsg }
        if (images) um.images = images
        messages.push(um)
      }

      const opts = {}
      const toolDefs = tools().getDefinitions()
      if (toolDefs.length) {
        opts.tools = toolDefs
        opts.tool_choice = "auto"
      }

      const res = await Bot.aigc.provider.chat(messages, opts)

      if (res.blocked) {
        log.warn(`安全拦截  ${res.finishReason}`)
        return this.reply("内容被安全策略拦截", true)
      }

      if (res.tool_calls?.length) {
        if (res.content) await this._splitReply(res.content)

        const names = res.tool_calls.map(c => c.function?.name).filter(Boolean).join(",")
        log.info(`调用工具: ${names}`)

        if (!userPushed) {
          pending.push({ role: "user", content: userMsg, time: Date.now(), ...(images ? { images } : {}) })
          userPushed = true
        }
        pending.push(this._buildAssistantMsg(res))

        const results = await tools().executeAll(res.tool_calls, {
          user_id: this.e.user_id,
          event: this.e,
        })
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const callId = res.tool_calls[i]?.id || `call_${i}`
          const payload = "error" in r ? r.error : r.result
          pending.push({ role: "tool", content: JSON.stringify(payload ?? ""), tool_call_id: callId })
        }
        continue
      }

      if (res.content) {
        if (!userPushed) {
          pending.push({ role: "user", content: userMsg, time: Date.now(), ...(images ? { images } : {}) })
          userPushed = true
        }
        pending.push(this._buildAssistantMsg(res))

        await con().appendMessages(sessionKey, pending)

        if (res.reasoning_content && cfg.aigc?.show_thinking) {
          const thinkingMsg = await common.makeForwardMsg(this.e, [
            { type: "text", data: { text: res.reasoning_content } },
          ])
          await this.reply(thinkingMsg, true)
        }

        return this._sendReply(res.content)
      }

      log.warn(`空响应`)
      return
    }

    // 轮次超限，最后一次不带 tools 尝试
    log.warn(`超限`)
    const fallbackMessages = [...baseMessages, ...pending]
    if (!userPushed) {
      const um = { role: "user", content: userMsg }
      if (images) um.images = images
      fallbackMessages.push(um)
    }
    const finalReply = await Bot.aigc.provider.chat(fallbackMessages)
    if (finalReply.content) {
      if (!userPushed) {
        pending.push({ role: "user", content: userMsg, time: Date.now(), ...(images ? { images } : {}) })
      }
      pending.push(this._buildAssistantMsg(finalReply))
      await con().appendMessages(sessionKey, pending)
      log.warn(`工具轮次超限，降级回复成功`)
      return this._sendReply(finalReply.content)
    }

    log.error(`全部失败`)
    return this.reply("工具调用轮次超限，请简化你的请求后重试", true)
  }
}
