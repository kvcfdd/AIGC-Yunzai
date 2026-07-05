import tools from "./registry.js"
import cfg from "../../config/config.js"

tools.register({
  name: "block",
  description: "Add a user to the blacklist. Use when you want to stop interacting with someone, such as harassment or spamming.",
  parameters: {
    type: "object",
    properties: {
      target_qq: { type: "string", description: "QQ number of the user to block" },
    },
    required: ["target_qq"],
  },
  execute: async args => {
    const { target_qq } = args
    if (!target_qq) return "Please provide a valid QQ number"

    const s = String(target_qq)
    const list = (cfg.getAllCfg("aigc").qq_blacklist || []).map(String)
    if (list.includes(s)) return `User ${target_qq} is already blacklisted`
    list.push(s)
    cfg.setConfig("aigc", "qq_blacklist", list)
    return `User ${target_qq} has been added to AIGC blacklist`
  },
})
