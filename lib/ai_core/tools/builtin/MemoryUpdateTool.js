import tools from "../tool-registry.js"
import { updatePersistentMemory } from "../../memory/persistent-store.js"

tools.register({
  name: "memory_update",
  description: `Manage the bot's persistent memory files. Their contents are injected into the runtime context on every future turn, so keep them short and high-signal.

What to store: durable facts worth remembering across sessions — the current user's identity, preferences, communication style, and ongoing projects (scope "user"); group norms, inside jokes, and recurring member context (scope "group", group chats only); bot-wide environment facts and long-term conventions (scope "global", master only).

What not to store: transient details, information already present in the conversation or easy to re-derive, vague statements, long quotes or logs, and anything secret (tokens, keys, passwords).

How: one concise fact per line, max 5 lines per call and 300 characters per line. Use action "append" for new facts, "replace" with a unique old_text substring to update or merge an existing entry, and "remove" with the exact existing line to delete it. Files have a hard character limit; when a write is rejected as full, the error lists the current entries — merge or delete entries and retry in the same turn. Never duplicate an existing entry.`,
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "group", "global"],
        description: "Memory scope: current user, current group, or bot-wide.",
      },
      action: {
        type: "string",
        enum: ["append", "replace", "remove"],
        default: "append",
        description: "append adds lines; replace updates the unique entry containing old_text; remove deletes lines that exactly match existing entries.",
      },
      content: {
        type: "string",
        description: "One concise fact per line (max 5 lines, 300 characters each). For replace, the new line that replaces the matched entry.",
      },
      old_text: {
        type: "string",
        description: "Required for replace: a unique substring of the existing entry to update.",
      },
    },
    required: ["scope", "content"],
  },
  execute: async (args, ctx) =>
    updatePersistentMemory({
      scope: args?.scope,
      action: args?.action,
      content: args?.content,
      oldText: args?.old_text,
      event: ctx?.event,
      config: ctx?.config,
    }),
})
