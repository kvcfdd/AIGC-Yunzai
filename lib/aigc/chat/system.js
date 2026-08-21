import cfg from "../../config/config.js"
import log from "../helpers/log.js"
import conversation from "../conversation.js"
import { formatDate } from "../helpers/time.js"
import { formatGroupHistory, extractUsersFromHistory } from "../helpers/message.js"
import { pluginSkills, skillsListBlock } from "../skills/index.js"

const con = () => conversation

/** 系统提示词与上下文构建方法 — 经 Object.assign 挂载到 AigcChatCore 原型 */
export const systemMethods = {
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
  },

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

    // 插件技能列表(plugins/*/SKILL.md)，正文经 skill 工具按需查看；水群不注入
    if (!isAmbient) {
      const skills = await pluginSkills.list()
      if (skills.length) parts.push(skillsListBlock(skills))
    }

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
  },

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
      lines.push(`现在是${formatDate(new Date(), "full")}。`)
      lines.push(`群信息: ${e.group_name || "Unknown"}(ID: ${e.group_id})`)
      lines.push(`你的群信息: ${botName}(QQ: ${e.self_id}${botRole ? `, ${botRole}` : ""})`)

      if (isAmbient) {
        lines.push("[系统提示] 本次为水群系统触发，你可以根据群聊中群友们最近的聊天内容自行判断是否参与聊天。")
      } else {
        const card = e.sender?.card || e.sender?.nickname || ""
        const role = { owner: "群主", admin: "群管理员", member: "群成员" }[e.member?.role] || e.member?.role || "群成员"
        const masterLabel = e.isMaster ? ", bot owner (master)" : ""
        lines.push(`用户群信息: ${card}(QQ: ${e.user_id}, ${role}${masterLabel})`)
        // 定时任务/后台任务触发的群聊消息 → 提醒 LLM @目标用户
        if (e._injected) {
          lines.push(`[系统提示] 这轮对话由定时任务/后台任务自动触发。你需要主动 @${e.user_id} 来提醒该用户查看你的回复。`)
        }
      }

      const histCount = cfg.aigc?.group_history_count ?? 30
      if (histCount > 0) {
        const msgs = rawHistory ?? (await this._getGroupHistoryRaw(histCount))
        if (msgs) {
          const history = formatGroupHistory(msgs, this._resolveAtName.bind(this), this.e.self_id, cfg.master)
          if (history) lines.push(`<group_history>\n${history}\n</group_history>`)
        }
      }

      return `<chat_context>\n${lines.join("\n")}\n</chat_context>`
    }

    const name = e.sender?.nickname || "Unknown"
    const masterLabel = e.isMaster ? ", bot owner (master)" : ""
    let injectedNote = ""
    if (e._injected) {
      injectedNote = `\n[系统提示] 本轮对话由定时任务/后台任务自动触发`
    }
    return `<chat_context>\n现在是${formatDate(new Date(), "full")}。\n用户信息: ${name}(QQ: ${e.user_id}${masterLabel})${injectedNote}\n</chat_context>`
  },

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
  },

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
  },

  /** 格式化单个用户的对话记录 */
  _formatUserConversation(userId, msgs) {
    const name = this._resolveAtName(userId)
    const lines = []
    for (const msg of msgs) {
      if (msg.role === "tool") {
        let text = msg.content || ""
        if (typeof text !== "string") text = JSON.stringify(text)
        if (!text) continue
        if (text.length > 50) text = text.slice(0, 50) + "..."
        lines.push(`工具${msg.name ? `(${msg.name})` : ""}: ${text}`)
      } else if (msg.role === "user") {
        lines.push(`${name}: ${msg.content || ""}`)
      } else if (msg.role === "assistant") {
        let text = msg.content || ""
        if (msg.tool_calls?.length && !text) {
          text = `[调用工具: ${msg.tool_calls
            .map(tc => tc.function?.name)
            .filter(Boolean)
            .join(", ")}]`
        }
        if (text) lines.push(`我: ${text}`)
      }
    }
    return lines.length ? `  <user qq="${userId}" name="${name}">\n    ${lines.join("\n    ")}\n  </user>` : ""
  },

  /** 构建群聊关联用户对话上下文：从群聊记录提取涉及用户 → 查缓存 → XML 包裹
   *  @param {Array} rawHistory - 群聊原始消息数组 */
  async _buildGroupUsersContext(rawHistory) {
    if (!rawHistory?.length) return ""

    // 提取群聊记录中涉及的所有用户
    const userIds = extractUsersFromHistory(rawHistory, this.e.self_id)

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
  },
}
