import tools from "../tool-registry.js"

const STICKER_API = "https://api.yujn.cn/api/chaijun.php"
const COOLDOWN_MS = 30_000
const lastUse = new Map()

function checkCooldown(key) {
  const now = Date.now()
  const prev = lastUse.get(key) || 0
  if (now - prev < COOLDOWN_MS) throw new Error("操作太频繁，稍后再试")
  lastUse.set(key, now)
}

tools.register({
  name: "interact_user",
  description: "Send a light social interaction: like, poke, or a sticker. Defaults to the current user. Use sparingly.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["like", "poke", "sticker"] },
      target_qq: { type: "string", description: "QQ number; defaults to the current user." },
    },
    required: ["action"],
  },
  execute: async (args, ctx) => {
    const event = ctx?.event
    if (!event) throw new Error("无法获取对话上下文")

    const action = String(args?.action || "")
      .trim()
      .toLowerCase()
    if (!["like", "poke", "sticker"].includes(action)) throw new Error(`未知的互动: ${action}`)

    const target = String(args?.target_qq || event.user_id).trim()
    if (!target) throw new Error("无法确定目标用户")
    checkCooldown(`${action}:${target}`)

    if (action === "like") {
      const friend = ctx.bot?.pickFriend?.(target)
      if (typeof friend?.thumbUp !== "function") throw new Error(`未找到用户 ${target} 或协议端不支持点赞`)
      await friend.thumbUp(1)
      return `已给用户 ${target} 点赞`
    }

    if (action === "poke") {
      if (event.isGroup) {
        const member = event.group?.pickMember?.(target) ?? ctx.bot?.pickMember?.(event.group_id, target)
        if (typeof member?.poke !== "function") throw new Error(`未在群内找到用户 ${target} 或协议端不支持戳一戳`)
        await member.poke()
      } else {
        const friend = ctx.bot?.pickFriend?.(target)
        if (typeof friend?.poke !== "function") throw new Error(`未找到用户 ${target} 或协议端不支持戳一戳`)
        await friend.poke()
      }
      return `已戳一戳用户 ${target}`
    }

    const image = globalThis.segment?.image?.(STICKER_API)
    if (!image || typeof event.reply !== "function") throw new Error("当前环境不支持发送表情包")
    await event.reply(image)
    return "表情包已发送"
  },
})
