import EventListener from "../listener/listener.js"
import cfg from "../config/config.js"

/**
 * 监听连接事件
 */
export default class connectEvent extends EventListener {
  constructor() {
    super({ event: "connect" })
  }

  async execute(e) {
    if (!Bot.uin.includes(e.self_id)) Bot.uin.push(e.self_id)

    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:loginMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    for (const i of cfg.master[e.self_id] || [])
      e.bot.pickFriend(i).sendMsg(`欢迎使用AIGC-Yunzai v${cfg.package.version}`)
  }
}
