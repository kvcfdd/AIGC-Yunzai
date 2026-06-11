import tools from "./registry.js"
import runtime from "../runtime.js"
import log from "../helpers/log.js"

tools.register({
  name: "block",
  description:
    "Add a user to the blacklist. Use when you want to stop interacting with someone, such as harassment or spamming.",
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

    try {
      const added = await runtime.addBlacklist(target_qq)
      if (!added) return `User ${target_qq} is already blacklisted`
      return `User ${target_qq} has been added to AIGC blacklist`
    } catch (err) {
      log.error(`block 失败: ${err.message}`)
      return `Block failed: ${err.message}`
    }
  },
})
