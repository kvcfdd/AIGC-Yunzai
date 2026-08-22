import cfg from "../../config/config.js"
import agentTools from "./registry.js"
import { WorkspaceManager, loadKnowledge } from "./workspace.js"
import { buildAssistantMsg } from "../helpers/message.js"
import log from "../helpers/log.js"
import { agentSkills, skillsListBlock } from "../skills/index.js"

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
        if (state.status === "running") {
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

// Agent 默认系统提示词
const AGENT_SYSTEM = [
  "你是一个 AI 助手，负责执行用户交给你的任务。",
  "",
  "行为准则:",
  "- 绝对安全规则: 禁止执行任何可能危害系统安全的操作，如删除系统文件、修改系统配置、执行任意有害系统的 shell 命令等。",
  "- 当任务目标不明确或信息不足时，不要擅自猜测，直接说明缺少了哪些信息，比如让你改图但没给图，让你做ppt却没说内容核心等。",
  "- 任务过程中产出的文件放在任务工作区目录下；所有文件路径一律使用绝对路径，禁止相对路径",
  "- 本地拥有 node.js 环境，需要跑脚本请优先考虑(如果需要在Linux上跑python，请在当前目录下创建虚拟环境用于安装相关库(有则直接用)，禁止强行安装全局库)",
  "- 避坑指南 knowledge.md(项目根目录，需要自己建): 发现本地跑命令有哪些遇到的坑，这与任务无关，主要是系统环境层面的，如果有必要的话可以写入，这是给下一次执行任务的没有上下文的你自己看的，以帮助你自己避坑，保持文件简洁有效，宁缺毋滥！",
  "- 任务结束后使用自然语言输出最终任务结果；如有需要交付的文件，在结果文本中写明文件的绝对路径",
].join("\n")

export class AgentRunner {
  constructor(taskId) {
    this.taskId = taskId
    this.status = "idle"
    this.ws = new WorkspaceManager(taskId)
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
    const { goal, userId, selfId, groupId, media } = entry
    Object.assign(this, { _goal: goal, _userId: userId, _selfId: selfId, _groupId: groupId || null, _createdAt: Date.now() })
    this.status = "running"
    await this._persist()
    await this.ws.ensureDir()

    const agentModel = cfg.agent?.model || "gemini-3.7-flash"
    if (!agentModel) {
      this.status = "failed"
      this._result = "未配置 Agent 模型 (cfg.agent.model)"
      await this._persist()
      return
    }

    // 用户当前轮的多模态输入随任务转发；gemma 族不支持音频 → 丢弃
    const initMedia = media || {}
    if (/^gemma/i.test(agentModel) && initMedia.audios?.length) {
      log.debug(`Agent 模型 ${agentModel} 不支持音频输入，已忽略语音`)
      initMedia.audios = []
    }

    const maxRounds = cfg.agent?.max_rounds || 20
    const agentMaxTokens = cfg.agent?.max_tokens || 8192
    const toolDefs = agentTools.getDefinitions()

    // 配置了代理地址时告知 Agent
    const proxyAddr = cfg.aigc?.proxy?.address
    const proxyNote = proxyAddr ? `\n<proxy>\n本地代理地址(需要时可用): ${proxyAddr}\n</proxy>` : ""

    // 注入全局知识库: 历史任务沉淀的经验直接带入本轮，Agent 无需自行读取
    const knowledge = await loadKnowledge()
    const knowledgeNote = knowledge ? `\n<knowledge>\n${knowledge}\n</knowledge>` : ""

    // 注入 Agent 技能列表(config/skills/*/SKILL.md)，正文经 skill 工具按需查看
    const skills = await agentSkills.list()
    const skillsNote = skills.length ? `\n${skillsListBlock(skills)}` : ""

    const behaviorRules = cfg.agent?.system_prompt || AGENT_SYSTEM
    const systemPrompt = [`<behavior_rules>\n${behaviorRules}\n</behavior_rules>`, `\n<current_date>\n今天是: ${new Date().toISOString().slice(0, 10)}\n</current_date>`, `\n<current_directory>\nshell 命令与文件工具的默认执行/解析目录为: ${process.cwd()},相对路径基于此解析\n</current_directory>`, `\n<workspace>\n任务工作区: ${this.ws.dir}\n</workspace>`, knowledgeNote, skillsNote, proxyNote].filter(Boolean).join("\n")

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: goal,
        ...(initMedia.images?.length ? { images: initMedia.images } : {}),
        ...(initMedia.videos?.length ? { videos: initMedia.videos } : {}),
        ...(initMedia.audios?.length ? { audios: initMedia.audios } : {}),
        ...(initMedia.files?.length ? { files: initMedia.files } : {}),
      },
    ]

    try {
      for (let round = 0; round < maxRounds; round++) {
        // 取消检查
        if (this.status === "cancelled") {
          await this._persist()
          return
        }

        const opts = { stateful: false, model: agentModel, max_tokens: agentMaxTokens, tools: toolDefs, signal: this._abortController.signal, channel: "agent" }
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
            let audios = []
            let files = []
            let tContent
            if (typeof payload === "string") {
              tContent = payload
            } else if (payload?.message) {
              tContent = payload.message
            } else if (payload && typeof payload === "object") {
              if (Array.isArray(payload.images)) images = payload.images
              if (Array.isArray(payload.videos)) videos = payload.videos
              if (Array.isArray(payload.audios)) audios = payload.audios
              if (Array.isArray(payload.files)) files = payload.files
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

            const fnName = res.tool_calls[i]?.function?.name
            messages.push({ role: "tool", content: tContent, images, videos, audios, files, tool_call_id: res.tool_calls[i]?.id || `call_${i}`, name: fnName, signature: res.tool_calls[i]?.signature })
          }

          // 取消
          if (this.status === "cancelled") {
            await this._persist()
            return
          }

          // 最后一轮：强制输出
          if (round === maxRounds - 1) {
            const finalRes = await Bot.aigc.provider.chat(messages, { stateful: false, model: agentModel, tool_choice: "none", tools: toolDefs, signal: this._abortController.signal, channel: "agent" })
            if (finalRes.blocked) {
              this.status = "failed"
              this._result = `[安全策略拦截: ${finalRes.finishReason || "unknown"}]`
              break
            }
            this._result = finalRes.content || "(Agent 执行完毕但未获得结果)"
            this.status = "done"
            break
          }
          continue
        }

        // 文本回复 — Agent 认为任务结束
        this._result = res.content || ""
        if (!this._result) this._result = "(Agent 执行完毕但未获得结果)"
        this.status = "done"
        break
      }
    } catch (err) {
      if (this.status !== "cancelled") {
        this.status = "failed"
        this._result = `[Agent 异常: ${err.message}]`
      }
    }

    // 注入结果回对话
    if (this.status === "done") await this._injectDeliver()
    else if (this.status === "failed" && this._result) await this._injectFailed()
    await this._persist()
    log.info(`[Agent] 任务 ${this.taskId} 结束, status=${this.status}`)
  }

  /** 从外部调用：取消运行 */
  cancel() {
    this.status = "cancelled"
    this._abortController.abort()
  }

  // 结果注入
  async _injectDeliver() {
    // 结果截断，避免超长 Agent 输出膨胀对话上下文/挤占配额
    const result = this._result || "(无结果)"
    const resultText = result.length > 2000 ? result.slice(0, 2000) + `\n…(已截断, 共 ${result.length} 字符)` : result
    try {
      await Bot.aigc.injectMessage({
        self_id: this._selfId,
        user_id: this._userId,
        ...(this._groupId ? { group_id: this._groupId } : {}),
        text: `[Agent 任务结束: ${this.taskId}]\n\n${resultText}`,
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
