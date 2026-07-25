import tools from "./registry.js"

/** 解析用户显示名 */
function resolveName(e, qq) {
  try {
    if (e?.isGroup) {
      const gid = e.group_id
      const ml = Bot.gml?.get(Number(gid)) || Bot.gml?.get(String(gid))
      if (ml) {
        const info = ml.get(Number(qq)) || ml.get(String(qq))
        if (info?.card) return info.card
        if (info?.nickname) return info.nickname
      }
      const m = Bot.pickMember(gid, qq)
      if (m?.card) return m.card
      if (m?.nickname) return m.nickname
    }
  } catch {}
  return String(qq)
}

tools.register({
  name: "recall_user",
  description: "You can use this tool to retrieve the context of your conversations with a specific user. If your interaction with that user involves other people, you can use it to access your conversations with those individuals for reference, helping to bridge the gaps in multi-party discussions.",
  parameters: {
    type: "object",
    properties: {
      user_id: {
        type: "number",
        description: "QQ number of the user whose conversation history to fetch",
      },
    },
    required: ["user_id"],
  },
  execute: async (args, ctx) => {
    const { user_id } = args
    const e = ctx?.event
    if (!e) return "Unable to get context"

    try {
      const msgs = await Bot.aigc.conversation.getMessages(e.self_id, String(user_id), 10)
      if (!msgs.length) return `No conversation history found with user ${user_id}`

      const userName = resolveName(e, user_id)
      const botName = resolveName(e, e.self_id)

      const lines = []
      for (const msg of msgs) {
        if (msg.role === "user") {
          const content = msg.content || ""
          const images = msg.images?.length ? ` [${msg.images.length} image(s) attached]` : ""
          if (!content && !images) continue
          lines.push(`${userName}: ${content}${images}`)
        } else if (msg.role === "assistant" && msg.content) {
          lines.push(`${botName}: ${msg.content}`)
        }
      }

      if (!lines.length) return `No valid content found in conversation with user ${user_id}`

      return `<conversation_history user="${userName}(${user_id})">\n${lines.join("\n")}\n</conversation_history>`
    } catch (err) {
      return `Failed to fetch conversation history: ${err.message}`
    }
  },
})
