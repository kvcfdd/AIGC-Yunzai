import tools from "./registry.js"

const STICKER_API = "https://api.yujn.cn/api/chaijun.php"

tools.register({
  name: "interact",
  description: "Send a light interaction: like, poke, or a fun sticker. Use when you want to be friendly or liven up the mood.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["like", "poke", "sticker"],
        description: "like=点赞, poke=戳一戳, sticker=柴郡猫表情包",
      },
      target_qq: {
        type: "number",
        description: "Target user QQ. Defaults to current speaker",
      },
    },
    required: ["action"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "Cannot get context"

    const { action, target_qq } = args
    const target = target_qq || e.user_id

    if (action === "like") {
      try {
        const friend = Bot.pickFriend(target)
        if (!friend) return `未找到用户 ${target}`
        await friend.thumbUp?.(1)
        return `已给用户 ${target} 点赞`
      } catch (err) {
        return `点赞失败: ${err.message}`
      }
    }

    if (action === "poke") {
      try {
        if (e.isGroup) {
          const member = Bot.pickMember(e.group_id, target)
          if (!member) return `未在群内找到用户 ${target}`
          await member.poke?.()
        } else {
          const friend = Bot.pickFriend(target)
          if (!friend) return `未找到用户 ${target}`
          await friend.poke?.()
        }
        return `已戳一戳用户 ${target}`
      } catch (err) {
        return `戳一戳失败: ${err.message}`
      }
    }

    if (action === "sticker") {
      await e.reply(segment.image(STICKER_API))
      return "Sticker sent"
    }

    return `Unknown action: ${action}`
  },
})
