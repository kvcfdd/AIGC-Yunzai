import cfg from "../../lib/config/config.js"
import log from "../../lib/aigc/helpers/log.js"
import { AigcChatCore, activeRequests, reqKey, registerInjectedChat } from "../../lib/aigc/chat/index.js"

const con = () => Bot.aigc.conversation

const AMBIENT_KEY_PREFIX = "aigc:ambient:cooldown"

/** AIGC 入口：被 @ 且无命令匹配时触发，支持工具调用、历史检索与长期上下文 */
export class AigcFallback extends AigcChatCore {
  constructor() {
    super({
      name: "AIGC",
      dsc: "AIGC 对话",
      event: "message",
      priority: 999999999,
      rule: [
        { reg: /^#关闭aigc$/i, fnc: "aigcOff" },
        { reg: /^#开启aigc$/i, fnc: "aigcOn" },
        { reg: /^#结束对话$/i, fnc: "clearConv" },
        { reg: /^#结束全部对话$/i, fnc: "clearAllConv", permission: "master" },
        { reg: /^[\s\S]+$/, fnc: "aigcChat", log: false },
      ],
    })
  }

  // 裸 @ 是否进入对话
  accept(e) {
    if (!e.msg && e.atBot && cfg.aigc?.bare_at_reply) {
      const res = this.aigcChat()
      return res ? "return" : false
    }
    return false
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

    if (!(await con().hasHistory(this.e.self_id, this.e.user_id))) return this.reply("暂无对话记录", true)

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

  // AIGC 对话主流程

  /** 当前消息是否为无文本的文件消息；是则返回文件名，否则 null。
   *  "裸文件" = 消息仅含文件段，无任何文本内容 */
  _getBareFileName() {
    const segs = this.e.message
    if (!Array.isArray(segs)) return null
    let fileSeg = null
    for (const seg of segs) {
      if (seg.type === "text" && seg.text?.trim()) return null
      if (seg.type === "file" && !fileSeg) fileSeg = seg
    }
    return fileSeg?.name || null
  }

  /** 门控与入口：开关/黑白名单/水群判定 → 交引擎执行对话 */
  async aigcChat() {
    if (cfg.aigc?.enable === false) return false

    // 一次性拦截: 接收文件协议端会将其上报，将其拦下避免触发
    const bareFile = this.e.isPrivate ? this._getBareFileName() : null
    if (bareFile) {
      const fkey = `aigc:file_sent:${this.e.self_id}:${this.e.user_id}:${bareFile}`
      if (await redis.get(fkey)) {
        await redis.del(fkey)
        log.debug(`用户 ${this.e.user_id} 发送裸文件 ${bareFile} 命中，跳过对话`)
        return false
      }
    }

    if (this.e.isPrivate && cfg.aigc?.private_enable === false && !this.e.isMaster) return false

    // 仅真好友私聊触发，协议端会把公众号推送当成私聊上报
    if (this.e.isPrivate && !this.e._injected) {
      const fl = this.e.bot?.fl
      if (fl && !fl.has(this.e.user_id)) return false
    }

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
