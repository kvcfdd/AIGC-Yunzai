import tools from "./registry.js"
import cfg from "../../config/config.js"

function roleName(role) {
  return { owner: "群主", admin: "群管理员", member: "群成员" }[role] || role || "群成员"
}

function sexName(sex) {
  if (!sex) return null
  if (sex === "male" || sex === "男") return "男"
  if (sex === "female" || sex === "女") return "女"
  return sex
}

function buildUserXML(account, isOwner, groupData, groupNote) {
  const lines = []
  if (isOwner) lines.push("身份: bot owner (master)")
  lines.push(`昵称: ${account.nickname || "Unknown"}`)
  const sx = sexName(account.sex)
  if (sx) lines.push(`性别: ${sx}`)
  if (account.age != null) lines.push(`年龄: ${account.age}`)
  if (account.birthday) lines.push(`生日: ${account.birthday}`)
  if (account.qqLevel != null) lines.push(`QQ等级: ${account.qqLevel}`)
  lines.push(`QQ: ${account.qq}`)
  lines.push(`头像: https://q.qlogo.cn/g?b=qq&s=0&nk=${account.qq}`)

  const tags = []
  tags.push("<user_query>")
  tags.push(`  <account>\n    ${lines.join("\n    ")}\n  </account>`)
  if (groupData) {
    const g = []
    if (groupData.card) g.push(`群昵称: ${groupData.card}`)
    if (groupData.title) g.push(`群头衔: ${groupData.title}`)
    g.push(`群身份: ${roleName(groupData.role)}`)
    tags.push(`  <group>\n    ${g.join("\n    ")}\n  </group>`)
  }
  if (groupNote) tags.push(`  <group>${groupNote}</group>`)
  tags.push("</user_query>")
  return tags.join("\n")
}

tools.register({
  name: "query",
  description: "查询 bot owner (master) 或指定 QQ 用户的信息。返回结构化 XML: <account> (是否 bot owner (master) /昵称/性别/年龄/生日/QQ等级/QQ号/头像) 与 <group> (群名片/群头衔/群身份)，用户不在当前群聊时 <group> 显示提示。用于确认正在与谁对话、判断用户是否 bot owner (master) 。内部工具 — 除非用户明确要求，不要直接透露原始数据。",
  parameters: {
    type: "object",
    properties: {
      queryType: {
        type: "string",
        enum: ["master", "member"],
        description: "master=查询 bot owner (master)，member=查询指定用户",
      },
      qq: { type: "number", description: "要查询的用户 QQ，queryType=member 时必填" },
    },
    required: ["queryType"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "<user_query>\n  <error>Cannot get context</error>\n</user_query>"

    const { queryType, qq } = args
    const masters = cfg.master?.[e.self_id] || []

    const targetQQ = queryType === "master" ? masters[0] : qq

    if (!targetQQ) {
      const msg = queryType === "master" ? "No bot owner (master) configured" : "queryType=member requires 'qq' parameter"
      return `<user_query>\n  <error>${msg}</error>\n</user_query>`
    }

    const isOwner = masters.map(String).includes(String(targetQQ))
    const gid = e.isGroup ? e.group_id : null

    // 账号信息
    const account = { qq: targetQQ, nickname: null, sex: null, age: null, birthday: null, qqLevel: null }
    try {
      const friend = Bot.pickFriend(targetQQ)
      if (friend?.getInfo) {
        const f = await friend.getInfo()
        if (f) {
          account.nickname = f.nickname || f.nick || null
          account.sex = f.sex || null
          account.age = f.age ?? null
          if (f.birthday_month > 0 && f.birthday_day > 0) {
            account.birthday = `${f.birthday_month}月${f.birthday_day}日`
          }
          account.qqLevel = f.qqLevel || f.qq_level || null
        }
      }
    } catch {}

    // 群信息
    let groupData = null
    let groupNote = null
    if (gid) {
      try {
        const m = await Bot.pickMember(gid, targetQQ).getInfo()
        if (m) {
          groupData = { card: m.card, title: m.title, role: m.role }
          if (!account.nickname) account.nickname = m.nickname || null
          account.sex = account.sex || m.sex || null
          if (account.age == null) account.age = m.age ?? null
        } else {
          groupNote = isOwner ? "bot owner (master) 不在当前群聊中" : `用户 ${targetQQ} 不在当前群聊中`
        }
      } catch {}
    }

    if (!account.nickname && !groupNote) {
      return `<user_query>\n  <error>User ${targetQQ} not found</error>\n</user_query>`
    }

    return buildUserXML(account, isOwner, groupData, groupNote)
  },
})
