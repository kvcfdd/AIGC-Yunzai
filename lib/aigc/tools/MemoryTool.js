import tools from "./registry.js"
import memory from "../memory.js"

const LIMIT = 30

tools.register({
  name: "memory",
  description: `Manage persistent long-term memory for the current user. Max ${LIMIT} entries per user.
  - WHAT TO SAVE: Only save core, static personal facts worth remembering long-term (e.g., names, birthdays, jobs, relationship status, pets, static preferences, hobbies, or major life events).
  - WHAT TO IGNORE: Absolutely DO NOT save fleeting emotions, casual chat details, temporary states, greetings, or meta-conversation details (e.g., do not save "user said hi", "user is eating pizza today", "user feels sad right now").
  - OVERWRITE LOGIC: To update/correct an existing memory, simply "save" with the same "key" to overwrite the old value. You DO NOT need to delete it first.`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "delete"],
        description:
          "'save' to remember a new fact or update/overwrite an existing one. 'delete' to permanently forget a fact.",
      },
      key: {
        type: "string",
        description:
          "A short, concise Unicode label (Chinese or English, e.g., '姓名', 'hobby', 'pet_name') summarizing the memory topic. Use snake_case or simple words. Try to reuse existing keys when updating similar topics.",
      },
      value: {
        type: "string",
        description:
          "The concrete fact to remember (max 100 chars). Required only for 'save'. Write it as a objective, declarative, third-person sentence (e.g., 'The user is a frontend developer' or '用户有一只叫猫猫的橘猫'). Avoid pronouns like 'I', 'You', 'me', 'my' or 'your'.",
      },
    },
    required: ["action", "key"],
  },
  execute: async (args, ctx) => {
    if (!ctx?.user_id) return "Cannot get user ID"

    const { action, key, value } = args

    switch (action) {
      case "save": {
        if (!value) return "save requires 'value'"
        const ok = await memory.set(ctx.user_id, key, value)
        if (!ok) return "Value is empty — nothing saved"
        return `Saved: ${key}`
      }
      case "delete": {
        await memory.del(ctx.user_id, key)
        return `Deleted: ${key}`
      }
      default:
        return `Unsupported action: ${action}`
    }
  },
})
