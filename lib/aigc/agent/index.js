/**
 * AgentManager — Agent 实例生命周期管理
 *
 * 暴露给 agent 工具的 API:
 *   Bot.aigc.agent.submit(entry)    → 创建并启动 Agent
 *   Bot.aigc.agent.check(taskId)    → 查询状态
 *   Bot.aigc.agent.cancel(taskId)   → 取消运行
 *   Bot.aigc.agent.resume(taskId, answer) → 恢复
 */

import { AgentRunner, getAgentState, saveAgentState } from "./runner.js"
import log from "../helpers/log.js"

// 引入所有 Agent 工具
import "./tools/BashTool.js"
import "./tools/FileEditTool.js"
import "./tools/FileSearchTool.js"
import "./tools/FileListTool.js"
import "./tools/FileViewTool.js"
import "./tools/FileWriteTool.js"
import "./tools/FetchDocTool.js"
import "./tools/WebSearchTool.js"
import "./tools/MediaTool.js"
import "./tools/WorkspaceTool.js"
import "./tools/CtrlTool.js"
import "./tools/SkillTool.js"

// Agent MCP 外部工具
import mcp from "./mcp.js"

/** 运行中的 Agent 实例 */
const runners = new Map() // taskId → AgentRunner

const MAX_CONCURRENT = 1 // 全局最大并发 Agent 数

class AgentManager {
  /** 提交任务，返回 { taskId } */
  async submit(entry) {
    const { userId } = entry
    if (!userId) throw new Error("缺少 userId")

    // 并发限制（running 和 waiting 都计入，与 agent 工具保持一致）
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
        log.error(`[Agent] 任务 ${taskId} 异常退出, ${err.message}`)
        if (runner.status === "running" || runner.status === "waiting") {
          runner.status = "failed"
          runner._result = `执行异常: ${err.message}`
          await runner._persist().catch(() => {})
          // 异常退出走正常流程之外，这里补发失败通知，避免用户无感知
          if (entry.selfId && entry.userId) {
            await Bot.aigc
              .injectMessage({
                self_id: entry.selfId,
                user_id: entry.userId,
                ...(entry.groupId ? { group_id: entry.groupId } : {}),
                text: `[Agent 任务失败: ${taskId}]\n目标: ${(entry.goal || "").slice(0, 100)}\n\n执行异常: ${err.message}`,
              })
              .catch(() => {})
          }
        }
      })
      .finally(() => {
        runners.delete(taskId)
      })

    return { taskId, status: "running" }
  }

  /** 校验操作者是否有权操作该任务。owner 本人或 master 可操作，否则抛错 */
  _assertOwner(runner, userId, isMaster) {
    if (!userId) throw new Error("缺少操作者身份 (userId)")
    if (isMaster) return
    if (String(runner._userId) !== String(userId)) {
      throw new Error(`无权操作他人任务 (task_id: ${runner.taskId})`)
    }
  }

  /** 查询任务状态 */
  async check(taskId, userId, isMaster = false) {
    const runner = runners.get(taskId)
    if (runner) {
      this._assertOwner(runner, userId, isMaster)
      return { taskId, status: runner.status, goal: runner._goal, result: runner._result }
    }
    // Runner 不在内存中，查 Redis
    const state = await getAgentState(taskId)
    if (!state) return null
    if (!isMaster && String(state.userId) !== String(userId)) {
      throw new Error(`无权查看他人任务 (task_id: ${taskId})`)
    }
    return { taskId: state.taskId, status: state.status, goal: state.goal, result: state.result }
  }

  /** 取消运行中的任务 */
  async cancel(taskId, userId, isMaster = false) {
    const runner = runners.get(taskId)
    if (!runner) {
      const state = await getAgentState(taskId)
      if (!state) return false
      if (!isMaster && String(state.userId) !== String(userId)) {
        throw new Error(`无权取消他人任务 (task_id: ${taskId})`)
      }
      if (state.status !== "running" && state.status !== "waiting") return false
      // 不在内存中但状态为 running/waiting → 中断残留
      state.status = "cancelled"
      state.completedAt = Date.now()
      await saveAgentState(taskId, state)
      return true
    }
    this._assertOwner(runner, userId, isMaster)
    if (runner.status !== "running" && runner.status !== "waiting") return false
    runner.cancel()
    return true
  }

  /** 恢复等待中的 Agent */
  async resume(taskId, answer, userId, isMaster = false) {
    const runner = runners.get(taskId)
    if (!runner) throw new Error(`Agent ${taskId} 不在内存中`)
    this._assertOwner(runner, userId, isMaster)
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
