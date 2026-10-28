import { getAigc } from "../config.js"
import log from "../helpers/log.js"
import { getUserMessageText } from "./turn-input.js"

/**
 * 感知层触发判定 — 开关/黑白名单/水群概率/前缀过滤。
 *
 * @param {object} opts
 * @param {object} opts.event      QQ 消息事件
 * @param {object} opts.redis      Redis 客户端
 * @param {object} opts.scheduler 请求调度器
 * @param {object} [opts.aigc]     AIGC 配置，默认读取 cfg.aigc
 * @returns {Promise<{accepted: boolean, isAmbient?: boolean, userMsg?: string}>}
 */
export async function evaluateTrigger({ event, redis, scheduler, aigc = getAigc() }) {
  if (aigc?.enable === false) return { accepted: false }

  if (event.isPrivate && aigc?.private_chat_enable === false && !event.isMaster) return { accepted: false }

  // 仅真好友私聊触发，协议端会把公众号推送当成私聊上报
  if (event.isPrivate && !event._injected) {
    const fl = event.bot?.fl
    if (fl && !fl.has(event.user_id)) return { accepted: false }
  }

  // 黑名单检查
  const blacklist = aigc?.qq_blacklist
  if (blacklist?.length) {
    const uid = String(event.user_id)
    for (const qq of blacklist) {
      if (String(qq) === uid) return { accepted: false }
    }
  }

  let isAmbient = false

  if (event.isGroup) {
    const whitelist = aigc?.group_whitelist
    if (whitelist?.length) {
      const gid = String(event.group_id)
      if (!whitelist.some(g => String(g) === gid)) return { accepted: false }
    }

    const gid = String(event.group_id)

    if (event.atBot) {
      if (scheduler.abortAmbient(gid)) log.info(`群 ${gid} 用户 ${event.user_id} @触发，已中止群内水群请求`)
      await redis.set(`aigc:ambient:at_block:${gid}`, "1", { EX: 300 })
    } else {
      const ambient = aigc?.proactive_group_chat
      const probability = Math.min(Math.max(Number(ambient?.probability) || 0, 0), 100)
      if (probability <= 0) return { accepted: false }

      // @对话后的 5 分钟内不插话, 避免群内左脚踩右脚
      if (await redis.get(`aigc:ambient:at_block:${gid}`)) return { accepted: false }

      // 每条群消息按概率触发; 0 表示关闭
      if (Math.random() * 100 >= probability) return { accepted: false }
      log.info(`群 ${gid} 主动插话触发 (概率 ${probability}%)`)

      isAmbient = true
    }
  }

  let userMsg
  if (isAmbient) {
    userMsg = "[水群系统触发]"
  } else {
    userMsg = getUserMessageText(event)
    if (!userMsg) return { accepted: false }

    // 前缀过滤（如 "[自动回复]"）。注入消息是系统触发，绕过此检查
    const prefixFilter = aigc?.prefix_filter
    if (!event._injected && prefixFilter?.length && prefixFilter.some(p => userMsg.startsWith(p))) return { accepted: false }
  }

  return { accepted: true, isAmbient, userMsg }
}
