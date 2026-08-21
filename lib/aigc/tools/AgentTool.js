/**
 * AgentTool — 对话与 Agent 子系统之间的桥梁
 *
 * 通过此工具与 Agent 子系统交互：
 *   agent.submit({ goal })           → 派发任务给 Agent，返回 deferred
 *   agent.check({ task_id })        → 查询任务状态
 *   agent.cancel({ task_id })       → 取消任务
 */

import tools from "./registry.js"
import cfg from "../../config/config.js"

/** 最大用户并发 Agent 数 */
const MAX_USER_TASKS = 1

/** Agent 子系统总开关，默认关闭 */
function agentEnabled() {
  return cfg.agent?.enable ?? false
}

/** 用户白名单检查: 主人始终可用，白名单用户可用 */
function userAllowed(userId, isMaster) {
  if (isMaster) return true
  return (cfg.agent?.qq_whitelist || []).map(String).includes(String(userId))
}

tools.register(
  {
    name: "agent",
    description: `派发任务给 Agent 后台执行。Agent 是独立的本地工作子模型，可以在后台完成多步复杂任务，完成后会告知你。

- 它是无状态的！不知道你和用户说的什么，因此你的任务描述一定要详细，不仅是要它做什么，结果要求也要说明，但不要干涉它执行任务过程，如果涉及原始文件改动相关的任务，请确保给它原文件的url或本地文件路径
- 本轮对话中用户发送的图片/视频/语音/文件会自动随任务转发给 Agent，涉及其它的则需要你主动说明。
- 它可以在本地运行 shell 命令、读写文件、创建/运行脚本等操作。
- 你派发的任务信息不足时，Agent 会直接结束任务并在结果中说明缺少的信息，届时请补充信息后重新提交任务。

操作示例:
- submit: 提交任务。
  例: agent({ action: "submit", goal: "搜索今天AI新闻，浏览前5篇获取全文，生成中文简报写入 report.md" })

- check: 查询任务状态。
  例: agent({ action: "check", task_id: "01J..." })

- cancel: 取消运行中的任务。
  例: agent({ action: "cancel", task_id: "01J..." })

每用户最多 ${MAX_USER_TASKS} 个并发。`,

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["submit", "check", "cancel"],
          description: "操作: submit=提交, check=查询, cancel=取消",
        },
        goal: {
          type: "string",
          description: "submit: 任务描述",
        },
        task_id: {
          type: "string",
          description: "check/cancel: 任务 ID",
        },
      },
      required: ["action"],
    },

    execute: async (args, ctx) => {
      const { action, goal, task_id } = args
      const userId = String(ctx.user_id || "unknown")
      const selfId = String(ctx.event?.self_id || "")
      const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null
      // 任务操作者的权限身份：任务所有者本人或 master
      const isMaster = ctx.event?.isMaster === true

      // 仅主人或白名单用户可调用本工具
      if (!userAllowed(userId, isMaster)) {
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

      if (action === "submit") {
        if (!goal) return "请提供任务目标 (goal)"

        // 检查并发
        const running = Bot.aigc.agent.listUserTasks(userId).filter(t => t.status === "running").length
        if (running >= MAX_USER_TASKS) {
          return `你已有 ${MAX_USER_TASKS} 个 Agent 任务正在运行，请等待部分完成后再提交。`
        }

        try {
          const { taskId } = await Bot.aigc.agent.submit({
            goal,
            userId,
            selfId,
            ...(groupId ? { groupId } : {}),
            // 本轮多模态输入随任务转发给 Agent
            ...(ctx.media ? { media: ctx.media } : {}),
          })

          return {
            deferred: true,
            task_id: taskId,
            message: `Agent 任务已提交 (ID: ${taskId})，正在后台执行。\n目标: ${goal.slice(0, 150)}${goal.length > 150 ? "..." : ""}\n\n任务结束后会主动通知你。`,
          }
        } catch (err) {
          return `提交任务失败: ${err.message}`
        }
      }

      return `未知操作: ${action}`
    },
  },
  { enabled: agentEnabled },
)
