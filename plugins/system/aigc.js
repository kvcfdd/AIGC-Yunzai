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
  if (await con().hasMemoryForDate(self_id, user_id, date)) {
    return { ok: true, reason: "已存在记忆，跳过" }
  }

  const key = con().sessionKey(self_id, user_id, date)
  const session = await con()._read(key)
  if (!session?.messages?.length) return { ok: false, reason: "无对话记录" }

  const qa = con().extractQA(session.messages)
  if (!qa) return { ok: false, reason: "无可总结内容" }

  try {
    const ambient = cfg.aigc?.ambient || {}
    const opts = { stateful: false, retry_count: 2 }
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

    const succeeded = new Set()

    // 第一轮
    for (const user of users) {
      const [self_id, user_id] = user.split(":")
      const executed = await userLock(user_id, async () => {
        const result = await summarizeOne(self_id, user_id, targetDate)
        if (!result.ok) {
          failed.push({ user, date: targetDate })
          log.warn(`归档失败 [${user}] (${targetDate}): ${result.reason}`)
        } else {
          succeeded.add(user)
        }
        return true
      })
      if (executed === false) {
        log.info(`每日记忆总结: 用户忙碌 [${user}] (${targetDate})，加入重试队列`)
        failed.push({ user, date: targetDate })
      }
    }

    // 当前日期全部成功 → 清除活跃记录；否则保留待下次 cron 补漏
    if (succeeded.size === users.length) {
      try {
        await con().clearActiveUsersForDate(targetDate)
      } catch (err) {
        log.warn(`清理活跃记录失败 [${targetDate}]: ${err.message}`)
      }
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
        if (result.ok) {
          // 重试成功 → 检查该日期所有活跃用户是否都已生成记忆
          const allUsers = await con().scanUsersForDate(date)
          if (allUsers.length) {
            let allDone = true
            for (const u of allUsers) {
              const [s, uid] = u.split(":")
              if (!(await con().hasMemoryForDate(s, uid, date))) {
                allDone = false
                break
              }
            }
            if (allDone) {
              await con().clearActiveUsersForDate(date)
              log.info(`日期 [${date}] 所有用户归档完成，活跃记录已清理`)
            }
          }
        } else {
          log.warn(`每日记忆总结: 重试仍失败 [${user}] (${date}): ${result.reason}，保留活跃记录待下次 cron 补漏`)
        }
        return true
      })
      if (executed === false) {
        log.warn(`每日记忆总结: 重试时用户 [${user}] (${date}) 仍忙碌，保留活跃记录待下次 cron 补漏`)
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
        { reg: /^#我的记忆$/i, fnc: "myMemory" },
        { reg: /^#清除记忆$/i, fnc: "clearMemory" },
        { reg: /^#清除全部记忆$/i, fnc: "clearAllMemory", permission: "master" },
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

  /** 发送纯文本回复 */
  async _sendReply(text, quote = true) {
    return this.reply(text, quote)
  }

  /** 解析 XML 标签回复 → [{ type: "reply"|"voice", text }]，无标签返回 [] */
  _parseTaggedReply(text) {
    const parts = []
    const re = /<(reply|voice)>(.*?)<\/\1>/gs
    let m
    while ((m = re.exec(text)) !== null) {
      const content = m[2].trim()
      if (content) parts.push({ type: m[1], text: content })
    }
    return parts
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
            const audioUrl = await Bot.aigc.voice.tts(text)
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
    // 终止该用户进行中的请求
    const req = activeRequests.get(this.e.user_id)
    if (req) {
      req.controller.abort()
      log.info(`用户 ${this.e.user_id} 结束对话，已中止进行中的请求`)
    }

    const msgs = await con().getMessages(this.e.self_id, this.e.user_id)
    if (!msgs.length) return this.reply("暂无对话记录", true)

    await con().clearSession(this.e.self_id, this.e.user_id)
    log.info(`用户 ${this.e.user_id} 清除了对话记录`)
    return this.reply("对话记录已清除", true)
  }

  async clearAllConv() {
    if (!this.e.isMaster) return false

    // 终止所有进行中的请求
    for (const [user_id, req] of activeRequests) {
      req.controller.abort()
      log.info(`管理员清除全部对话，已中止用户 ${user_id} 进行中的请求`)
    }

    await con().clearAll()
    log.info("管理员清除了全部用户的对话记录")
    return this.reply("已清除全部用户的对话记录", true)
  }

  /** 清除当前用户的记忆 */
  async clearMemory() {
    const entries = await con().getMemoryEntries(this.e.self_id, this.e.user_id)
    if (!entries?.length) return this.reply("暂无记忆记录", true)

    await con().clearMemory(this.e.self_id, this.e.user_id)
    log.info(`用户 ${this.e.user_id} 清除了记忆`)
    return this.reply(`已清除 ${entries.length} 条记忆`, true)
  }

  /** 清除全部用户的记忆 */
  async clearAllMemory() {
    if (!this.e.isMaster) return false

    await con().clearAllMemories()
    log.info("管理员清除了全部用户的记忆")
    return this.reply("已清除全部用户的记忆", true)
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

  /** 以合并转发形式查看缓存的记忆 */
  async myMemory() {
    const entries = await con().getMemoryEntries(this.e.self_id, this.e.user_id)
    if (!entries?.length) return this.reply("暂无记忆记录", true)

    const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    const nodes = entries.map(e => {
      const [y, m, d] = e.date.split("-").map(Number)
      const w = WEEKDAY[new Date(y, m - 1, d).getDay()]
      return { type: "text", data: { text: `${e.date} ${w}\n${e.summary}` } }
    })

    const fwd = await common.makeForwardMsg(this.e, nodes, "📋 我的记忆")
    return this.reply(fwd)
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
        // if (seg.qq == this.e.self_id) continue
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

    let isAmbient = false

    if (this.e.isGroup) {
      const whitelist = cfg.aigc?.group_whitelist
      if (whitelist?.length) {
        const gid = String(this.e.group_id)
        if (!whitelist.some(g => String(g) === gid)) return false
      }

      const gid = String(this.e.group_id)

      if (this.e.atBot) {
        for (const [, req] of activeRequests) {
          if (req.isAmbient && req.group_id === gid) {
            req.controller.abort()
            log.info(`群 ${gid} 用户 ${this.e.user_id} @触发，已中止群内水群请求`)
            break
          }
        }
        await redis.set(`aigc:ambient:at_block:${gid}`, "1", { EX: 300 })
      } else {
        const ambient = cfg.aigc?.ambient
        if (!ambient?.enable) return false

        // @对话后的 5 分钟冷却, 避免群内左脚踩右脚
        if (await redis.get(`aigc:ambient:at_block:${gid}`)) return false

        const cooldownKey = `${AMBIENT_KEY_PREFIX}:${gid}`
        const existing = await redis.get(cooldownKey)
        if (existing) {
          const remain = await redis.ttl(cooldownKey)
          log.debug(`群 ${gid} 主动插话冷却中 (${remain}s)`)
          return false
        }

        const cooldownMin = (ambient.cooldown_min ?? 10) * 60
        const cooldownMax = (ambient.cooldown_max ?? 20) * 60
        const cooldown = cooldownMin + Math.floor(Math.random() * (cooldownMax - cooldownMin + 1))
        await redis.set(cooldownKey, "1", { EX: cooldown })
        log.info(`群 ${gid} 主动插话触发`)

        isAmbient = true
      }
    }

    let userMsg
    if (isAmbient) {
      userMsg = "[水群系统触发]"
    } else {
      userMsg = this._getUserMsg()
      if (!userMsg) return false

      // 前缀过滤（如 "[自动回复]"）
      const prefixFilter = cfg.aigc?.prefix_filter
      if (prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) return false
    }

    // 请求合并：上一轮未完成时取消旧请求，合并消息/图片/视频后重发
    let finalMsg = userMsg
    let finalImg = this.e.img || []
    let finalVideo = this.e.video || []
    const existing = activeRequests.get(this.e.user_id)
    if (existing) {
      existing.controller.abort()
      if (existing.isAmbient) {
        log.info(`用户 ${this.e.user_id} 切换到at对话`)
      } else {
        finalMsg = existing.pendingMsg ? existing.pendingMsg + "\n" + userMsg : userMsg
        if (existing.pendingImg?.length) {
          finalImg = [...existing.pendingImg, ...finalImg]
        }
        if (existing.pendingVideo?.length) {
          finalVideo = [...existing.pendingVideo, ...finalVideo]
        }
      }
    }
    const controller = new AbortController()
    activeRequests.set(this.e.user_id, { controller, isAmbient, pendingMsg: finalMsg, pendingImg: finalImg, pendingVideo: finalVideo, group_id: this.e.isGroup ? String(this.e.group_id) : null })

    const key = con().sessionKey(this.e.self_id, this.e.user_id)
    // 主动插话不落盘，不计入当日活跃用户
    if (!isAmbient) await con().addActiveUser(dateStr(), this.e.self_id, this.e.user_id)

    const label = isAmbient ? "主动插话" : "对话"
    log.info(`用户 ${this.e.user_id} 发起${label}`)

    // 分流模型，影响模型族条件行为
    const effectiveModel = isAmbient && cfg.aigc?.ambient?.model ? cfg.aigc.ambient.model : cfg.aigc?.gemini?.model || ""

    try {
      const systemPrompt = await this._buildSystem(finalMsg, effectiveModel, isAmbient)
      const images = await Bot.aigc.provider.resolveImages(finalImg)
      const removeAudio = /^gemma/i.test(effectiveModel)
      const videos = await Bot.aigc.provider.resolveVideo(finalVideo, removeAudio, controller.signal)
      await this._replyLoop(key, finalMsg, images, videos, systemPrompt, controller.signal, isAmbient)
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`用户 ${this.e.user_id} 打断`)
        return false
      }
      log.error(`${label}异常: ${err.message}`)
      if (!isAmbient) await this.reply("我有些累了，请让我休息一会儿", true)
    } finally {
      if (activeRequests.get(this.e.user_id)?.controller === controller) {
        activeRequests.delete(this.e.user_id)
      }
    }
  }

  /** 构建 system prompt：提示词 + 记忆 + 环境
   *  @param effectiveModel 实际生效模型，用于模型族条件判断
   *  @param isAmbient 是否水群模式 */
  async _buildSystem(userMsg, effectiveModel = "", isAmbient = false) {
    const parts = []

    // Gemma 4 系列：在 System Prompt 最前面自动注入 <|think|> token 以激活深度思考模式
    const model = effectiveModel || cfg.aigc?.gemini?.model || ""
    if (/^gemma/i.test(model)) {
      parts.push("<|think|>")
    }

    // 配置提示词
    const prompt = cfg.aigc?.system_prompt || "你的名字叫云崽，一个智能助手。根据用户的提问提供有帮助的回答。"
    parts.push(prompt)
    const supplement = this._buildSupplement()
    if (supplement) parts.push(supplement)

    // 长期记忆
    if (!isAmbient) {
      const memories = await con().getMemories(this.e.self_id, this.e.user_id)
      if (memories) parts.push(`<user_memories>\n${memories}\n</user_memories>`)
    }

    // 从群聊记录提取涉及用户 → 查缓存 → 注入提示词
    // 与 _buildEnvContext 共享一次群聊历史拉取，避免重复请求
    let rawHistory = null
    if (!isAmbient && this.e.isGroup) {
      const histCount = cfg.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        rawHistory = await this._getGroupHistoryRaw(histCount)
      }
    }
    if (rawHistory) {
      const groupUsersCtx = await this._buildGroupUsersContext(rawHistory)
      if (groupUsersCtx) parts.push(groupUsersCtx)
    }

    // 对话环境
    const envCtx = await this._buildEnvContext(isAmbient, rawHistory)
    if (envCtx) parts.push(envCtx)

    return parts.join("\n")
  }

  /** 系统补充信息 */
  _buildSupplement() {
    const lines = []

    const timeStr = formatDate(new Date(), "full")
    lines.push(`现在是${timeStr}。`)
    lines.push("如果不需要回复,只需要输出 no_reply 即可,不要输出多余内容,包括标点符号和空格。")
    return lines.join("\n")
  }

  /** 群聊/私聊环境信息
   *  @param isAmbient 是否水群模式
   *  @param rawHistory 预取的群聊原始消息，避免重复拉取 */
  async _buildEnvContext(isAmbient = false, rawHistory = null) {
    const e = this.e

    if (e.isGroup) {
      let botCard = ""
      try {
        botCard = e.group?.pickMember?.(e.self_id)?.card || ""
      } catch {}
      const botName = botCard || Bot[e.self_id]?.nickname || ""
      const botRole = (() => {
        try {
          const m = e.group?.pickMember?.(e.self_id)
          return { owner: "群主", admin: "群管理员", member: "群成员" }[m?.role] || ""
        } catch {
          return ""
        }
      })()

      const lines = []
      lines.push(`群信息: ${e.group_name || "Unknown"}(ID: ${e.group_id})`)
      lines.push(`你的群信息: ${botName}(QQ: ${e.self_id}${botRole ? `, ${botRole}` : ""})`)

      if (isAmbient) {
        lines.push("[系统提示] 本次为水群系统触发，请根据群聊中群友们最近的聊天内容自行判断是否参与水群。如果决定参与，请确保回复自然融入；如不想参与，输出 no_reply 即可；如果想参与但不知道说啥可以发个表情包后再输出 no_reply")
      } else {
        const card = e.sender?.card || e.sender?.nickname || ""
        const role = { owner: "群主", admin: "群管理员", member: "群成员" }[e.member?.role] || e.member?.role || "群成员"
        const masterLabel = e.isMaster ? ", bot owner (master)" : ""
        lines.push(`用户群信息: ${card}(QQ: ${e.user_id}, ${role}${masterLabel})`)
      }

      const histCount = cfg.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        const msgs = rawHistory ?? (await this._getGroupHistoryRaw(histCount))
        if (msgs) {
          const history = this._formatGroupHistory(msgs)
          if (history) lines.push(`<group_history>\n${history}\n</group_history>`)
        }
      }

      return `<chat_context>\n${lines.join("\n")}\n</chat_context>`
    }

    const name = e.sender?.nickname || "Unknown"
    const masterLabel = e.isMaster ? ", bot owner (master)" : ""
    return `<chat_context>\n用户信息: ${name}(QQ: ${e.user_id}${masterLabel})\n</chat_context>`
  }

  /** 格式化群聊历史消息时间 */
  _formatHistoryTime(timestamp) {
    if (!timestamp) return ""
    const now = new Date()
    const msgTime = new Date(timestamp * 1000)
    const pad = n => String(n).padStart(2, "0")

    const today = dateStr(now)
    const msgDate = dateStr(msgTime)

    if (msgDate === today) {
      return `${pad(msgTime.getHours())}:${pad(msgTime.getMinutes())}`
    }

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (msgDate === dateStr(yesterday)) {
      return `昨天${pad(msgTime.getHours())}:${pad(msgTime.getMinutes())}`
    }

    return "一天前"
  }

  /** 获取群聊最近 N 条原始消息 */
  async _getGroupHistoryRaw(count) {
    try {
      const e = this.e
      if (!e.group?.getChatHistory) return null

      const msgSeq = e.message_seq
      if (!msgSeq) return null

      const msgs = await e.group.getChatHistory(msgSeq, count, true)
      return msgs?.length ? msgs : null
    } catch (err) {
      log.warn(`群聊记录获取失败: ${err.message}`)
      return null
    }
  }

  /** 将原始群聊消息格式化为文本行 */
  _formatGroupHistory(msgs) {
    const lines = []
    for (const msg of msgs) {
      const sender = msg.sender || {}
      const name = sender.card || sender.nickname || "Unknown"
      const qq = sender.user_id || "?"
      const role = { owner: "群主", admin: "群管理员" }[sender.role] || ""
      const isMaster = cfg.master[this.e.self_id]?.includes(String(qq))
      const masterLabel = isMaster ? ", bot owner (master)" : ""

      const text = this._extractMsgText(msg)
      if (!text) continue

      const timeStr = this._formatHistoryTime(msg.time)
      const timePart = timeStr ? `[${timeStr}] ` : ""

      lines.push(`${timePart}[${name}](QQ: ${qq}${role ? `, ${role}` : ""}${masterLabel}): ${text}`)
    }

    return lines.length ? lines.join("\n") : null
  }

  /** 获取群聊最近 N 条消息 */
  async _getGroupHistory(count) {
    const msgs = await this._getGroupHistoryRaw(count)
    if (!msgs) return null
    return this._formatGroupHistory(msgs)
  }

  /** 从群聊原始消息中提取所有发送者 ID */
  _extractUsersFromHistory(rawMsgs) {
    const userIds = new Set()
    for (const msg of rawMsgs) {
      const senderId = msg.sender?.user_id
      if (senderId && String(senderId) !== String(this.e.self_id)) {
        userIds.add(String(senderId))
      }
    }
    return userIds
  }

  /** 获取当前触发消息中 @ 的其他用户 */
  _getCurrentAtTargets() {
    const targets = new Set()
    const segs = this.e.message
    if (Array.isArray(segs)) {
      for (const seg of segs) {
        if (seg.type === "at" && seg.qq !== "all" && String(seg.qq) !== String(this.e.self_id)) {
          targets.add(String(seg.qq))
        }
      }
    }
    return targets
  }

  /** 格式化单个用户的对话记录 */
  _formatUserConversation(userId, msgs) {
    const name = this._resolveAtName(userId)
    const lines = []
    for (const msg of msgs) {
      if (msg.role === "user") {
        lines.push(`${name}: ${msg.content || ""}`)
      } else if (msg.role === "assistant" && msg.content) {
        lines.push(`我: ${msg.content}`)
      }
    }
    return lines.length ? `  <user qq="${userId}" name="${name}">\n    ${lines.join("\n    ")}\n  </user>` : ""
  }

  /** 构建群聊关联用户对话上下文：从群聊记录提取涉及用户 → 查缓存 → XML 包裹
   *  @param {Array} rawHistory - 群聊原始消息数组 */
  async _buildGroupUsersContext(rawHistory) {
    if (!rawHistory?.length) return ""

    // 提取群聊记录中涉及的所有用户
    const userIds = this._extractUsersFromHistory(rawHistory)

    // 追加当前消息中 @ 的用户
    const atTargets = this._getCurrentAtTargets()
    for (const qq of atTargets) userIds.add(qq)

    // 去掉触发对话的用户自身
    if (this.e.user_id) userIds.delete(String(this.e.user_id))

    if (!userIds.size) return ""

    // 逐个用户查缓存、格式化
    const userParts = []
    for (const userId of userIds) {
      const msgs = await con().getMessages(this.e.self_id, userId, 3)
      if (!msgs?.length) continue

      const formatted = this._formatUserConversation(userId, msgs)
      if (formatted) userParts.push(formatted)
    }

    if (!userParts.length) return ""
    return `<group_users_context>\n${userParts.join("\n")}\n</group_users_context>`
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
        // } else if (seg.type === "reply") {
        //   parts.push("[引用]")
      } else if (seg.type === "json") {
        const data = typeof seg.data === "string" ? JSON.parse(seg.data) : seg.data || {}
        const meta = data?.meta?.detail_1 || data?.meta?.detail || data
        const title = meta?.title || meta?.desc || ""
        const url = meta?.url || meta?.qqdocurl || ""
        parts.push(title ? `[小程序: ${title}](${url})` : url ? `[分享](${url})` : "[分享]")
      } else if (seg.type === "markdown") {
        parts.push("[Markdown]")
      } else if (seg.type === "forward") {
        parts.push("[合并转发]")
      }
    }
    return parts.join("").trim()
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

  /** 清理临时标记/过期视频后原子落盘本轮对话，并更新交互 ID
   *  isAmbient 为 true 时直接不落盘 */
  async _persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient = false) {
    if (isAmbient) return
    for (const m of localPending) {
      delete m._sent
      if (m.videos?.length) m.content = (m.content || "").replace(/\[视频\]/g, "[视频已过期]")
      delete m.videos
    }
    await con().appendMessages(sessionKey, localPending)
    if (stateful && prevIactId) await con().setInteractionId(this.e.self_id, this.e.user_id, prevIactId)
  }

  /** 工具调用循环：LLM 回复 → tool_calls 则执行并回传 → 文本则发送并退出。
   *  采用 "API 增量请求，本地全量累积" 架构：
   *  - localPending[]  最终原子写入 LevelDB 的完整对话记录
   *  - apiMessages[]   每轮实际发送给 API 的消息
   *  有状态模式：通过 previous_interaction_id 让服务端管理上下文。
   *  主动插话：固定无状态 + ambient.model 分流，可用工具/记忆/上下文，但整轮不落盘。 */
  async _replyLoop(sessionKey, userMsg, images, videos, systemPrompt, signal, isAmbient = false) {
    const stateful = isAmbient ? false : (cfg.aigc?.gemini?.stateful ?? true)
    const ambientModel = (isAmbient && cfg.aigc?.ambient?.model) || undefined
    const replyQuote = !isAmbient // 插话不引用，at 对话引用
    const rawHistory = isAmbient ? [] : await con().getMessages(this.e.self_id, this.e.user_id)
    const baseMessages = rawHistory.filter(m => m.role !== "system")
    const systemMsg = { role: "system", content: systemPrompt }

    // 本地全量记录 — 本方法结束时原子写入 LevelDB
    const localPending = []

    // 用户消息始终排在本地记录首位
    const firstUserMsg = {
      role: "user",
      content: userMsg,
      ...this._userMsgMeta(),
      ...(images ? { images } : {}),
      ...(videos ? { videos } : {}),
    }
    localPending.push(firstUserMsg)

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
        apiMessages = stateful && prevIactId ? [systemMsg, firstUserMsg] : [systemMsg, ...baseMessages, firstUserMsg]
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
        tools: tools().getDefinitions(),
        tool_choice: "auto",
      }
      if (ambientModel) opts.model = ambientModel
      if (stateful && prevIactId) {
        opts.previous_interaction_id = prevIactId
      }

      let res
      try {
        res = await Bot.aigc.provider.chat(apiMessages, opts)
      } catch (err) {
        // 有状态模式下 interaction_id 过期 → 清理缓存，带完整历史降级重试
        if (err?.code === "SESSION_EXPIRED" && stateful && prevIactId) {
          log.warn(`Interaction ID 过期，清理本地缓存并使用全量历史重试`)
          await con().clearInteractionId(this.e.self_id, this.e.user_id)
          prevIactId = null
          delete opts.previous_interaction_id
          apiMessages = round === 0 ? [systemMsg, ...baseMessages, firstUserMsg] : [systemMsg, ...baseMessages, ...localPending]
          res = await Bot.aigc.provider.chat(apiMessages, opts)
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
        return this.reply("内容被安全策略拦截", true)
      }

      const assistantMsg = this._buildAssistantMsg(res)
      localPending.push(assistantMsg)

      // 工具调用
      if (res.tool_calls?.length) {
        if (res.content) await this._sendReply(res.content, false)

        const names = res.tool_calls
          .map(c => c.function?.name)
          .filter(Boolean)
          .join(",")
        log.info(`调用工具: ${names}`)

        const ctx = { user_id: this.e.user_id, event: this.e, signal }
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

        const lastRound = round === maxRounds - 1
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const callId = res.tool_calls[i]?.id || `call_${i}`
          const callSig = res.tool_calls[i]?.signature || null
          const payload = "error" in r ? r.error : r.result
          let tContent, tImages, tVideos
          if (payload && typeof payload === "object") {
            if (Array.isArray(payload.images)) {
              tImages = payload.images
              tContent = payload.text || "图片获取成功"
            }
            if (Array.isArray(payload.videos)) {
              tVideos = payload.videos
              tContent = payload.text || "视频获取成功"
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
            ...(tVideos?.length ? { videos: tVideos } : {}),
          })
        }
        continue
      }

      // 文本回复
      if (res.content) {
        const text = (res.content || "").trim()

        // no_reply: 不发送回复，但完整落盘保留对话结构
        if (!text || /^no_reply$/i.test(text)) {
          await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)
          return false
        }

        // 解析 XML 标签
        const taggedParts = this._parseTaggedReply(text)

        // 落盘
        await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)

        // 期间被新请求打断→ 不再发送本次回复
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

        if (res.reasoning_content && cfg.aigc?.show_thinking) {
          const thinkingMsg = await common.makeForwardMsg(this.e, [{ type: "text", data: { text: res.reasoning_content } }])
          await this.reply(thinkingMsg, true)
        }

        activeRequests.delete(this.e.user_id)
        return taggedParts.length ? this._sendTaggedReply(taggedParts, replyQuote) : this._sendReply(res.content, replyQuote)
      }

      log.warn(`空响应`)
      return
    }

    // 工具轮次用尽：tool_choice="none" 强制文本回复
    const unsentTools = localPending.filter(m => m.role === "tool" && !m._sent)
    const finalMessages = stateful && prevIactId ? [systemMsg, ...unsentTools] : [systemMsg, ...baseMessages, ...localPending]
    for (const m of unsentTools) m._sent = true

    const finalOpts = { signal, stateful, tool_choice: "none" }
    if (ambientModel) finalOpts.model = ambientModel
    if (stateful && prevIactId) {
      finalOpts.previous_interaction_id = prevIactId
    }
    const finalToolDefs = tools().getDefinitions()
    if (finalToolDefs.length) finalOpts.tools = finalToolDefs

    const finalReply = await Bot.aigc.provider.chat(finalMessages, finalOpts)

    if (stateful && finalReply.interaction_id) {
      prevIactId = finalReply.interaction_id
    }

    if (finalReply.content) {
      const finalText = (finalReply.content || "").trim()

      // no_reply: 不发送回复，但完整落盘
      if (!finalText || /^no_reply$/i.test(finalText)) {
        await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)
        return false
      }

      const taggedParts = this._parseTaggedReply(finalText)
      localPending.push(this._buildAssistantMsg(finalReply))
      await this._persistRound(sessionKey, localPending, stateful, prevIactId, isAmbient)
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      log.warn(`工具轮次超限，降级回复成功`)
      activeRequests.delete(this.e.user_id)
      return taggedParts.length ? this._sendTaggedReply(taggedParts, replyQuote) : this._sendReply(finalReply.content, replyQuote)
    }
    log.error(`全部失败`)
    if (isAmbient) return false
    return this.reply("请求失败", true)
  }
}
