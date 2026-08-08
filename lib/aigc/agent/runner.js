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

const AGENT_SYSTEM = [
  "你是一个任务执行 Agent，主要负责使用工具完成用户提交的任务。",
  "",
  "行为准则:",
  "1. 如果任务目标不明确或信息不足，必须调用 ctrl.clarify 反问；不要擅自猜测或自行决定",
  "2. 本地拥有完整的node.js/ffmpeg环境，已安装playwright浏览器，如需编写脚本请优先使用node.js，使用其它编程语言请先运行命令探测一下本地是否安装了对应的运行环境",
  "3. 本地操作核心是 bash：安装/运行脚本、处理文件、调用 CLI 工具都用它；复杂逻辑先写成脚本文件再执行",
  "4. 文件分工: file_list 列文件 → file_search 定位 → file_view 查看 → file_edit 修改；新建/读写文件用 workspace",
  "5. 网络: web_search 搜信息 → fetch_doc 抓全文 ；media 查看网络图片/视频",
  "6. 一轮可并行调用多个相互独立的工具，减少总轮次",
  "7. 所有产物写入任务工作区（绝对路径见本提示中的'工作区路径'）；所有文件路径一律使用绝对路径，禁止相对路径；重要内容写进文件而不是只靠输出",
  "8. 命令失败先读错误修正重试；耗时操作用 background 后台运行",
  "9. 任务完成后直接输出最终任务结果；如有需要交付给用户的文件，在结果文本中写明文件的绝对路径",
].join("\n")

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
    const { goal, userId, selfId, groupId } = entry
    Object.assign(this, { _goal: goal, _userId: userId, _selfId: selfId, _groupId: groupId || null, _createdAt: Date.now() })
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

    // 配置了代理地址时告知 Agent
    const proxyAddr = cfg.aigc?.proxy?.address
    const proxyNote = proxyAddr ? `\n代理配置: ${proxyAddr}\n如需访问被屏蔽的外网可走该代理,普通请求无需使用。` : ""

    const systemPrompt = [AGENT_SYSTEM, `\n当前目录: ${process.cwd()}（shell 命令与文件工具的默认执行/解析目录，相对路径基于此解析）`, `\n任务工作区路径: ${this.ws.dir}（所有产物写入此目录，访问时使用绝对路径）`, proxyNote].filter(Boolean).join("\n")

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

          // cancel 可能在工具执行期间发生 → 结果已无意义，直接退出，不再回填
          if (this.status === "cancelled") {
            await this._persist()
            return
          }

          for (let i = 0; i < results.length; i++) {
            const r = results[i]
            const payload = r.error || r.result
            let images = []
            let videos = []
            let tContent
            if (typeof payload === "string") {
              tContent = payload
            } else if (payload?.message) {
              tContent = payload.message
            } else if (payload && typeof payload === "object") {
              if (Array.isArray(payload.images)) images = payload.images
              if (Array.isArray(payload.videos)) videos = payload.videos
              tContent = payload.text || JSON.stringify(payload)
            } else {
              tContent = JSON.stringify(payload ?? "")
            }

            if (!images.length && !videos.length && typeof tContent === "string") {
              const imgRe = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g
              const matches = tContent.match(imgRe)
              if (matches?.length) {
                images = matches
                tContent = tContent.replace(imgRe, "[图片]")
              }
            }

            messages.push({ role: "tool", content: tContent, images, videos, tool_call_id: res.tool_calls[i]?.id || `call_${i}`, name: res.tool_calls[i]?.function?.name, signature: res.tool_calls[i]?.signature })
          }

          // ctrl.clarify 触发暂停
          if (this._pendingClarify) {
            const clarifyQuestion = this._pendingClarify
            this._pendingClarify = null
            this._fireClarify(clarifyQuestion).catch(err => {
              log.warn(`[Agent] clarify 注入失败 (${this.taskId}): ${err.message}，降级继续执行`)
              // 告知 Agent 澄清未送达，需自行决定
              messages.push({ role: "user", content: `[系统提示] 澄清问题 "${clarifyQuestion}" 未能送达用户，请基于已有信息自行决定下一步操作。` })
              if (this.status === "waiting") {
                try {
                  this.resume("(澄清未送达，请基于已有信息自行决定)")
                } catch {}
              }
            })
            continue // 下轮顶部进入 waiting 暂停（若注入成功）/ 或已由降级唤醒（若失败）
          }

          // 取消
          if (this.status === "cancelled") {
            await this._persist()
            return
          }

          // 最后一轮：强制输出
          if (round === maxRounds - 1) {
            const finalRes = await Bot.aigc.provider.chat(messages, { stateful: false, model: agentModel, tool_choice: "none", tools: toolDefs, signal: this._abortController.signal })
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
      // 用户回答与超时几乎同时到达的边界：resume 已把状态改回 running → 不取消
      if (this.status !== "waiting") return
      log.warn(`[Agent] clarify 超时 (${CLARIFY_TIMEOUT_S}s)，自动取消任务 ${this.taskId}`)
      this.cancel()
      // 超时取消是静默退出路径，补发通知告知用户，
      // 避免任务无声消失
      Bot.aigc
        .injectMessage({
          self_id: this._selfId,
          user_id: this._userId,
          ...(this._groupId ? { group_id: this._groupId } : {}),
          text: `[Agent 任务已取消: ${this.taskId.slice(0, 8)}]\n原因: 澄清问题超过 ${Math.round(CLARIFY_TIMEOUT_S / 60)} 分钟未得到回复。如需继续，请重新提交任务。`,
        })
        .catch(() => {})
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
        text: `[Agent 需要确认 — ${this.taskId.slice(0, 8)}]\n任务: ${this._goal.slice(0, 80)}\n\n需要确认的点: ${question}\n\n请调用 task 工具来解答，若不确定可先询问用户后再解答。`,
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
    // 结果截断，避免超长 Agent 输出膨胀主模型上下文/挤占用户配额
    const result = this._result || "(无结果)"
    const resultText = result.length > 2000 ? result.slice(0, 2000) + `\n…(已截断, 共 ${result.length} 字符)` : result
    try {
      await Bot.aigc.injectMessage({
        self_id: this._selfId,
        user_id: this._userId,
        ...(this._groupId ? { group_id: this._groupId } : {}),
        text: `[Agent 任务完成: ${this.taskId}]\n\n${resultText}`,
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
