/**
 * TaskTool — 主模型与 Agent 子架构之间的桥梁
 *
 * 主模型通过此工具与 Agent 子系统交互：
 *   task.submit({ goal, context })  → 派发任务给 Agent，返回 deferred
 *   task.check({ task_id })         → 查询任务状态
 *   task.cancel({ task_id })        → 取消任务
 *   task.clarify_reply({ task_id, answer }) → 回复 Agent 的确认请求
 */

import tools from "./registry.js"
import cfg from "../../config/config.js"

/** 最大用户并发 Agent 数 */
const MAX_USER_TASKS = 5

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
  description: `派发任务给 Agent 后台异步执行。Agent 是独立的本地工作子模型，可以在后台完成多步复杂任务，完成后自动通知你。

Agent 能力:
- bash: 执行任意系统命令（安装/运行脚本、编译、git、下载），支持后台运行
- 文件: 读写工作区文件、glob 列文件、正则搜索、查看文本/PDF/图片
- 网络: 网页搜索、网页正文抓取、网络图片/视频查看
- 确认: 信息不足时会通过 clarify 反问，你需用 clarify_reply 回复
- 交付: 完成后产出交付文件
- 可挂载外部 MCP 工具


操作:
- submit: 提交任务。Agent 独立执行，完成后自动通知你。
  例: task({ action: "submit", goal: "搜索今天AI新闻，浏览前5篇获取全文，生成中文简报写入 report.md" })

- check: 查询任务状态。
  例: task({ action: "check", task_id: "01J..." })

- cancel: 取消运行中的任务。
  例: task({ action: "cancel", task_id: "01J..." })

- clarify_reply: 回复 Agent 的确认问题。
  例: task({ action: "clarify_reply", task_id: "01J...", answer: "查询最近7天" })

每用户最多 ${MAX_USER_TASKS} 个并发。`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["submit", "check", "cancel", "clarify_reply"],
        description: "操作: submit=提交, check=查询, cancel=取消, clarify_reply=回复确认",
      },
      goal: {
        type: "string",
        description: "submit: 任务目标描述，越详细越好。如'搜索近3天 AI 新闻，浏览前5篇获取全文，生成中文简报写入 report.md'。Agent 看不到对话历史，依赖的细节请写进 goal 或 context",
      },
      context: {
        type: "string",
        description: "submit: 相关上下文。如当前对话摘要、用户偏好、约束条件、已有线索等。Agent 只能看到此字段与 goal，对话里提到的信息不会传给 Agent",
      },
      task_id: {
        type: "string",
        description: "check/cancel/clarify_reply: 任务 ID",
      },
      answer: {
        type: "string",
        description: "clarify_reply: 对 Agent 确认问题的回答",
      },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, goal, context, task_id, answer } = args
    const userId = String(ctx.user_id || "unknown")
    const selfId = String(ctx.event?.self_id || "")
    const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null
    // 任务操作者的权限身份：任务所有者本人或 master
    const isMaster = ctx.event?.isMaster === true

    // 总开关: 关闭时拦截所有操作
    if (!agentEnabled()) {
      return "Agent 子系统未开启！请在 config/config/aigc.yaml 中设置 agent.enable: true 后重启再试。"
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
          context: context || "",
          userId,
          selfId,
          ...(groupId ? { groupId } : {}),
        })

        return {
          deferred: true,
          task_id: taskId,
          message: `Agent 任务已提交 (ID: ${taskId})，正在后台执行。\n目标: ${goal.slice(0, 150)}${goal.length > 150 ? "..." : ""}\n\n完成后我会主动通知你。执行过程中若有疑问，Agent 也会主动询问你。`,
        }
      } catch (err) {
        return `提交任务失败: ${err.message}`
      }
    }

    return `未知操作: ${action}`
  },
})
