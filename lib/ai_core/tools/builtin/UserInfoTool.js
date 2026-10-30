import tools from "../tool-registry.js"

function sexName(sex) {
  if (!sex) return ""
  if (sex === "male" || sex === "男") return "男"
  if (sex === "female" || sex === "女") return "女"
  return String(sex)
}

function roleName(role) {
  return { owner: "群主", admin: "群管理员", member: "群成员" }[role] || role || ""
}

function birthdayText(data) {
  if (data?.birthday) return String(data.birthday)
  const month = Number(data?.birthday_month)
  const day = Number(data?.birthday_day)
  return month > 0 && day > 0 ? `${month}月${day}日` : ""
}

async function safeInfo(target) {
  try {
    return await target?.getInfo?.()
  } catch {
    return null
  }
}

tools.register(
  {
    name: "user_info",
    description: "Look up a QQ account's profile and, in a group, that member's card/title/role. Defaults to the current user; qq may be a QQ number, self/me, bot, or master. Internal context; don't dump raw data unless the user asks.",
    parameters: {
      type: "object",
      properties: {
        qq: { type: "string", description: 'QQ number, or "self"/"me" (current user), "bot", or "master"; defaults to the current user.' },
      },
    },
    execute: async (args, ctx) => {
      const event = ctx?.event
      if (!event) throw new Error("无法获取对话上下文")

      const masters = (ctx.config?.master?.[event.self_id] || []).map(String)
      const raw = String(args?.qq ?? "").trim()
      const alias = raw.toLowerCase()
      const targetQQ = !raw || alias === "self" || alias === "me" ? String(event.user_id) : alias === "bot" ? String(event.self_id) : alias === "master" ? masters[0] : raw
      if (!targetQQ) throw new Error(alias === "master" ? "未配置 bot owner" : "无法确定目标用户")

      const account = { nickname: "", sex: "", age: null, birthday: "", level: "", avatar: "" }
      const isBot = alias === "bot"
      const friend = isBot ? null : ctx.bot?.pickFriend?.(targetQQ)
      const info = friend ? await safeInfo(friend) : null
      if (info) {
        account.nickname = info.nickname || info.nick || ""
        account.sex = sexName(info.sex)
        account.age = info.age ?? null
        account.birthday = birthdayText(info)
        account.level = info.qqLevel ?? info.qq_level ?? ""
      }
      if (isBot) {
        const self = ctx.bot?.[event.self_id]
        account.nickname ||= self?.nickname || self?.name || ""
        account.avatar = self?.avatar || ""
      }

      let memberInfo = null
      let groupNote = ""
      if (event.isGroup && event.group_id) {
        const member = event.group?.pickMember?.(targetQQ) ?? ctx.bot?.pickMember?.(event.group_id, targetQQ)
        memberInfo = member ? await safeInfo(member) : null
        if (memberInfo) {
          account.nickname ||= memberInfo.nickname || memberInfo.name || ""
          account.sex ||= sexName(memberInfo.sex)
          account.age ??= memberInfo.age ?? null
        } else if (targetQQ !== String(event.user_id)) {
          groupNote = `用户 ${targetQQ} 不在当前群`
        }
      }

      if (!account.nickname && !memberInfo && !groupNote) throw new Error(`未找到用户 ${targetQQ}`)

      const lines = [`QQ: ${targetQQ}`]
      if (masters.includes(String(targetQQ))) lines.push("身份: bot owner (master)")
      lines.push(`昵称: ${account.nickname || "Unknown"}`)
      if (account.sex) lines.push(`性别: ${account.sex}`)
      if (account.age != null) lines.push(`年龄: ${account.age}`)
      if (account.birthday) lines.push(`生日: ${account.birthday}`)
      if (account.level !== "") lines.push(`QQ等级: ${account.level}`)
      lines.push(`头像: ${account.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${targetQQ}`}`)
      if (memberInfo) {
        if (memberInfo.card) lines.push(`群名片: ${memberInfo.card}`)
        if (memberInfo.title) lines.push(`群头衔: ${memberInfo.title}`)
        if (memberInfo.role) lines.push(`群身份: ${roleName(memberInfo.role)}`)
      }
      if (groupNote) lines.push(groupNote)
      return lines.join("\n")
    },
  },
  { deferred: true },
)
