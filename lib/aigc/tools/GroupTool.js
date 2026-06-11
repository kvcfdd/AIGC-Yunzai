import tools from "./registry.js"

tools.register({
  name: "group_admin",
  description:
    "Group management: kick, ban, set_admin, set_card, send notices, and more. Before acting on someone else's behalf, verify they have the right permissions. For your own actions, confirm the bot has admin/owner access first.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "kick",
          "kick_batch",
          "ban",
          "unban",
          "set_card",
          "set_admin",
          "set_title",
          "set_name",
          "set_whole_ban",
          "unset_whole_ban",
          "send_notice",
          "quit",
        ],
        description: "Group admin operation to execute",
      },
      group_id: { type: "number", description: "Target group ID. Defaults to current group" },
      user_id: {
        type: "number",
        description:
          "Target user QQ. Required for: kick, ban, unban, set_card, set_admin, set_title",
      },
      user_ids: {
        type: "array",
        items: { type: "number" },
        description: "List of QQ numbers to kick. Required for: kick_batch",
      },
      duration: { type: "number", description: "Mute duration in seconds. Default: 300" },
      new_card: { type: "string", description: "New group card. Required for: set_card" },
      title: { type: "string", description: "Special title text. Required for: set_title" },
      enable: {
        type: "boolean",
        description: "true=set admin, false=remove admin. Required for: set_admin",
      },
      name: { type: "string", description: "New group name. Required for: set_name" },
      content: { type: "string", description: "Announcement content. Required for: send_notice" },
      image: { type: "string", description: "Announcement image URL, optional. For: send_notice" },
      reject_add_request: {
        type: "boolean",
        description: "Reject rejoin after kick. Default: false",
      },
    },
    required: ["action"],
  },
  execute: async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "Cannot get context"

    const {
      action,
      user_id,
      user_ids,
      duration,
      new_card,
      title,
      enable,
      name,
      content,
      image,
      reject_add_request,
      group_id,
    } = args

    const gid = group_id || e.group_id
    if (!gid) return "Not in a group and no group_id specified"

    const group = Bot.pickGroup(gid)
    if (!group) return `Group ${gid} not found`

    const OWNER_ACTIONS = [
      "set_admin",
      "set_title",
      "set_name",
      "set_whole_ban",
      "unset_whole_ban",
      "quit",
    ]

    // 验证 bot 管理权限
    try {
      const botMember = await Bot.pickMember(gid, e.self_id).getInfo()
      if (!botMember) return `Cannot get bot member info in group ${gid}`
      if (OWNER_ACTIONS.includes(action)) {
        if (botMember.role !== "owner") return `Bot must be group owner to execute '${action}'`
      } else {
        if (botMember.role !== "admin" && botMember.role !== "owner")
          return `Bot is not an admin in group ${gid}`
      }
    } catch {
      return `Cannot verify bot permissions in group ${gid}`
    }

    try {
      switch (action) {
        case "kick":
          if (!user_id) return "kick requires 'user_id'"
          await group.kickMember(user_id, !!reject_add_request)
          return `Kicked member ${user_id}`
        case "kick_batch":
          if (!Array.isArray(user_ids) || !user_ids.length) return "kick_batch requires 'user_ids'"
          await group.kickMembers(user_ids, !!reject_add_request)
          return `Batch kicked ${user_ids.length} members: ${user_ids.join(", ")}`
        case "ban":
          if (!user_id) return "ban requires 'user_id'"
          await group.muteMember(user_id, duration || 300)
          return `Muted member ${user_id} for ${duration || 300} seconds`
        case "unban":
          if (!user_id) return "unban requires 'user_id'"
          await group.muteMember(user_id, 0)
          return `Unmuted member ${user_id}`
        case "set_card":
          if (!user_id) return "set_card requires 'user_id'"
          await group.setCard(user_id, new_card || "")
          return `Set group card for member ${user_id}`
        case "set_admin":
          if (!user_id) return "set_admin requires 'user_id'"
          await group.setAdmin(user_id, !!enable)
          return enable ? `Granted admin to ${user_id}` : `Revoked admin from ${user_id}`
        case "set_title":
          if (!user_id) return "set_title requires 'user_id'"
          await group.setTitle(user_id, title ?? "")
          return title
            ? `Granted special title "${title}" to ${user_id}`
            : `Removed special title from ${user_id}`
        case "set_name":
          if (!name) return "set_name requires 'name'"
          await group.setName(name)
          return `Group name changed to: ${name}`
        case "set_whole_ban":
          await group.muteAll(true)
          return "Enabled mute-all"
        case "unset_whole_ban":
          await group.muteAll(false)
          return "Disabled mute-all"
        case "send_notice":
          if (!content) return "send_notice requires 'content'"
          await group.sendNotice(content, image || undefined)
          return "Group announcement sent"
        case "quit":
          await group.quit()
          return `Left group ${gid}`
        default:
          return `Unsupported action: ${action}`
      }
    } catch (err) {
      return `Action '${action}' failed: ${err.message}`
    }
  },
})
