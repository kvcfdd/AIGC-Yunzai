import path from "node:path"
import cfg from "../../config/config.js"
import agentTools from "./registry.js"
import { WorkspaceManager } from "./workspace.js"
import { buildAssistantMsg } from "../helpers/message.js"
import log from "../helpers/log.js"

// Redis 持久化
const REDIS_PREFIX = "aigc:agent:"
const TASK_TTL_S = 60 * 60

async function saveAgentState(taskId, state) {
  try {
    await redis.set(`${REDIS_PREFIX}${taskId}`, JSON.stringify(state), { EX: TASK_TTL_S })
  } catch {}
}

async function getAgentState(taskId) {
  try {
    const raw = await redis.get(`${REDIS_PREFIX}${taskId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// 启动清理
async function cleanupStaleAgents() {
  try {
    const keys = await redis.keys(`${REDIS_PREFIX}*`)
    let cleaned = 0
    for (const key of keys) {
      const raw = await redis.get(key)
      if (!raw) continue
      try {
        const state = JSON.parse(raw)
        if (state.status === "running" || state.status === "waiting") {
          state.status = "interrupted"
          state.result = "[Bot 重启，Agent 任务丢失]"
          state.completedAt = Date.now()
          await redis.set(key, JSON.stringify(state), { EX: TASK_TTL_S })
          cleaned++
        }
      } catch {}
    }
    if (cleaned > 0) log.info(`[Agent] 清理 ${cleaned} 个因重启丢失的任务`)
  } catch {}
}
await cleanupStaleAgents()

const AGENT_SYSTEM = ["你是一个后台任务执行 Agent。使用工具在后台完成用户提交的任务。", "", "核心规则:", "1. 你不需要直接回复用户 — 系统会自动通知用户任务结果", "2. 遇到不确定的信息，调用 ctrl.clarify 反问，不要猜测", "3. 复杂多步任务优先用 sandbox 写代码批量执行", "4. 所有生成的文件写入 workspace（读写下发工具对应 workspace 的 read/write）", "5. 任务完成后必须调用 ctrl.deliver 标记交付文件并输出摘要", "6. 禁止输出 no_reply 或空内容"].join("\n")

const CLARIFY_TIMEOUT_S = 300 // 等待澄清回复的超时时间 (5分钟)

export class AgentRunner {
  constructor(taskId) {
    this.taskId = taskId
    this.status = "idle"
    this.ws = new WorkspaceManager(taskId)
    // 暂停/恢复机制
    this._resumeResolve = null
    this._resumePromise = null
    this._pendingClarify = null
    this._pendingAnswer = undefined
    // 中断控制器 — 用于 cancel 时中断飞行中的 LLM 调用
    this._abortController = new AbortController()
    // 任务元信息
    this._goal = ""
    this._context = ""
    this._userId = ""
    this._selfId = ""
    this._groupId = null
    this._createdAt = 0
    this._result = null
  }

  getState() {
    return {
      taskId: this.taskId,
      status: this.status,
      goal: this._goal,
      context: this._context,
      userId: this._userId,
      selfId: this._selfId,
      groupId: this._groupId,
      createdAt: this._createdAt,
      result: this._result,
      completedAt: this.status === "done" || this.status === "failed" || this.status === "cancelled" ? Date.now() : undefined,
    }
  }

  async _persist() {
    await saveAgentState(this.taskId, this.getState())
  }

  /** 主入口 — fire-and-forget */
  async run(entry) {
    const { goal, context, userId, selfId, groupId } = entry
    Object.assign(this, { _goal: goal, _context: context || "", _userId: userId, _selfId: selfId, _groupId: groupId || null, _createdAt: Date.now() })
    this.status = "running"
    await this._persist()
    await this.ws.ensureDir()

    const agentModel = cfg.aigc?.agent?.model || cfg.aigc?.gemini?.model
    if (!agentModel) {
      this.status = "failed"
      this._result = "未配置 Agent 模型 (cfg.aigc.agent.model)"
      await this._persist()
      return
    }

    const maxRounds = cfg.aigc?.agent?.max_rounds || 20
    const agentMaxTokens = cfg.aigc?.agent?.max_tokens || 65536
    const toolDefs = agentTools.getDefinitions()

    const systemPrompt = [AGENT_SYSTEM, context ? `\n任务背景:\n${context}` : "", `\n工作区路径: ${this.ws.dir}`].filter(Boolean).join("\n")

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: goal },
    ]

    try {
      for (let round = 0; round < maxRounds; round++) {
        // 暂停等待 clarifiy
        if (this.status === "waiting") {
          const answer = await this._waitForResume()
          if (this.status === "cancelled") return
          // 恢复后重建 AbortController（旧的已被 cancel 触发 abort）
          this._abortController = new AbortController()
          messages.push({ role: "user", content: `[主模型回复]: ${answer}` })
          this.status = "running"
        }

        // 取消检查
        if (this.status === "cancelled") {
          await this._persist()
          return
        }

        const opts = { stateful: false, model: agentModel, max_tokens: agentMaxTokens, tools: toolDefs, tool_choice: "auto", signal: this._abortController.signal }
        const res = await Bot.aigc.provider.chat(messages, opts)

        // LLM 调用返回后再次检查取消状态（cancel 可能在调用期间发生，signal 不保证立即中断）
        if (this.status === "cancelled") {
          await this._persist()
          return
        }

        if (res.blocked) {
          this.status = "failed"
          this._result = `[安全策略拦截: ${res.finishReason}]`
          break
        }

        if (res.tool_calls?.length) {
          messages.push(buildAssistantMsg(res))

          const ctx = {
            taskId: this.taskId,
            userId: this._userId,
            selfId: this._selfId,
            groupId: this._groupId,
            runner: this,
            workspace: this.ws,
          }

          const results = await Promise.all(
            res.tool_calls.map(async tc => {
              const fnName = tc?.function?.name
              if (!fnName) return { name: "unknown", error: "missing function.name" }
              let args = {}
              try {
                args = JSON.parse(tc?.function?.arguments || "{}")
              } catch {}
              try {
                return await agentTools.execute(fnName, args, ctx)
              } catch (err) {
                return { name: fnName, error: err?.message || String(err) }
              }
            }),
          )

          for (let i = 0; i < results.length; i++) {
            const r = results[i]
            const payload = r.error || r.result
            const tContent = typeof payload === "string" ? payload : payload?.message || JSON.stringify(payload ?? "")
            messages.push({ role: "tool", content: tContent, tool_call_id: res.tool_calls[i]?.id || `call_${i}`, name: res.tool_calls[i]?.function?.name })
          }

          // ctrl.clarify 触发暂停
          if (this._pendingClarify) {
            const clarifyQuestion = this._pendingClarify
            this._pendingClarify = null
            this._fireClarify(clarifyQuestion).catch(err => {
              log.warn(`[Agent] clarify 注入失败 (${this.taskId}): ${err.message}，降级继续执行`)
              // 注入失败 → 无法通知用户 → 回退到 running，让 Agent 基于已有信息继续
              this.status = "running"
              // 告知 Agent 澄清未送达，需自行决定
              messages.push({ role: "user", content: `[系统提示] 澄清问题 "${clarifyQuestion}" 未能送达用户，请基于已有信息自行决定下一步操作。` })
            })
            continue // 下轮顶部进入 waiting 暂停（若注入成功）/ 或已是 running（若失败）
          }

          // ctrl.deliver 触发完成
          if (this.status === "done") break
          // 取消
          if (this.status === "cancelled") {
            await this._persist()
            return
          }

          // 最后一轮：强制输出
          if (round === maxRounds - 1) {
            const finalRes = await Bot.aigc.provider.chat(messages, { stateful: false, model: agentModel, tool_choice: "none", tools: toolDefs })
            this._result = finalRes.content || ""
            this.status = "done"
            break
          }
          continue
        }

        // 文本回复 — Agent 认为任务完成
        this._result = res.content || ""
        if (!this._result) this._result = "(Agent 执行完毕但未获得结果)"
        this.status = "done"
        break
      }
    } catch (err) {
      this.status = "failed"
      this._result = `[Agent 异常: ${err.message}]`
    }

    // 注入结果到主模型
    if (this.status === "done") await this._injectDeliver()
    else if (this.status === "failed" && this._result) await this._injectFailed()
    await this._persist()
    log.info(`[Agent] 任务 ${this.taskId} 结束, status=${this.status}`)
  }

  // 暂停/恢复
  /** 等待 resume() 或 cancel()。处理 resume 早于 pause 的竞态，超时自动取消 */
  async _waitForResume() {
    if (this._pendingAnswer !== undefined) {
      const answer = this._pendingAnswer
      this._pendingAnswer = undefined
      return answer
    }
    this._resumePromise = new Promise(resolve => {
      this._resumeResolve = resolve
    })
    // 超时保护：CLARIFY_TIMEOUT_S 秒后无人回复则自动取消
    const timer = setTimeout(() => {
      log.warn(`[Agent] clarify 超时 (${CLARIFY_TIMEOUT_S}s)，自动取消任务 ${this.taskId}`)
      this.cancel()
    }, CLARIFY_TIMEOUT_S * 1000)
    const answer = await this._resumePromise
    clearTimeout(timer)
    this._pendingAnswer = undefined
    return answer
  }

  /** 注入 clarifiy 问题到主模型
   *  @param {string} question - 澄清问题文本 */
  async _fireClarify(question) {
    Bot.aigc
      .injectMessage({
        self_id: this._selfId,
        user_id: this._userId,
        ...(this._groupId ? { group_id: this._groupId } : {}),
        text: `[Agent 需要确认 — ${this.taskId.slice(0, 8)}]\n任务: ${this._goal.slice(0, 80)}\n\n❓ ${question}\n\n请回复 task.clarify_reply({ task_id: "${this.taskId}", answer: "..." })`,
      })
      .catch(err => log.warn(`[Agent] clarify inject 失败: ${err.message}`))
  }

  /** 从外部调用：恢复运行 */
  resume(answer) {
    if (this.status !== "waiting") throw new Error(`Agent ${this.taskId} 不在等待状态 (${this.status})`)
    this.status = "running"
    this._pendingAnswer = answer
    if (this._resumeResolve) {
      this._resumeResolve(answer)
      this._resumeResolve = null
      this._resumePromise = null
    }
  }

  /** 从外部调用：取消运行 */
  cancel() {
    this.status = "cancelled"
    this._pendingAnswer = null
    this._abortController.abort()
    if (this._resumeResolve) {
      this._resumeResolve(null)
      this._resumeResolve = null
      this._resumePromise = null
    }
  }

  // 结果注入
  async _injectDeliver() {
    let files = await this.ws.getDeliverFiles()
    // 即使 Agent 没调用 ctrl.deliver，也列出所有 workspace 文件（排除内部标记文件）
    if (!files.length) {
      const allFiles = await this.ws.listFiles()
      files = allFiles.filter(f => f.name !== "__deliver__.json").map(f => f.name)
    }
    const fileList = files.length ? `\n\n📎 交付文件:\n${files.map(f => `- ${path.join(this.ws.dir, f)}`).join("\n")}\n\n你可以用 send({ type:"file", payload:"路径" }) 发送这些文件给用户。` : ""
    try {
      await Bot.aigc.injectMessage({
        self_id: this._selfId,
        user_id: this._userId,
        ...(this._groupId ? { group_id: this._groupId } : {}),
        text: `[Agent 任务完成: ${this.taskId}]\n目标: ${this._goal.slice(0, 100)}${this._goal.length > 100 ? "..." : ""}\n\n结果:\n${this._result || "(无结果)"}${fileList}`,
      })
    } catch (err) {
      log.warn(`[Agent] deliver inject 失败: ${err.message}`)
    }
  }

  async _injectFailed() {
    try {
      await Bot.aigc.injectMessage({
        self_id: this._selfId,
        user_id: this._userId,
        ...(this._groupId ? { group_id: this._groupId } : {}),
        text: `[Agent 任务失败: ${this.taskId}]\n目标: ${this._goal.slice(0, 100)}\n\n${this._result}`,
      })
    } catch (err) {
      log.warn(`[Agent] failed inject 失败: ${err.message}`)
    }
  }
}

export { saveAgentState, getAgentState }
