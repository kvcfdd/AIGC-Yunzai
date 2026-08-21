import cfg from "../../lib/config/config.js"
import common from "../../lib/common/common.js"
import log from "../../lib/aigc/helpers/log.js"
import { yesterdayStr } from "../../lib/aigc/conversation.js"
import { summarizeOne, dailyMemoryJob } from "../../lib/aigc/helpers/memory.js"
import { WEEKDAYS } from "../../lib/aigc/helpers/time.js"
import { AigcChatCore, activeRequests, reqKey, registerInjectedChat } from "../../lib/aigc/chat/index.js"

const con = () => Bot.aigc.conversation

const AMBIENT_KEY_PREFIX = "aigc:ambient:cooldown"

/** AIGC 入口：被 @ 且无命令匹配时触发，支持工具调用、长期记忆、知识库检索 */
export class AigcFallback extends AigcChatCore {
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
    const req = activeRequests.get(reqKey(this.e))
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
    for (const [key, req] of activeRequests) {
      req.controller.abort()
      log.info(`管理员清除全部对话，已中止用户 ${key.split(":").pop()} 进行中的请求`)
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

    const nodes = entries.map(e => {
      const [y, m, d] = e.date.split("-").map(Number)
      const w = WEEKDAYS[new Date(y, m - 1, d).getDay()]
      return { type: "text", data: { text: `${e.date} ${w}\n${e.summary}` } }
    })

    const fwd = await common.makeForwardMsg(this.e, nodes, "📋 我的记忆")
    return this.reply(fwd)
  }

  // AIGC 对话主流程

  /** 门控与入口：开关/黑白名单/水群判定 → 交引擎执行对话 */
  async aigcChat() {
    if (cfg.aigc?.enable === false) return false
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

      // 前缀过滤（如 "[自动回复]"）。注入消息是系统触发，绕过此检查
      const prefixFilter = cfg.aigc?.prefix_filter
      if (!this.e._injected && prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) return false
    }

    return this._runDialogue(userMsg, isAmbient)
  }
}

// injectMessage 实现 — 注册到 Bot.aigc.injectMessage._impl
// 让后台任务/定时器能通过合成消息唤醒 LLM
registerInjectedChat(AigcFallback)
