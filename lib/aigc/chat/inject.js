import cfg from "../../config/config.js"
import log from "../helpers/log.js"

/** 注册 injectMessage 实现到 Bot.aigc.injectMessage._impl
 *  让后台任务/定时器能通过合成消息唤醒 LLM
 *  @param {Function} PluginCtor - 对话入口插件类 */
export function registerInjectedChat(PluginCtor) {
  Bot.aigc.injectMessage._impl = async function (params) {
    const { self_id, user_id, group_id, text } = params

    if (!self_id || !user_id || !text) {
      log.error("injectMessage 参数缺失", params)
      return
    }

    if (!Bot.bots[self_id]) {
      log.error(`injectMessage: Bot ${self_id} 不在线`)
      return
    }

    // 构造最小化合成事件，模仿真实消息事件的结构
    const e = {
      self_id,
      user_id,
      message: [{ type: "text", text }],
      msg: text,
      img: [],
      video: [],
      atBot: true,
      _injected: true,
      ...(group_id ? { group_id, message_type: "group", isGroup: true } : { message_type: "private", isPrivate: true }),
    }

    // 复用 Bot.prepareEvent 填充 bot/friend/group/member/sender/reply
    Bot.prepareEvent(e)

    // prepareEvent 可能拿不到昵称/群名，多重回退补齐
    if (!e.sender) e.sender = { user_id }

    // 回退拿用户昵称: friend → group member → 全局好友列表 → QQ号
    if (!e.sender.nickname || e.sender.nickname === String(user_id)) {
      // 尝试好友列表
      try {
        const friend = Bot.fl?.get(Number(user_id)) || Bot.fl?.get(String(user_id))
        if (friend?.nickname) e.sender.nickname = friend.nickname
      } catch {}
      // 群内尝试取群名片
      if (e.isGroup) {
        try {
          const member = e.group?.pickMember?.(user_id)
          if (member) {
            e.sender.nickname ||= member.nickname || member.name
            e.sender.card = member.card || e.sender.card
          }
        } catch {}
      }
    }

    // 回退拿群名
    if (e.isGroup && !e.group_name) {
      try {
        e.group_name = e.group?.name || e.group?.group_name
      } catch {}
    }

    // 补充 isMaster 标记
    if (e.user_id && cfg.master[e.self_id]?.includes(String(e.user_id))) {
      e.isMaster = true
    }

    // 补充 reply 回退
    if (!e.reply) {
      if (e.group?.sendMsg) e.reply = e.group.sendMsg.bind(e.group)
      else if (e.friend?.sendMsg) e.reply = e.friend.sendMsg.bind(e.friend)
    }

    // 补充 logText
    const senderName = e.sender?.nickname || e.sender?.card || String(user_id)
    const groupLabel = e.isGroup ? `${e.group_name || group_id}, ` : ""
    e.logText = `${logger.cyan(`[${groupLabel}${senderName}(${user_id})]`)}${logger.red(`[${(text || "").slice(0, 50)}]`)}`

    log.info(`注入合成消息 → ${user_id}${group_id ? ` (群:${group_id})` : ""}: ${text.slice(0, 80)}`)

    // 直接创建插件实例并执行对话流程
    const instance = new PluginCtor()
    instance.e = e
    return instance.aigcChat()
  }
}
