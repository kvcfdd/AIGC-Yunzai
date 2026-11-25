import tools from "../tool-registry.js"
import { updatePersistentMemory } from "../../memory/persistent-store.js"

tools.register({
  name: "memory_update",
  description: "增删改 LLM 的持久记忆",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "group", "global"],
        description: "user=当前用户，group=当前群，global=全局（仅 bot_owner）",
      },
      action: {
        type: "string",
        enum: ["append", "replace", "remove"],
        default: "append",
        description: "append=追加，replace=替换，remove=删除",
      },
      content: {
        type: "string",
        description: "记忆内容，一行一条",
      },
      old_text: {
        type: "string",
        description: "replace 时用于定位的原文片段",
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
    }),
})
