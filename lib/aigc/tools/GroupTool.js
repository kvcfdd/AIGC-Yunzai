import tools from "./registry.js"

tools.register({
  name: "group_admin",
  description: `群管理工具，需要 Bot 有群管理权限。

操作:
- kick: 踢出成员。user 传 QQ 号或 QQ 号数组。
- mute: 禁言成员。duration 传秒数，传 0 解禁。
- mute_all: 全员禁言开关。enable 传 true/false。
- set_card: 修改群名片。
- send_notice: 发送群公告。`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["kick", "mute", "mute_all", "set_card", "send_notice"],
        description: "操作类型",
      },
      user: {
        type: "array",
        items: { type: "number" },
        description: "目标用户 QQ 数组 (kick/mute/set_card 可用)。单个用户也传数组，如 [123456]",
      },
      duration: {
        type: "number",
        description: "禁言时长(秒)。mute 用，传 0 解禁。默认 300",
      },
      enable: {
        type: "boolean",
        description: "mute_all 用，true 开启禁言、false 关闭",
      },
      card: { type: "string", description: "新群名片。set_card 用" },
      content: { type: "string", description: "公告内容。send_notice 用" },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "无法获取上下文"

    const { action, user, duration, enable, card, content } = args
    const gid = e.group_id
    if (!gid) return "仅在群聊中可用"

    const group = Bot.pickGroup(gid)
    if (!group) return `未找到群 ${gid}`

    // 验证 bot 权限
    try {
      const botMember = await Bot.pickMember(gid, e.self_id).getInfo()
      if (!botMember) return `无法获取 Bot 在群 ${gid} 的成员信息`
      if (botMember.role !== "admin" && botMember.role !== "owner") {
        return `Bot 在群 ${gid} 不是管理员，无法执行管理操作`
      }
    } catch {
      return `无法验证 Bot 在群 ${gid} 的权限`
    }

    const users = user !== undefined ? (Array.isArray(user) ? user : [user]) : []

    try {
      switch (action) {
        case "kick": {
          if (!users.length) return "请提供要踢出的用户 QQ (user)"
          await group.kickMembers(users)
          return users.length === 1 ? `已踢出 ${users[0]}` : `已批量踢出 ${users.length} 人: ${users.join(", ")}`
        }
        case "mute": {
          if (!users.length) return "请提供目标用户 QQ (user)"
          const sec = typeof duration === "number" ? duration : 300
          const target = users[0]
          if (sec <= 0) {
            await group.muteMember(target, 0)
            return `已解除 ${target} 的禁言`
          }
          await group.muteMember(target, sec)
          return `已将 ${target} 禁言 ${sec} 秒`
        }
        case "mute_all": {
          if (typeof enable !== "boolean") return "请提供 enable (true/false)"
          await group.muteAll(enable)
          return enable ? "已开启全员禁言" : "已关闭全员禁言"
        }
        case "set_card": {
          if (!users.length) return "请提供目标用户 QQ (user)"
          await group.setCard(users[0], card || "")
          return `已将 ${users[0]} 的群名片设为: ${card || "(已清除)"}`
        }
        case "send_notice": {
          if (!content) return "请提供公告内容 (content)"
          await group.sendNotice(content)
          return "群公告已发送"
        }
        default:
          return `不支持的操作: ${action}`
      }
    } catch (err) {
      return `操作 '${action}' 失败: ${err.message}`
    }
  },
})
