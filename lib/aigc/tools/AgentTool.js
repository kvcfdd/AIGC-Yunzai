/**
 * TaskTool — 主模型与 Agent 子架构之间的桥梁
 *
 * 主模型通过此工具与 Agent 子系统交互：
 *   task.submit({ goal })           → 派发任务给 Agent，返回 deferred
 *   task.check({ task_id })         → 查询任务状态
 *   task.cancel({ task_id })        → 取消任务
 *   task.clarify_reply({ task_id, answer }) → 回复 Agent 的确认请求
 */

import tools from "./registry.js"
import cfg from "../../config/config.js"

/** 最大用户并发 Agent 数 */
const MAX_USER_TASKS = 1

/** Agent 子系统总开关，默认关闭 */
function agentEnabled() {
  return cfg.aigc?.agent?.enable ?? false
}

/** 是否仅主人可使用 Agent 子系统 */
function masterOnlyEnabled() {
  return cfg.aigc?.agent?.master_only ?? true
}

tools.register({
  name: "task",
  description: `派发任务给 Agent 后台异步执行。Agent 是独立的本地工作子模型，可以在后台完成多步复杂任务，完成后会告知你。

Agent 能力边界:
- 它是无状态的！它不知道你是谁，也不知道你和用户说的什么，因此如果需要它处理某个文件此类的操作，必须在 goal 中明确给出相应文件的url或本地文件路径，确保 goal 中包含本次任务所有必要信息。
- 它可以读写本地文件、视觉识别、网页搜索、执行 shell 命令(安装/编写/运行脚本、操作文件、调用 CLI 工具、git 等)。
- 当你的派发的任务提供的信息不足时 Agent 会向你询问，表现为收到 "[Agent 需要确认]" 的消息，你需用 clarify_reply 解答它的疑问，解答后直接输出 no_reply 无感完成本轮对话避免打扰用户。

操作示例:
- submit: 提交任务。
  例: task({ action: "submit", goal: "搜索今天AI新闻，浏览前5篇获取全文，生成中文简报写入 report.md" })

- check: 查询任务状态。
  例: task({ action: "check", task_id: "01J..." })

- cancel: 取消运行中的任务。
  例: task({ action: "cancel", task_id: "01J..." })

- clarify_reply: 解答 Agent 询问的问题。
  例: task({ action: "clarify_reply", task_id: "01J...", answer: "查询最近7天" })

每用户最多 ${MAX_USER_TASKS} 个并发。`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["submit", "check", "cancel", "clarify_reply"],
        description: "操作: submit=提交, check=查询, cancel=取消, clarify_reply=解答Agent的问题",
      },
      goal: {
        type: "string",
        description: "submit: 任务描述，需要它做什么？以及任务所需的所有信息（文件路径、URL等）都必须在 goal 中明确给出",
      },
      task_id: {
        type: "string",
        description: "check/cancel/clarify_reply: 任务 ID",
      },
      answer: {
        type: "string",
        description: "clarify_reply: 对 Agent 确认问题的回答文本",
      },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, goal, task_id, answer } = args
    const userId = String(ctx.user_id || "unknown")
    const selfId = String(ctx.event?.self_id || "")
    const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null
    // 任务操作者的权限身份：任务所有者本人或 master
    const isMaster = ctx.event?.isMaster === true

    // 总开关: 关闭时拦截所有操作
    if (!agentEnabled()) {
      return "Agent 子系统未开启！"
    }

    // 开启时仅主人可调用本工具
    if (masterOnlyEnabled() && !isMaster) {
      return "用户尚未获得bot owner (master)授权，无法使用 Agent 子系统！"
    }

    if (action === "check") {
      if (!task_id) return "请提供任务 ID (task_id)"
      try {
        const r = await Bot.aigc.agent.check(task_id, userId, isMaster)
        if (!r) return `未找到任务 ${task_id}。可能已过期或 Bot 重启导致丢失。`
        return `任务 ${r.taskId}\n状态: ${r.status}\n目标: ${(r.goal || "").slice(0, 200)}\n${r.result ? `结果: ${r.result.slice(0, 800)}` : "暂无结果"}`
      } catch (err) {
        return `查询失败: ${err.message}`
      }
    }

    if (action === "cancel") {
      if (!task_id) return "请提供任务 ID (task_id)"
      try {
        const success = await Bot.aigc.agent.cancel(task_id, userId, isMaster)
        return success ? `任务 ${task_id} 已取消。` : `无法取消任务 ${task_id}。请检查任务状态。`
      } catch (err) {
        return `取消失败: ${err.message}`
      }
    }

    if (action === "clarify_reply") {
      if (!task_id || !answer) return "请提供 task_id 和 answer"
      try {
        await Bot.aigc.agent.resume(task_id, answer, userId, isMaster)
        return `已回复 Agent: "${answer.slice(0, 200)}${answer.length > 200 ? "..." : ""}"`
      } catch (err) {
        return `回复失败: ${err.message}`
      }
    }

    if (action === "submit") {
      if (!goal) return "请提供任务目标 (goal)"

      // 检查并发
      const running = Bot.aigc.agent.listUserTasks(userId).filter(t => t.status === "running" || t.status === "waiting").length
      if (running >= MAX_USER_TASKS) {
        return `你已有 ${MAX_USER_TASKS} 个 Agent 任务正在运行，请等待部分完成后再提交。`
      }

      try {
        const { taskId } = await Bot.aigc.agent.submit({
          goal,
          userId,
          selfId,
          ...(groupId ? { groupId } : {}),
        })

        return {
          deferred: true,
          task_id: taskId,
          message: `Agent 任务已提交 (ID: ${taskId})，正在后台执行。\n目标: ${goal.slice(0, 150)}${goal.length > 150 ? "..." : ""}\n\n完成后会主动通知你。执行过程中若有疑问，Agent 也会主动询问你。`,
        }
      } catch (err) {
        return `提交任务失败: ${err.message}`
      }
    }

    return `未知操作: ${action}`
  },
})
