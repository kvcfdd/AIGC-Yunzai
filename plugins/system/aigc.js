import cfg from "../../lib/config/config.js"
import common from "../../lib/common/common.js"
import { formatDate } from "../../lib/aigc/helpers/time.js"
import { faceName, faceId } from "../../lib/aigc/helpers/face.js"
import log from "../../lib/aigc/helpers/log.js"
import { yesterdayStr, dateStr } from "../../lib/aigc/conversation.js"

const con = () => Bot.aigc.conversation
const tools = () => Bot.aigc.tools
const getMaxToolRounds = () => Math.min(Math.max(cfg.aigc?.max_tool_rounds ?? 5, 2), 10)

const AMBIENT_KEY_PREFIX = "aigc:ambient:cooldown"

// 请求合并: user_id → { controller, pendingMsg, pendingImg, pendingVideo }
// 同一用户触发新对话时，取消上一轮未完成的请求，合并消息/图片/视频后重发
const activeRequests = new Map()

/** 总结单个用户指定日期的对话 → 记忆 → 裁剪 → 删更早键
 *  返回 { ok, reason? } */
async function summarizeOne(self_id, user_id, date) {
  const key = con().sessionKey(self_id, user_id, date)
  const session = await con()._read(key)
  if (!session?.messages?.length) return { ok: false, reason: "无对话记录" }

  const qa = con().extractQA(session.messages)
  if (!qa) return { ok: false, reason: "无可总结内容" }

  try {
    const ambient = cfg.aigc?.ambient || {}
    const opts = {}
    if (ambient.provider) opts.provider = ambient.provider
    if (ambient.model) opts.model = ambient.model
    const res = await Bot.aigc.provider.chat(
      [
        { role: "system", content: `你是一个对话总结助手。请以AI助手第一人称的视角将以下用户与AI助手的对话总结为一段摘要（不超过200字），即在200字范围内尽可能详细的说明聊了什么。请直接输出摘要文本，不要加任何前缀或解释。\n\n#对话内容：\n${qa}` },
        { role: "user", content: "[记忆总结触发]" },
      ],
      opts,
    )
    const summary = (res.content || "").trim()
    if (summary) {
      await con().addMemory(self_id, user_id, date, summary)
      log.debug(`记忆已保存: ${self_id}/${user_id}`)
    }
  } catch (err) {
    log.warn(`记忆总结 LLM 调用失败 [${self_id}/${user_id}]: ${err.message}`)
    return { ok: false, reason: `LLM 调用失败: ${err.message}` }
  }

  // 裁剪 + 删更早键
  try {
    const s = await con()._read(key)
    if (s) {
      con().trimTo(s, 5)
      await con()._write(key, s)
    }
    await con().deleteOlderThan(self_id, user_id, date)
  } catch (err) {
    log.error(`裁剪失败 [${self_id}/${user_id}]: ${err.message}`)
  }

  return { ok: true }
}

