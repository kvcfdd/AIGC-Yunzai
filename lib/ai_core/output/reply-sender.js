import cfg from "../config.js"
import log from "../helpers/log.js"
import common from "../../common/common.js"
import voice from "./voice.js"
import { parseTaggedReply, toMessageSegments } from "./reply-format.js"

/**
 * 输出适配器 — 把结构化回复转换为 QQ 消息并发送。
 *
 * @param {object} opts
 * @param {object} opts.event   当前消息事件
 * @param {Function} opts.reply 发送函数 (msg, quote) => Promise
 * @param {object} [opts.config] 配置对象，默认 cfg
 */
export function createReplySender({ event, reply, config = cfg }) {
  const send = (msg = "", quote = false) => {
    if (event && !event.isGroup) quote = false
    return reply(toMessageSegments(msg, event), quote)
  }

  /** 处理带标签的回复：<reply> 发文本，<voice> 转语音，支持混排多条 */
  async function sendTagged(parts, quote = true) {
    let quoted = false
    for (let i = 0; i < parts.length; i++) {
      const { type, text } = parts[i]
      if (!text) continue
      if (type === "voice") {
        try {
          const vcfg = config.aigc?.voice || {}
          if (vcfg.api_key && vcfg.voice_id) {
            const audioUrl = await voice.tts(text, config)
            await event.reply(segment.record(audioUrl))
          } else {
            const shouldQuote = !quoted && quote
            await send(text, shouldQuote)
            quoted = true
          }
        } catch (err) {
          log.error(`语音转换失败，降级为文本: ${err.message}`)
          const shouldQuote = !quoted && quote
          await send(text, shouldQuote)
          quoted = true
        }
      } else {
        const shouldQuote = !quoted && quote
        await send(text, shouldQuote)
        quoted = true
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, Math.random() * 1000 + 1000))
    }
  }

  /** 以合并转发方式发送本轮过程轨迹（思维链/工具调用/工具结果/中间输出） */
  async function sendTurnTrace(sections) {
    if (!sections?.length) return
    const msg = await common.makeForwardMsg(
      event,
      sections.map(text => ({ type: "text", data: { text } })),
    )
    return reply(msg)
  }

  return { send, sendTagged, sendTurnTrace, parseTaggedReply }
}
