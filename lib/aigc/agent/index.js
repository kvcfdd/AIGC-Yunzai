/**
 * AgentManager — Agent 实例生命周期管理
 *
 * 暴露给 TaskTool 的 API:
 *   Bot.aigc.agent.submit(entry)    → 创建并启动 Agent
 *   Bot.aigc.agent.check(taskId)    → 查询状态
 *   Bot.aigc.agent.cancel(taskId)   → 取消运行
 *   Bot.aigc.agent.resume(taskId, answer) → 恢复
 */

import { AgentRunner, getAgentState, saveAgentState } from "./runner.js"

// 引入所有 Agent 工具
import "./tools/SearchTool.js"
import "./tools/BrowseTool.js"
import "./tools/MediaTool.js"
import "./tools/CodeGenTool.js"
import "./tools/SandboxTool.js"
import "./tools/WorkspaceTool.js"
import "./tools/CtrlTool.js"

// Agent MCP 外部工具
import mcp from "./mcp.js"

/** 运行中的 Agent 实例 */
const runners = new Map() // taskId → AgentRunner

const MAX_CONCURRENT = 5 // 全局最大并发 Agent 数

class AgentManager {
  /** 提交任务，返回 { taskId } */
  async submit(entry) {
    const { userId } = entry
    if (!userId) throw new Error("缺少 userId")

    // 并发限制（running 和 waiting 都计入，与 TaskTool 保持一致）
    let userRunning = 0
    for (const [, r] of runners) {
      if (r._userId === userId && (r.status === "running" || r.status === "waiting")) userRunning++
    }
    if (userRunning >= MAX_CONCURRENT) {
      throw new Error(`你已有 ${MAX_CONCURRENT} 个 Agent 正在运行，请等待部分完成后再提交`)
    }

    const { ulid } = await import("ulid")
    const taskId = ulid()
    const runner = new AgentRunner(taskId)
    runner._userId = userId // 先标记归属，避免 run() 异步延迟导致并发检查漏算
    runners.set(taskId, runner)

    // 分离执行
    runner
      .run(entry)
      .catch(async err => {
        Bot.makeLog("error", [`[Agent] 任务 ${taskId} 异常退出`, err.message])
        if (runner.status === "running" || runner.status === "waiting") {
          runner.status = "failed"
          runner._result = `执行异常: ${err.message}`
          await runner._persist().catch(() => {})
        }
      })
      .finally(() => {
        runners.delete(taskId)
      })

    return { taskId, status: "running" }
  }

  /** 查询任务状态 */
  async check(taskId) {
    const runner = runners.get(taskId)
    if (runner) {
      return { taskId, status: runner.status, goal: runner._goal, result: runner._result }
    }
    // Runner 不在内存中，查 Redis
    const state = await getAgentState(taskId)
    if (!state) return null
    return { taskId: state.taskId, status: state.status, goal: state.goal, result: state.result }
  }

  /** 取消运行中的任务 */
  async cancel(taskId) {
    const runner = runners.get(taskId)
    if (!runner) {
      const state = await getAgentState(taskId)
      if (!state) return false
      if (state.status !== "running" && state.status !== "waiting") return false
      // 不在内存中但状态为 running/waiting → 中断残留
      state.status = "cancelled"
      state.completedAt = Date.now()
      await saveAgentState(taskId, state)
      return true
    }
    if (runner.status !== "running" && runner.status !== "waiting") return false
    runner.cancel()
    return true
  }

  /** 恢复等待中的 Agent */
  async resume(taskId, answer) {
    const runner = runners.get(taskId)
    if (!runner) throw new Error(`Agent ${taskId} 不在内存中`)
    runner.resume(answer)
  }

  /** 列出用户在内存中的所有活跃 Agent */
  listUserTasks(userId) {
    const tasks = []
    for (const [taskId, runner] of runners) {
      if (runner._userId === userId) {
        tasks.push({ taskId, status: runner.status, goal: runner._goal, createdAt: runner._createdAt })
      }
    }
    return tasks
  }
}

const agent = new AgentManager()
agent.mcp = mcp
export default agent
