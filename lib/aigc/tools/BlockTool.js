import tools from "./registry.js"
import cfg from "../../config/config.js"

tools.register({
  name: "block",
  description: "Add or remove a user from the blacklist. Block to stop interacting, unblock to restore.",
  parameters: {
    type: "object",
    properties: {
      target_qq: { type: "string", description: "QQ number of the user" },
      action: {
        type: "string",
        enum: ["block", "unblock"],
        description: "block=拉黑, unblock=解除拉黑，默认 block",
      },
    },
    required: ["target_qq"],
  },
  execute: async (args, ctx) => {
    const { target_qq, action = "block" } = args
    if (!target_qq) return "Please provide a valid QQ number"

    const s = String(target_qq)

    const e = ctx?.event
    const isSelf = e && String(e.user_id) === s
    if (!e?.isMaster && !isSelf) return "只有主人才能操作其他用户的黑名单"
    const list = (cfg.getAllCfg("aigc").qq_blacklist || []).map(String)

    if (action === "unblock") {
      const idx = list.indexOf(s)
      if (idx === -1) return `User ${target_qq} is not in the blacklist`
      list.splice(idx, 1)
      cfg.setConfig("aigc", "qq_blacklist", list)
      return `User ${target_qq} has been removed from AIGC blacklist`
    }

    if (list.includes(s)) return `User ${target_qq} is already blacklisted`
    list.push(s)
    cfg.setConfig("aigc", "qq_blacklist", list)
    return `User ${target_qq} has been added to AIGC blacklist`
  },
})
