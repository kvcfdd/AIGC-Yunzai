import agentTools from "../registry.js"

agentTools.register({
  name: "ctrl",
  description: `Agent 控制工具 — 管理任务生命周期。

操作:
- clarify: 向主模型发送确认问题并暂停，等待回复后继续
  例: ctrl.clarify({ question: "用户没有指定日期范围，请确认是查询最近7天还是30天？" })

- deliver: 标记任务完成，指定交付文件和结果摘要。系统会将结果注入到主模型。
  例: ctrl.deliver({ summary: "已生成今日AI新闻简报", files: ["report.md", "chart.png"] })

注意: 任务完成时必须调用 deliver，否则主模型不会被通知。`,

  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["clarify", "deliver"], description: "操作类型" },
      question: { type: "string", description: "clarify: 需要确认的问题" },
      summary: { type: "string", description: "deliver: 任务结果摘要" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "deliver: 需要交付给用户的文件名列表 (已写入工作区的文件)",
      },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, question, summary, files = [] } = args
    const runner = ctx.runner

    if (action === "clarify") {
      if (!question) return "请提供需要确认的问题 (question)"
      runner._pendingClarify = question
      runner.status = "waiting"
      Bot.makeLog("info", `[Agent-Ctrl] 任务 ${ctx.taskId} 请求确认: ${question.slice(0, 100)}`)
      return { action: "clarify", message: "已向主模型发送确认请求，等待回复中..." }
    }

    if (action === "deliver") {
      // 标记交付文件
      if (files.length) {
        await ctx.workspace.markDeliverFiles(files)
        Bot.makeLog("info", `[Agent-Ctrl] 任务 ${ctx.taskId} 完成，交付 ${files.length} 个文件`)
      } else {
        Bot.makeLog("info", `[Agent-Ctrl] 任务 ${ctx.taskId} 完成，无交付文件`)
      }

      runner._result = summary || "任务完成"
      runner.status = "done"
      return { action: "deliver", summary: summary || "任务完成", files, message: "任务已完成，通知主模型中..." }
    }

    return `未知操作: ${action}`
  },
})
