import tools from "../tool-registry.js"
import { isMaster } from "../workspace.js"

const ACTIONS = new Set(["kick", "mute", "mute_all", "set_card", "send_notice", "recall"])
const DEFAULT_MUTE_SECONDS = 300
const MAX_MUTE_SECONDS = 30 * 24 * 60 * 60

/** 请求者是否群主/群管理员 */
function isGroupAdmin(event) {
  const role = event?.member?.role || event?.sender?.role
  return !!(event?.member?.is_admin || role === "owner" || role === "admin")
}

/** Bot 是否群主/群管理员 */
async function botIsGroupAdmin(group, selfId) {
  if (group?.is_admin || group?.is_owner) return true
  const member = group?.pickMember?.(selfId)
  if (!member) return false
  try {
    const info = await member.getInfo?.()
    if (info?.role) return info.role === "owner" || info.role === "admin"
  } catch {
    /* 回退到缓存 role */
  }
  return member.role === "owner" || member.role === "admin"
}

function normalizeUsers(raw) {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
  return [...new Set(list.map(value => String(value).trim()).filter(Boolean))]
}

function muteSeconds(raw) {
  let seconds = raw == null ? DEFAULT_MUTE_SECONDS : Math.floor(Number(raw))
  if (!Number.isFinite(seconds)) seconds = DEFAULT_MUTE_SECONDS
  return Math.min(Math.max(seconds, 0), MAX_MUTE_SECONDS)
}

/** 消息是否由请求者或 bot 自己发送 */
async function isOwnMessage(group, messageId, event) {
  if (typeof group?.getMsg !== "function") return false
  try {
    const message = await group.getMsg(messageId)
    const sender = String(message?.sender?.user_id ?? message?.user_id ?? "")
    return !!sender && (sender === String(event.user_id) || sender === String(event.self_id))
  } catch {
    return false
  }
}

tools.register(
  {
    name: "group_admin",
    description: "Manage the current QQ group: kick, mute, mute_all, set_card, send_notice, recall. Admin actions require the sender to be a group admin and the bot to have admin rights; non-admin senders may only target themselves.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        user: { type: "array", items: { type: "string" }, description: "QQ number(s) for kick/mute/set_card." },
        duration: { type: "number", description: "Mute seconds; 0 unmutes." },
        enable: { type: "boolean", description: "mute_all: true/false." },
        card: { type: "string", description: "New card; empty clears." },
        content: { type: "string", description: "Notice text." },
        message_id: { type: "string", description: "Message ID for recall." },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const event = ctx?.event
      if (!event) throw new Error("无法获取对话上下文")
      if (!event.isGroup || !event.group_id) throw new Error("仅在群聊中可用")

      const action = String(args?.action || "")
        .trim()
        .toLowerCase()
      if (!ACTIONS.has(action)) throw new Error(`不支持的操作: ${action}`)

      const group = event.group ?? ctx.bot?.pickGroup?.(event.group_id)
      if (!group) throw new Error(`未找到群 ${event.group_id}`)

      const call = async (name, ...params) => {
        const fn = group[name]
        if (typeof fn !== "function") throw new Error(`当前协议端不支持 ${name}`)
        return fn.apply(group, params)
      }

      const users = normalizeUsers(args?.user)
      const requesterAdmin = isMaster(ctx) || isGroupAdmin(event)

      /** Bot 是否有群管理权限 */
      const requireBotAdmin = async () => {
        if (!(await botIsGroupAdmin(group, event.self_id))) throw new Error("Bot 不是群管理员，无法执行该操作")
      }
      /** 群级管理操作：仅 master/群管理 */
      const requireAdmin = async () => {
        if (!requesterAdmin) throw new Error("权限不足：仅 bot owner 或群管理员可以执行该操作")
        await requireBotAdmin()
      }
      /** 用户级操作：非管理员只能作用于自己 */
      const authorizeUsers = async targets => {
        if (!requesterAdmin && targets.some(id => id !== String(event.user_id))) throw new Error("权限不足：非管理员只能对自己执行该操作")
        await requireBotAdmin()
      }

      switch (action) {
        case "kick": {
          if (!users.length) throw new Error("请提供要踢出的用户 QQ (user)")
          const targets = users.filter(id => id !== String(event.self_id))
          if (!targets.length) throw new Error("不能踢出 bot 自身")
          await authorizeUsers(targets)
          if (typeof group.kickMembers === "function") await call("kickMembers", targets)
          else for (const id of targets) await call("kickMember", id)
          return targets.length === 1 ? `已踢出 ${targets[0]}` : `已批量踢出 ${targets.length} 人: ${targets.join(", ")}`
        }
        case "mute": {
          if (!users.length) throw new Error("请提供要禁言的用户 QQ (user)")
          const seconds = muteSeconds(args?.duration)
          const target = users[0]
          await authorizeUsers([target])
          await call("muteMember", target, seconds)
          return seconds > 0 ? `已将 ${target} 禁言 ${seconds} 秒` : `已解除 ${target} 的禁言`
        }
        case "mute_all": {
          if (typeof args?.enable !== "boolean") throw new Error("请提供 enable (true/false)")
          await requireAdmin()
          await call("muteAll", args.enable)
          return args.enable ? "已开启全员禁言" : "已关闭全员禁言"
        }
        case "set_card": {
          if (!users.length) throw new Error("请提供目标用户 QQ (user)")
          const target = users[0]
          await authorizeUsers([target])
          const card = String(args?.card ?? "")
          await call("setCard", target, card)
          return `已将 ${target} 的群名片设为: ${card || "(已清除)"}`
        }
        case "send_notice": {
          const content = String(args?.content ?? "").trim()
          if (!content) throw new Error("请提供公告内容 (content)")
          await requireAdmin()
          await call("sendNotice", content)
          return "群公告已发送"
        }
        case "recall": {
          const messageId = args?.message_id == null ? "" : String(args.message_id).trim()
          if (!messageId) throw new Error("请提供要撤回的消息 ID (message_id)")
          if (!(await isOwnMessage(group, messageId, event))) await requireAdmin()
          await call("recallMsg", messageId)
          return `已撤回消息 ${messageId}`
        }
      }
    },
  },
  { deferred: true },
)
