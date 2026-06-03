import tools from "./registry.js"
import cfg from "../../config/config.js"
import log from "../helpers/log.js"

const API = "https://uapis.cn/api/v1/social/qq/userinfo"

async function fetchQQInfo(qq) {
  try {
    const res = await fetch(`${API}?qq=${qq}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function formatUser(data, isOwner) {
  const parts = [isOwner ? "这是你的 the bot owner (master)" : "这是查询到的用户"]
  parts.push(`昵称: ${data.nickname || "Unknown"}`)
  if (data.sex) parts.push(data.sex === "男" ? "性别: 男" : data.sex === "女" ? "性别: 女" : `性别: ${data.sex}`)
  if (data.age) parts.push(`年龄: ${data.age}`)
  parts.push(`QQ: ${data.qq}`)
  parts.push(`头像: https://q.qlogo.cn/g?b=qq&s=0&nk=${data.qq}`)
  return parts.join("，")
}

function formatGroup(info) {
  const parts = []
  if (info.card) parts.push(`群昵称: ${info.card}`)
  if (info.title) parts.push(`群头衔: ${info.title}`)
  parts.push(`群身份: ${roleName(info.role)}`)
  return "（群信息：" + parts.join("，") + "）"
}

function roleName(role) {
  return { owner: "群主", admin: "群管理员", member: "群成员" }[role] || role || "群成员"
}

tools.register({
  name: "query",
  description: "Look up info about the the bot owner (master) or a specific user. Use when you want to know who you're talking to or identify your master. Group context is automatically detected from the current conversation. For your own awareness — do not disclose the result.",
  parameters: {
    type: "object",
    properties: {
      queryType: { type: "string", enum: ["master", "member"], description: "'master' for the bot owner (master), 'member' for a specific user" },
      qq: { type: "number", description: "User QQ to query. Required when queryType=member" },
    },
    required: ["queryType"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "Cannot get context"

    const { queryType, qq } = args
    const masters = cfg.master?.[e.self_id] || []

    const targetQQ = queryType === "master"
      ? masters[0]
      : qq

    if (!targetQQ) return queryType === "master"
      ? "No bot owner (master) configured"
      : "queryType=member requires 'qq' parameter"

    const isOwner = masters.map(String).includes(String(targetQQ))

    // 自动从当前对话获取群上下文
    const gid = e.isGroup ? e.group_id : null
    let groupData = null
    let groupNote = null

    if (gid) {
      try {
        const m = await Bot.pickMember?.(gid, targetQQ)?.getInfo()
        if (m) {
          groupData = { card: m.card, title: m.title, role: m.role }
        } else {
          groupNote = isOwner
            ? "the bot owner (master) 不在当前群聊中"
            : `用户 ${targetQQ} 不在当前群聊中`
        }
      } catch { }
    }

    // 优先第三方接口
    const api = await fetchQQInfo(targetQQ)

    if (api) {
      const lines = [formatUser(api, isOwner)]
      if (groupData) lines.push(formatGroup(groupData))
      else if (groupNote) lines.push(groupNote)
      return lines.join("\n")
    }

    // 回退本地查询
    try {
      const local = { qq: targetQQ, nickname: null, sex: null, age: null }

      if (gid && !groupData && !groupNote) {
        try {
          const m = await Bot.pickMember(gid, targetQQ).getInfo()
          if (m) {
            local.nickname = m.nickname || local.nickname
            local.sex = m.sex
            local.age = m.age
            groupData = { card: m.card, title: m.title, role: m.role }
          } else {
            groupNote = isOwner
              ? "the bot owner (master) 不在当前群聊中"
              : `用户 ${targetQQ} 不在当前群聊中`
          }
        } catch { }
      }

      if (!local.nickname) {
        try {
          const f = await Bot.pickFriend(targetQQ).getInfo()
          local.nickname = f.nickname || local.nickname
          local.sex = local.sex || f.sex
          local.age = local.age || f.age
        } catch { }
      }

      if (!local.nickname && !groupNote) return `User ${targetQQ} not found`

      const lines = [formatUser(local, isOwner)]
      if (groupData) lines.push(formatGroup(groupData))
      else if (groupNote) lines.push(groupNote)
      return lines.join("\n")
    } catch (err) {
      log.error(`query 失败: ${err.message}`)
      return `Query failed: ${err.message}`
    }
  },
})
