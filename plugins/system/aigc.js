import cfg from "../../lib/config/config.js"
import log from "../../lib/ai_core/helpers/log.js"
import { evaluateTrigger } from "../../lib/ai_core/perception/trigger.js"

/** AIGC 入口：被 @ 且无命令匹配时触发，支持工具调用、历史检索与长期上下文 */
export class AigcFallback extends plugin {
  constructor() {
    super({
      name: "AIGC",
      dsc: "AIGC 对话",
      event: "message",
      priority: 999999999,
      task: { name: "AIGC上下文清理", cron: "0 17 4 * * *", fnc: () => this.pruneContext() },
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
    if (!e.msg && e.atBot && cfg.aigc?.reply_on_bare_at) {
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
    if (Bot.aigc.requestScheduler.abort(this.e)) log.info(`用户 ${this.e.user_id} 结束对话，已中止进行中的请求`)

    const memory = Bot.aigc.memory
    if (!(await memory.hasHistory(this.e.self_id, this.e.user_id))) return this.reply("暂无对话记录", true)

    await memory.clearSession(this.e.self_id, this.e.user_id)
    log.info(`用户 ${this.e.user_id} 清除了对话记录`)
    return this.reply("对话记录已清除", true)
  }

  async clearAllConv() {
    if (!this.e.isMaster) return false

    const keys = Bot.aigc.requestScheduler.abortAll()
    for (const key of keys) log.info(`管理员清除全部对话，已中止用户 ${key.split(":").pop()} 进行中的请求`)

    await Bot.aigc.memory.clearAll()
    log.info("管理员清除了全部用户的对话记录")
    return this.reply("已清除全部用户的对话记录", true)
  }

  /** 定时清理超出保留期的上下文 */
  async pruneContext() {
    const removed = await Bot.aigc.memory.pruneOld(cfg.aigc?.context_retention_days)
    if (removed) log.info(`上下文清理: 已删除 ${removed} 条超期记录`)
  }

  /** 门控与入口：开关/黑白名单/水群判定 → 交对话服务执行 */
  async aigcChat() {
    const decision = await evaluateTrigger({
      event: this.e,
      redis: globalThis.redis,
      scheduler: Bot.aigc.requestScheduler,
    })
    if (!decision.accepted) return false

    return Bot.aigc.dialogue.run({
      event: this.e,
      userMsg: decision.userMsg,
      isAmbient: decision.isAmbient,
      reply: (msg, quote) => this.reply(msg, quote),
    })
  }
}