/** 扫描今天之前所有未归档日期，按时序逐天总结 */
async function dailyMemoryJob() {
  const today = dateStr()

  // 获取所有历史活跃日期，筛选出今天之前的
  const allDates = await con().scanAllActiveDates()
  const pastDates = allDates.filter(d => d < today)
  if (!pastDates.length) {
    log.info("每日记忆总结: 无历史未归档对话记录")
    return
  }

  log.info(`每日记忆总结: 发现 ${pastDates.length} 个历史日期，按时序归档`)

  const failed = []
  const userLock = async (user_id, fn) => {
    const lockKey = `aigc:lock:${user_id}`
    if (await redis.get(lockKey)) return false
    await redis.set(lockKey, "1", { EX: 300 })
    try {
      return await fn()
    } finally {
      await redis.del(lockKey)
    }
  }

  // 按日期从旧到新，逐天逐人归档
  for (const targetDate of pastDates.sort()) {
    const users = await con().scanUsersForDate(targetDate)
    if (!users.length) {
      await con().clearActiveUsersForDate(targetDate)
      continue
    }

    log.info(`每日记忆总结: 归档 [${targetDate}] ${users.length} 个用户`)

    // 第一轮
    for (const user of users) {
      const [self_id, user_id] = user.split(":")
      const executed = await userLock(user_id, async () => {
        const result = await summarizeOne(self_id, user_id, targetDate)
        if (!result.ok) {
          failed.push({ user, date: targetDate })
          log.warn(`归档失败 [${user}] (${targetDate}): ${result.reason}`)
        }
        return true
      })
      if (executed === false) {
        log.info(`每日记忆总结: 用户忙碌 [${user}] (${targetDate})，加入重试队列`)
        failed.push({ user, date: targetDate })
      }
    }

    // 清理当前日期活跃记录
    try {
      await con().clearActiveUsersForDate(targetDate)
    } catch (err) {
      log.warn(`清理活跃记录失败 [${targetDate}]: ${err.message}`)
    }
  }

  // 重试失败/忙碌的任务
  if (failed.length) {
    log.info(`每日记忆总结: 等待 5 秒后重试 ${failed.length} 个失败/忙碌记录`)
    await Bot.sleep(5000)

    for (const { user, date } of failed) {
      const [self_id, user_id] = user.split(":")
      const executed = await userLock(user_id, async () => {
        const result = await summarizeOne(self_id, user_id, date)
        if (!result.ok) {
          log.warn(`每日记忆总结: 重试仍失败 [${user}] (${date}): ${result.reason}，保留完整对话`)
        }
        return true
      })
      if (executed === false) {
        log.warn(`每日记忆总结: 重试时用户 [${user}] (${date}) 仍忙碌，保留该日完整对话`)
      }
    }
  }

  log.info("每日记忆总结: 完成")
}

