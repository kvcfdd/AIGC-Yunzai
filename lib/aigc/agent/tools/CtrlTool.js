import agentTools from "../registry.js"
import log from "../../helpers/log.js"

agentTools.register({
  name: "ctrl",
  description: `Agent 提问工具: 如果任务目标不清楚或缺少所需信息，比如文件url/路径，可向主 Agent 发送对任务的疑问以获取更多信息。`,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "你想问的或需要确认的问题" },
    },
    required: ["question"],
  },

  execute: async (args, ctx) => {
    const { question } = args
    const runner = ctx.runner
    if (!question) return "你想问的或需要确认的问题 (question)"
    runner._pendingClarify = question
    runner.status = "waiting"
    log.info(`[Agent-Ctrl] 任务 ${ctx.taskId} 请求确认: ${question.slice(0, 100)}`)
    return { message: "已向主模型发送确认请求，等待回复中..." }
  },
})
