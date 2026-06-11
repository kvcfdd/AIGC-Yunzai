import tools from "./registry.js"
import voice from "../voice/index.js"

tools.register({
  name: "enable_voice",
  description:
    "Convert your next text reply to voice before sending. Use when you want to speak rather than type, or when a lively spoken response fits the moment.",
  parameters: {
    type: "object",
    properties: {
      emo_switch: {
        type: "array",
        items: { type: "integer" },
        minItems: 5,
        maxItems: 5,
        description:
          "情绪控制，5个0-10的整数，依次对应: [生气, 开心, 中立, 难过, 匹配上下文]。默认全部为0",
      },
    },
    required: [],
  },
  execute: async (args, ctx) => {
    const user_id = ctx?.user_id
    if (!user_id) return "无法获取用户标识"

    const cfgCheck = voice.checkConfig()
    if (!cfgCheck.ok) return cfgCheck.reason

    const creditCheck = await voice.checkcredit()
    if (!creditCheck.ok) return creditCheck.reason

    voice.enable(user_id, args.emo_switch)
    return `Voice mode enabled. Your next reply will be read aloud. DO NOT use @mentions, [emoji] tags, or <x> splitters in your reply — they cannot be spoken and will confuse the listener. Reply with plain, natural speech.`
  },
})