/** AIGC 入口：被 @ 且无命令匹配时触发，支持工具调用、长期记忆、知识库检索 */
export class AigcFallback extends plugin {
  constructor() {
    super({
      name: "AIGC",
      dsc: "AIGC 对话",
      event: "message",
      priority: 999999999,
      task: { name: "AIGC每日记忆总结", cron: "0 0 * * *", fnc: dailyMemoryJob, log: false },
      rule: [
        { reg: /^#关闭aigc$/i, fnc: "aigcOff" },
        { reg: /^#开启aigc$/i, fnc: "aigcOn" },
        { reg: /^#结束对话$/i, fnc: "clearConv" },
        { reg: /^#结束全部对话$/i, fnc: "clearAllConv", permission: "master" },
        { reg: /^#总结记忆$/i, fnc: "manualMemory", permission: "master" },
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

  /** 按 <x> 分隔符拆分为多条消息依次发送 */
  async _splitReply(text, quote = true) {
    const parts = text.split(/<x>/)
    if (parts.length <= 1) return this.reply(text, quote)
    for (let i = 0; i < parts.length; i++) {
      const t = parts[i].trim()
      if (!t) continue
      await this.reply(t, i === 0 && quote)
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
    cfg.setConfig("aigc", "enable", false)
    return this.reply("AIGC已关闭", true)
  }

  async aigcOn() {
    if (!this.e.isMaster) return false
    cfg.setConfig("aigc", "enable", true)
    return this.reply("AIGC已开启", true)
  }

  // 对话清除
  async clearConv() {
    const msgs = await con().getMessages(this.e.self_id, this.e.user_id)
    if (!msgs.length) return this.reply("暂无对话记录", true)

    await con().clearSession(this.e.self_id, this.e.user_id)
    log.info(`用户 ${this.e.user_id} 清除了对话记录`)
    return this.reply("对话记录已清除", true)
  }

  async clearAllConv() {
    if (!this.e.isMaster) return false
    await con().clearAll()
    log.info("管理员清除了全部用户的对话记录")
    return this.reply("已清除全部用户的对话记录", true)
  }

  /** 手动触发昨天的记忆总结，便于测试或补漏 */
  async manualMemory() {
    if (!this.e.isMaster) return false
    const yesterday = yesterdayStr()

    if (await con().hasMemoryForDate(this.e.self_id, this.e.user_id, yesterday)) {
      return this.reply("昨天的对话已总结过，无需重复触发", true)
    }

    await con().addActiveUser(yesterday, this.e.self_id, this.e.user_id)
    const result = await summarizeOne(this.e.self_id, this.e.user_id, yesterday)

    if (result.ok) {
      return this.reply("记忆总结完成", true)
    }
    return this.reply(`总结失败: ${result.reason}`, true)
  }

  /** 主动插话决策 prompt —— 仅负责判断要不要开口，不干预说话方式 */
  _buildAmbientPrompt() {
    const systemPrompt = cfg.aigc?.system_prompt || "你的名字叫云崽，一个智能助手。"
    const lines = [
      `## System Prompt`,
      `${systemPrompt}`,
      ``,
      `你在群里看大家聊天。不说话是常态，大多数人 80% 的时间在划水。`,
      ``,
      `## 不该说话`,
      `- 话题跟你无关、插不上嘴`,
      `- 最近已经说过话了，没必要重复`,
      `- 闲聊开玩笑、你没实质性内容`,
      `- 只是表情、问候、附和`,
      `- 没看懂、听不懂 → 别硬接，沉默`,
      `- 对方故意激怒你、给你下套 → 别上套，沉默`,
      `- 已经有人接了、话题在收尾`,
      `- 单纯不想回、不感兴趣`,
      ``,
      `## 可以说话`,
      `- 讨论你擅长的，有内容可补充`,
      `- 有人提问你能答`,
      `- 有人提到你`,
      `- 群里氛围你能自然融入，群友聊什么语气你就用什么语气，别端着`,
      `- 大家在复读，你感兴趣的话也能参与`,
      ``,
      `## 规则`,
      `- 不说话 → 只回复 OFF（三个字母，别无其他）`,
      `- 说话 → 直接回复，简短口语化，不超过 40 字`,
    ]
    return lines.join("\n")
  }

  /** 主动插话：非 @ 触发，LLM 自主决定是否参与群聊。
   *  不走对话缓存、不带工具，回复不污染 conversation。 */
  async _ambientTry(signal) {
    const gid = String(this.e.group_id)
    const cooldownKey = `${AMBIENT_KEY_PREFIX}:${gid}`

    // Redis 冷却检查
    const existing = await redis.get(cooldownKey)
    if (existing) {
      const remain = await redis.ttl(cooldownKey)
      log.debug(`群 ${gid} 主动插话冷却中 (${remain}s)`)
      return false
    }

    const ambient = cfg.aigc?.ambient || {}
    const cooldownMin = (ambient.cooldown_min ?? 10) * 60
    const cooldownMax = (ambient.cooldown_max ?? 20) * 60
    const cooldown = cooldownMin + Math.floor(Math.random() * (cooldownMax - cooldownMin + 1))

    const userMsg = this._getUserMsg()
    if (!userMsg) return false

    // 前缀过滤
    const prefixFilter = cfg.aigc?.prefix_filter
    if (prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) {
      return false
    }

    await redis.set(cooldownKey, "1", { EX: cooldown })
    log.info(`群 ${gid} 主动插话判断中...`)

    try {
      const systemPrompt = this._buildAmbientPrompt()
      const supplement = this._buildSupplement(true)
      const envCtx = await this._buildEnvContext()
      const fullSystem = [systemPrompt, supplement, envCtx].filter(Boolean).join("\n")

      const messages = [
        { role: "system", content: fullSystem },
        { role: "user", content: userMsg },
      ]

      const opts = {}
      if (signal) opts.signal = signal
      if (ambient.provider) opts.provider = ambient.provider
      if (ambient.model) opts.model = ambient.model
      const res = await Bot.aigc.provider.chat(messages, opts)
      const text = (res.content || "").trim()

      if (!text || /^OFF$/i.test(text)) {
        log.info(`群 ${gid} 主动插话: 跳过`)
        return false
      }

      log.info(`群 ${gid} 主动插话: 回复`)
      activeRequests.delete(this.e.user_id)
      return this._sendReply(text, false)
    } catch (err) {
      log.warn(`群 ${gid} 主动插话异常: ${err.message}`)
      return false
    }
  }

  // AIGC 对话主流程

  /** at 目标 → 显示名: 全体成员 / 群名片 / QQ号 */
  _resolveAtName(qq) {
    if (qq === "all") return "全体成员"
    try {
      if (this.e?.isGroup) {
        const gid = this.e.group_id
        const ml = Bot.gml?.get(Number(gid)) || Bot.gml?.get(String(gid))
        if (ml) {
          const info = ml.get(Number(qq)) || ml.get(String(qq))
          if (info) {
            return info.card || info.nickname || String(qq)
          }
        }

        const m = Bot.pickMember(gid, qq)
        if (m) {
          return m.card || m.nickname || String(qq)
        }
      }
    } catch (err) {
      // 避免解析异常导致流程中断
    }
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
        parts.push(`@${this._resolveAtName(seg.qq)}`)
      } else if (seg.type === "image") {
        parts.push("[图片]")
      } else if (seg.type === "video") {
        parts.push("[视频]")
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
      const whitelist = cfg.aigc?.group_whitelist
      if (whitelist?.length) {
        const gid = String(this.e.group_id)
        if (!whitelist.some(g => String(g) === gid)) return false
      }

      if (!this.e.atBot) {
        const ambient = cfg.aigc?.ambient
        if (ambient?.enable) {
          if (activeRequests.has(this.e.user_id)) return false
          const ambController = new AbortController()
          activeRequests.set(this.e.user_id, { controller: ambController, pendingMsg: "", pendingImg: [], pendingVideo: [] })
          try {
            return await this._ambientTry(ambController.signal)
          } finally {
            if (activeRequests.get(this.e.user_id)?.controller === ambController) {
              activeRequests.delete(this.e.user_id)
            }
          }
        }
        return false
      }
    }

    const userMsg = this._getUserMsg()
    if (!userMsg) return false

    // 前缀过滤（如 "[自动回复]"）
    const prefixFilter = cfg.aigc?.prefix_filter
    if (prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) return false

    // 请求合并：上一轮未完成时取消旧请求，合并消息/图片/视频后重发
    let finalMsg = userMsg
    let finalImg = this.e.img || []
    let finalVideo = this.e.video || []
    const existing = activeRequests.get(this.e.user_id)
    if (existing) {
      existing.controller.abort()
      finalMsg = existing.pendingMsg ? existing.pendingMsg + "\n" + userMsg : userMsg
      if (existing.pendingImg?.length) {
        finalImg = [...existing.pendingImg, ...finalImg]
      }
      if (existing.pendingVideo?.length) {
        finalVideo = [...existing.pendingVideo, ...finalVideo]
      }
    }
    const controller = new AbortController()
    activeRequests.set(this.e.user_id, { controller, pendingMsg: finalMsg, pendingImg: finalImg, pendingVideo: finalVideo })

    const key = con().sessionKey(this.e.self_id, this.e.user_id)
    await con().addActiveUser(dateStr(), this.e.self_id, this.e.user_id)

    log.info(`用户 ${this.e.user_id} 发起对话`)

    try {
      const systemPrompt = await this._buildSystem(finalMsg)
      const images = await Bot.aigc.provider.resolveImages(finalImg)
      const videos = await Bot.aigc.provider.resolveVideo(finalVideo)
      await this._replyLoop(key, finalMsg, images, videos, systemPrompt, controller.signal)
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`用户 ${this.e.user_id} 打断`)
        return false
      }
      log.error(`对话异常: ${err.message}`)
      // const code = err.code ? `，错误码 ${err.code}` : ""
      // await this.reply(`请求失败${code}，请稍后重试`, true)
      await this.reply("我有些累了，请让我休息一会儿", true)
    } finally {
      if (activeRequests.get(this.e.user_id)?.controller === controller) {
        activeRequests.delete(this.e.user_id)
      }
    }
  }

  /** 构建 system prompt，MD 标题 + XML 标签格式 */
  async _buildSystem(userMsg) {
    const parts = []

    const identity = this._buildIdentity()
    if (identity) parts.push(identity)

    const memories = await con().getMemories(this.e.self_id, this.e.user_id)
    if (memories) parts.push(`<user_memories>\n以下是用户与你的历史对话摘要供参考：\n${memories}\n</user_memories>`)

    const supplement = this._buildSupplement()
    if (supplement) parts.push(supplement)

    const envCtx = await this._buildEnvContext()
    if (envCtx) parts.push(envCtx)

    return parts.join("\n")
  }

  /** System Prompt */
  _buildIdentity() {
    const prompt = cfg.aigc?.system_prompt || "你的名字叫云崽，一个智能助手。根据用户的提问提供有帮助的回答。"
    return `## System Prompt\n${prompt}`
  }

  /** 系统补充信息 */
  _buildSupplement(ambient = false) {
    const e = this.e
    const lines = []

    const timeStr = formatDate(new Date(), "full")
    lines.push(`- 现在是${timeStr},请注意时间变化,回答时注意时效性,避免回答过时信息。`)

    if (cfg.aigc?.split_reply) {
      lines.push("- 一句话讲不完就<x>拆成多条发,模仿人类打一句话发一句话的习惯,最多允许一次拆3条。例如: 好的呀<x>那就给你瞧瞧我的本事吧！")
      lines.push("- 注意不要连续使用一种拆法,因为没有人每次都发固定几条消息,所以要按实际所需拆分,不要每次都拆成3条,也不要每次都拆成2条,有时也可以不拆。")
    }
    if (e.isGroup) {
      lines.push("- 群聊最近消息仅作为上下文供你参考,帮助你更好地理解当前对话环境,以便做出更合适的回答。")
    }
    if (!ambient) {
      lines.push("- 如果判断出用户的意图不是与你对话,比如误艾特,或者艾特了你但发言意图不是找你,又或者你认为不用回复或不想回复,则只需输出 OFF 即可,不要做任何其他输出。")
    }
    return `<system_supplement>\n${lines.join("\n")}\n</system_supplement>`
  }

  /** 群聊/私聊信息 */
  async _buildEnvContext() {
    const e = this.e

    if (e.isGroup) {
      let botCard = ""
      try {
        botCard = e.group?.pickMember?.(e.self_id)?.card || ""
      } catch {}
      const botName = botCard || Bot[e.self_id]?.nickname || ""

      const card = e.sender?.card || e.sender?.nickname || ""
      const role = { owner: "群主", admin: "群管理员", member: "群成员" }[e.member?.role] || e.member?.role || "群成员"
      const sex = { male: "男", female: "女", unknown: "未知" }[e.member?.sex] || e.member?.sex || "未知"

      const lines = []
      lines.push(`- 类型: 群聊`)
      lines.push(`- 群名: ${e.group_name || "Unknown"} (ID: ${e.group_id})`)
      lines.push(`- 你的群昵称: ${botName}`)
      lines.push(`- 你的QQ: ${e.self_id}`)
      lines.push(`- 你的头像: https://q.qlogo.cn/g?b=qq&s=0&nk=${e.self_id}`)
      const avatar = e.sender?.getAvatarUrl?.() || e.member?.getAvatarUrl?.() || `https://q.qlogo.cn/g?b=qq&s=0&nk=${e.user_id}`
      lines.push(`- 当前说话人: [${card}](QQ: ${e.user_id}, 性别: ${sex}, 群身份: ${role}, 头像: ${avatar})`)

      const histCount = cfg.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        const history = await this._getGroupHistory(histCount)
        if (history) lines.push(`  <group_history>\n${history}\n  </group_history>`)
      }

      return `<chat_context>\n${lines.join("\n")}\n</chat_context>`
    }

    const name = e.sender?.nickname || "Unknown"
    const avatar = e.sender?.getAvatarUrl?.() || `https://q.qlogo.cn/g?b=qq&s=0&nk=${e.user_id}`
    return `<chat_context>\n- 类型: 私聊\n- 你的QQ: ${e.self_id}\n- 你的头像: https://q.qlogo.cn/g?b=qq&s=0&nk=${e.self_id}\n- 用户: [${name}](QQ: ${e.user_id}, 头像: ${avatar})\n</chat_context>`
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
        const role = { owner: "群主", admin: "群管理员", member: "群成员" }[sender.role] || sender.role || "群成员"
        let time = ""
        if (msg.time) {
          const d = new Date(msg.time * 1000)
          const pad = n => String(n).padStart(2, "0")
          time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        }

        const text = this._extractMsgText(msg)
        if (!text) continue

        lines.push(`  - ${time ? `[${time}] ` : ""}[${name}](QQ: ${qq}, ${role}): ${text}`)
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
        parts.push(`@${this._resolveAtName(seg.qq)}`)
      } else if (seg.type === "image") {
        const url = seg.url || ""
        parts.push(url ? `[图片](${url})` : "[图片]")
      } else if (seg.type === "file") {
        parts.push("[文件]")
      } else if (seg.type === "face") {
        const name = faceName(seg.id)
        parts.push(name ? `[${name}]` : "[表情]")
      } else if (seg.type === "video") {
        const url = seg.url || seg.file || ""
        parts.push(url ? `[视频](${url})` : "[视频]")
      } else if (seg.type === "record" || seg.type === "audio") {
        parts.push("[语音]")
      } else if (seg.type === "reply") {
        parts.push("[引用]")
      } else if (seg.type === "json") {
        const data = typeof seg.data === "string" ? JSON.parse(seg.data) : seg.data || {}
        const meta = data?.meta?.detail_1 || data?.meta?.detail || data
        const title = meta?.title || meta?.desc || ""
        const url = meta?.url || meta?.qqdocurl || ""
        parts.push(title ? `[小程序: ${title}](${url})` : url ? `[分享](${url})` : "[分享]")
      } else if (seg.type === "markdown") {
        parts.push("[Markdown]")
      }
    }
    return parts.join("").trim()
  }

  /** 发送回复：检查语音标识 → 若开启则转语音，否则纯文本 */
  async _sendReply(text, quote = true) {
    try {
      const emo_switch = await Bot.aigc.voice.consume(this.e.user_id)
      if (emo_switch) {
        const audioUrl = await Bot.aigc.voice.tts(text, emo_switch)
        return this.e.reply(segment.record(audioUrl))
      }
    } catch (err) {
      log.error(`语音转换失败，降级为文本: ${err.message}`)
    }
    return this._splitReply(text, quote)
  }

  /** 从 provider 响应构建待持久化的 assistant 消息 */
  _buildAssistantMsg(res) {
    return {
      role: "assistant",
      content: res.content || null,
      ...(res.tool_calls && { tool_calls: res.tool_calls }),
      ...(res.reasoning_content && {
        reasoning_content: res.reasoning_content,
      }),
      ...(res.reasoning_parts && { reasoning_parts: res.reasoning_parts }),
      ...(res.content_parts && { content_parts: res.content_parts }),
    }
  }

  /** 构建 user 消息的公共元数据（时间 + 会话上下文） */
  _userMsgMeta() {
    const meta = {
      time: Date.now(),
      chat_type: this.e.isGroup ? "群聊" : "私聊",
    }
    if (this.e.isGroup) meta.group_name = this.e.group_name || ""
    return meta
  }

  /** 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则发送并退出。
   *  整轮对话在内存中累积，最终回复生成后才原子写入缓存，避免中途死机留下残缺记录。 */
  async _replyLoop(sessionKey, userMsg, images, videos, systemPrompt, signal) {
    const rawHistory = await con().getMessages(this.e.self_id, this.e.user_id)
    for (const m of rawHistory) delete m.videos
    const baseMessages = rawHistory.filter(m => m.role !== "system")
    const systemMsg = { role: "system", content: systemPrompt }
    const pending = []
    let userPushed = false

    const maxRounds = getMaxToolRounds()
    for (let round = 0; round < maxRounds; round++) {
      const messages = [systemMsg, ...baseMessages, ...pending]
      if (!userPushed) {
        const um = { role: "user", content: userMsg }
        if (images) um.images = images
        if (videos) um.videos = videos
        messages.push(um)
      }

      const opts = {}
      if (signal) opts.signal = signal
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
        if (res.content) await this.e.reply(res.content)

        const names = res.tool_calls
          .map(c => c.function?.name)
          .filter(Boolean)
          .join(",")
        log.info(`调用工具: ${names}`)

        if (!userPushed) {
          pending.push({
            role: "user",
            content: userMsg,
            ...this._userMsgMeta(),
            ...(images ? { images } : {}),
            ...(videos ? { videos } : {}),
          })
          userPushed = true
        }
        pending.push(this._buildAssistantMsg(res))

        const ctx = { user_id: this.e.user_id, event: this.e }
        const results = await Promise.all(
          res.tool_calls.map(async tc => {
            try {
              const fnName = tc?.function?.name
              if (!fnName)
                return {
                  name: "unknown",
                  error: "tool_calls missing function.name",
                }
              let args = {}
              try {
                args = JSON.parse(tc?.function?.arguments || "{}")
              } catch {
                /* pass */
              }
              if (!args || typeof args !== "object") args = {}
              return await tools().execute(fnName, args, ctx)
            } catch (err) {
              return {
                name: tc?.function?.name || "unknown",
                error: err?.message || String(err),
              }
            }
          }),
        )
        const lastRound = round === maxRounds - 1
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const callId = res.tool_calls[i]?.id || `call_${i}`
          const payload = "error" in r ? r.error : r.result
          let content, images, videos
          if (payload && typeof payload === "object") {
            if (Array.isArray(payload.images)) {
              images = payload.images
              content = payload.text || "图片获取成功"
            }
            if (Array.isArray(payload.videos)) {
              videos = payload.videos
              content = payload.text || "视频获取成功"
            }
          }
          if (!content) {
            content = typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
          }
          if (lastRound && i === results.length - 1) {
            content += `\n\n[系统提示] 你已达到最大工具调用轮次 (${maxRounds}轮)。请立即基于已获取的所有信息回复用户，不要再调用任何工具！！！如果信息不足，如实说明已掌握的情况即可。`
          }
          pending.push({
            role: "tool",
            content,
            tool_call_id: callId,
            ...(images?.length ? { images } : {}),
            ...(videos?.length ? { videos } : {}),
          })
        }
        continue
      }

      if (res.content) {
        const text = (res.content || "").trim()
        if (!text || /^OFF$/i.test(text)) {
          if (!userPushed) return false
          await con().appendMessages(sessionKey, pending)
          return false
        }

        if (!userPushed) {
          pending.push({
            role: "user",
            content: userMsg,
            ...this._userMsgMeta(),
            ...(images ? { images } : {}),
            ...(videos ? { videos } : {}),
          })
          userPushed = true
        }
        pending.push(this._buildAssistantMsg(res))

        await con().appendMessages(sessionKey, pending)

        if (res.reasoning_content && cfg.aigc?.show_thinking) {
          const thinkingMsg = await common.makeForwardMsg(this.e, [{ type: "text", data: { text: res.reasoning_content } }])
          await this.reply(thinkingMsg, true)
        }

        activeRequests.delete(this.e.user_id)
        return this._sendReply(res.content)
      }

      log.warn(`空响应`)
      return
    }

    // 工具轮次用尽：tool_choice="none" 强制文本回复
    if (!userPushed) {
      pending.push({
        role: "user",
        content: userMsg,
        ...this._userMsgMeta(),
        ...(images ? { images } : {}),
        ...(videos ? { videos } : {}),
      })
      userPushed = true
    }
    const finalMessages = [systemMsg, ...baseMessages, ...pending]
    const finalOpts = {}
    if (signal) finalOpts.signal = signal
    const finalToolDefs = tools().getDefinitions()
    if (finalToolDefs.length) {
      finalOpts.tools = finalToolDefs
      finalOpts.tool_choice = "none"
    }
    const finalReply = await Bot.aigc.provider.chat(finalMessages, finalOpts)

    // 纯文本回复，正常保存并发送
    if (finalReply.content) {
      pending.push(this._buildAssistantMsg(finalReply))
      await con().appendMessages(sessionKey, pending)
      log.warn(`工具轮次超限，降级回复成功`)
      activeRequests.delete(this.e.user_id)
      return this._sendReply(finalReply.content)
    }
    log.error(`全部失败`)
    // return this.reply("请求失败，请稍后再试", true)
    const fallbackMsg = ["脑子彻底转不动了…晚点再试试吧~", "信号完全丢失了，稍等一下再来？", "今天状态不太好，一会儿再找我聊？", "唔…好像卡住了，晚点再试试吧！"][Math.floor(Math.random() * 4)]
    return this.reply(fallbackMsg, true)
  }
}
