// 核心: LLM Provider
import provider, { AigcError } from "./llm/index.js"

// 记忆: 长期存储 + 上下文窗口
import memory, { contextRounds } from "./memory/index.js"

// 工具: 内置工具 + MCP + 技能
import tools from "./tools/index.js"
import mcp from "./tools/mcp/manager.js"
import skills from "./tools/skills/index.js"

// 输出: TTS
import voice from "./output/voice.js"

// 核心编排/感知: 单轮编排与触发
import config from "./config.js"
import log from "./helpers/log.js"
import { requestScheduler } from "./core/request-scheduler.js"
import { createDialogue } from "./core/dialogue.js"
import { evaluateTrigger } from "./perception/trigger.js"
import { createInjectedEvent } from "./perception/injected-event.js"

/** 单轮对话服务 — 插件入口与注入入口共用 */
const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: requestScheduler, config })

/**
 * 合成消息注入原语 — 让外部调用方向对话流程注入一条合成用户消息。
 *
 * 调用方式：
 *   Bot.aigc.injectMessage({
 *     self_id: "机器人QQ",
 *     user_id: "目标用户QQ",
 *     group_id: "群号（可选）",
 *     text:    "注入的合成消息文本",
 *   })
 *
 * 这条消息会被推入正常的 AIGC 对话流程，效果等同于用户发了一条消息，
 * 但会跳过 @检测、冷却等用户侧限制。
 */
function injectMessage(params) {
  if (typeof injectMessage._impl !== "function") {
    throw new Error("AIGC 对话服务尚未就绪，injectMessage 不可用")
  }
  return injectMessage._impl(params)
}
injectMessage._impl = async function (params) {
  const event = await createInjectedEvent(params, config)
  if (!event) return

  const decision = await evaluateTrigger({ event, redis: globalThis.redis, scheduler: requestScheduler })
  if (!decision.accepted) return

  return dialogue.run({ event, userMsg: decision.userMsg, isAmbient: decision.isAmbient, reply: event.reply })
}

export { provider, memory, memory as conversation, contextRounds, tools, mcp, skills, voice, requestScheduler, requestScheduler as coordinator, dialogue, config, AigcError, injectMessage }
