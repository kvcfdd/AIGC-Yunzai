import tools from "../tool-registry.js"
import { xmlEscape } from "../../helpers/xml.js"

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

tools.register({
  name: "user_info",
  description: "查询 bot_owner 或指定 QQ 用户的资料与群成员信息",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["bot_owner", "user"], description: "bot_owner=查 bot_owner，user=查指定 QQ 用户" },
      qq: { type: "string", description: "QQ号，type=user 时填写" },
    },
    required: ["type"],
  },
  execute: async (args, ctx) => {
    const event = ctx?.event
    if (!event) throw new Error("无法获取对话上下文")

    const type = String(args?.type ?? "")
      .trim()
      .toLowerCase()
    if (type !== "bot_owner" && type !== "user") throw new Error("type 必须是 bot_owner 或 user")

    const masters = (ctx.config?.master?.[event.self_id] || []).map(String)
    let targetQQ
    if (type === "bot_owner") {
      targetQQ = masters[0]
      if (!targetQQ) throw new Error("未配置 bot_owner")
    } else {
      targetQQ = String(args?.qq ?? "").trim()
      if (!targetQQ) throw new Error("查用户时 qq 必填")
    }

    const account = { nickname: "", sex: "", age: null, birthday: "", level: "", avatar: "" }
    const friend = ctx.bot?.pickFriend?.(targetQQ)
    const info = friend ? await safeInfo(friend) : null
    if (info) {
      account.nickname = info.nickname || info.nick || ""
      account.sex = sexName(info.sex)
      account.age = info.age ?? null
      account.birthday = birthdayText(info)
      account.level = info.qqLevel ?? info.qq_level ?? ""
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
      } else {
        groupNote = `用户 ${targetQQ} 不在当前群`
      }
    }

    if (!account.nickname && !memberInfo && !groupNote) throw new Error(`未找到用户 ${targetQQ}`)

    const lines = ["<user_info>"]
    lines.push(`  <qq>${xmlEscape(targetQQ)}</qq>`)
    if (masters.includes(String(targetQQ))) lines.push("  <identity>bot_owner</identity>")
    lines.push(`  <nickname>${xmlEscape(account.nickname || "Unknown")}</nickname>`)
    if (account.sex) lines.push(`  <sex>${xmlEscape(account.sex)}</sex>`)
    if (account.age != null) lines.push(`  <age>${xmlEscape(account.age)}</age>`)
    if (account.birthday) lines.push(`  <birthday>${xmlEscape(account.birthday)}</birthday>`)
    if (account.level !== "") lines.push(`  <qq_level>${xmlEscape(account.level)}</qq_level>`)
    lines.push(`  <avatar>${xmlEscape(account.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${targetQQ}`)}</avatar>`)
    if (memberInfo) {
      const group = []
      if (memberInfo.card) group.push(`    <card>${xmlEscape(memberInfo.card)}</card>`)
      if (memberInfo.title) group.push(`    <title>${xmlEscape(memberInfo.title)}</title>`)
      if (memberInfo.role) group.push(`    <role>${xmlEscape(roleName(memberInfo.role))}</role>`)
      lines.push(...(group.length ? ["  <group_member>", ...group, "  </group_member>"] : ["  <group_member/>"]))
    }
    if (groupNote) lines.push(`  <note>${xmlEscape(groupNote)}</note>`)
    lines.push("</user_info>")
    return lines.join("\n")
  },
})
