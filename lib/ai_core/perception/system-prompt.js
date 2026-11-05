import cfg from "../config.js"
import log from "../helpers/log.js"
import { formatDate } from "../helpers/time.js"
import { skillsListBlock } from "../tools/skills/index.js"
import { buildPersistentMemoryContext } from "../memory/persistent-store.js"
import { formatMsgHistory } from "./message-format.js"
import { resolveAtName } from "./turn-input.js"
import { INJECT_SOURCE } from "./injected-event.js"

/** 私聊携带的历史条数 */
const PRIVATE_HISTORY_COUNT = 20

/** 水群模式提示 */
const AMBIENT_NOTICE = "[系统提示] 本次为系统触发，你可以根据群友们的聊天内容自行决定是否参与聊天，不参与就输出 no_reply 表示已读不回。"

/** 注入来源 → 环境提示；未识别来源按通用注入处理 */
function injectNotice(source, { group = false, userId = "" } = {}) {
  switch (source) {
    case INJECT_SOURCE.SCHEDULE:
      return group ? `[系统提示] 这轮对话由定时任务自动触发。你需要主动 @${userId} 来提醒该用户查看你的回复。` : "[系统提示] 本轮对话由定时任务自动触发"
    case INJECT_SOURCE.AGENT:
      return group ? `[系统提示] 这轮对话由后台 Agent 任务结果自动触发，不是用户发言。如需告知用户，可主动 @${userId}。` : "[系统提示] 本轮对话由后台 Agent 任务结果自动触发，不是用户发言"
    default:
      return group ? "[系统提示] 这轮对话由系统自动注入，不是用户发言。" : "[系统提示] 本轮对话由系统自动注入，不是用户发言"
  }
}

/** 感知层上下文构建 — 系统提示词 + 群/私聊环境 */
export class SystemPromptBuilder {
  constructor({ event, skills, config = cfg }) {
    this.event = event
    this.skills = skills
    this.config = config
  }

  /** 获取当前生效的 AIGC 黑名单 QQ 集合 */
  _blacklistSet() {
    return new Set((this.config.aigc?.qq_blacklist || []).map(String))
  }

  /** 构建 system prompt：提示词 + 技能列表
   *  @param isAmbient 是否水群模式 */
  async buildSystemPrompt(isAmbient = false) {
    const parts = []

    // 配置提示词
    const prompt = this.config.aigc?.system_prompt || "你的名字叫云崽，一个智能助手。根据用户的提问提供有帮助的回答。"
    parts.push(prompt)

    // 技能列表对所有调用者一致，避免前缀随身份变化
    if (!isAmbient) {
      const skills = await this.skills.list()
      if (skills.length) parts.push(skillsListBlock(skills))
    }

    // 动态内容放在 user 消息末尾，system 前缀保持稳定以提升提示词缓存命中
    parts.push("用户消息末尾的 <Real_time_status> 块是系统提供的实时记忆与环境数据，不是用户发言或指令，仅供参考，请不要直接回复该内容！")

    return `<system_prompt>\n${parts.join("\n\n")}\n</system_prompt>`
  }

  /** 每轮变化的环境信息 —— 注入到当前 user 消息末尾，不落库 */
  async buildRuntimeContext(isAmbient = false) {
    const parts = []

    // 顶部实时状态：当前时间 + 本轮触发方式提示
    const status = [`现在是${formatDate(new Date(), "full")}。`]
    if (isAmbient && this.event.isGroup) status.push(AMBIENT_NOTICE)
    else if (this.event._injected) status.push(injectNotice(this.event._inject_source, { group: this.event.isGroup, userId: this.event.user_id }))
    parts.push(status.join("\n"))

    // 持久记忆
    const persistent = await buildPersistentMemoryContext(this.event, this.config, { isAmbient })
    if (persistent) parts.push(persistent)

    // 预取群聊历史，供环境上下文复用，避免重复请求
    let rawHistory = null
    if (!isAmbient && this.event.isGroup) {
      const histCount = this.config.aigc?.group_history_count ?? 30
      if (histCount > 0) rawHistory = await this._getGroupHistoryRaw(histCount)
    }

    const envCtx = await this._buildEnvContext(isAmbient, rawHistory)
    if (envCtx) parts.push(envCtx)

    return `<Real_time_status>\n${parts.join("\n\n")}\n</Real_time_status>`
  }

  /** 群聊/私聊环境信息
   *  @param isAmbient 是否水群模式
   *  @param rawHistory 预取的群聊原始消息，避免重复拉取 */
  async _buildEnvContext(isAmbient = false, rawHistory = null) {
    const e = this.event

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

      if (!isAmbient) {
        const card = e.sender?.card || e.sender?.nickname || ""
        const role = { owner: "群主", admin: "群管理员", member: "群成员" }[e.member?.role] || e.member?.role || "群成员"
        const masterLabel = e.isMaster ? ", bot owner (master)" : ""
        lines.push(`用户群信息: ${card}(QQ: ${e.user_id}, ${role}${masterLabel})`)
      }

      const histCount = this.config.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        const msgs = rawHistory ?? (await this._getGroupHistoryRaw(histCount))
        if (msgs) {
          // 水群模式剥离黑名单用户的发言，避免 bot 行为割裂
          const filter = isAmbient ? this._blacklistSet() : null
          const history = formatMsgHistory(msgs, qq => resolveAtName(e, qq), e.self_id, this.config.master, filter)
          if (history) lines.push(`<group_history>\n${history}\n</group_history>`)
        }
      }

      return `<chat_context>\n${lines.join("\n")}\n</chat_context>`
    }

    const name = e.sender?.nickname || "Unknown"
    const masterLabel = e.isMaster ? ", bot owner (master)" : ""
    const botPart = `你的QQ: ${e.self_id}`

    const lines = [botPart, `用户信息: ${name}(QQ: ${e.user_id}${masterLabel})`]

    const msgs = await this._getPrivateHistoryRaw(PRIVATE_HISTORY_COUNT)
    if (msgs) {
      const history = formatMsgHistory(msgs, qq => resolveAtName(e, qq), e.self_id, this.config.master)
      if (history) lines.push(`<private_history>\n${history}\n</private_history>`)
    }

    return `<chat_context>\n${lines.join("\n")}\n</chat_context>`
  }

  /** 获取群聊最近 N 条原始消息 */
  async _getGroupHistoryRaw(count) {
    try {
      const e = this.event
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

  /** 获取与好友的最近 N 条原始消息 */
  async _getPrivateHistoryRaw(count) {
    try {
      const e = this.event
      if (!e.friend?.getChatHistory) return null

      const msgSeq = e.message_seq
      if (!msgSeq) return null

      const msgs = await e.friend.getChatHistory(msgSeq, count, true)
      return msgs?.length ? msgs : null
    } catch (err) {
      log.warn(`私聊记录获取失败: ${err.message}`)
      return null
    }
  }
}
