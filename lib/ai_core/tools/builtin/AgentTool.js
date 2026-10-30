import tools from "../tool-registry.js"
import { runToolLoop } from "../../core/tool-loop.js"
import { resolveModelConfig } from "../../llm/model-config.js"
import { INJECT_SOURCE } from "../../perception/injected-event.js"
import log from "../../helpers/log.js"

const MAX_ROUNDS = 12
const SYNC_TIMEOUT_MS = 300_000
const BACKGROUND_TIMEOUT_MS = 600_000
const MAX_RESULT = 8000
const MAX_INJECT = 4000
const MAX_BACKGROUND_PER_USER = 3
/** 会话/用户交互、工具加载、记忆与 agent 自身都不交给子代理 */
export const EXCLUDED_TOOLS = new Set(["agent", "send_media", "interact_user", "group_admin", "block_user", "schedule_task", "tool_search", "memory_search", "memory_update"])

const DEFAULT_SYSTEM_PROMPT = "You are a subagent working on a delegated task. Use the available tools when needed, then return a concise final answer. Your output goes back to the caller; do not address the end user directly."

/** 正在运行的后台子代理计数（按 self_id:user_id） */
const running = new Map()

function clip(text, max) {
  const s = String(text ?? "")
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 子代理工具视图：只暴露调用方指定的工具；deferred 工具通过预置 activeTools 直接注入 */
function subToolset(parent, allowed) {
  return {
    getDefinitions: (_, { activeTools } = {}) =>
      parent.getDefinitions(undefined, { activeTools }).filter(def => {
        const name = def.function?.name
        return !!name && !EXCLUDED_TOOLS.has(name) && activeTools?.has(name)
      }),
    execute: (name, args, ctx) => {
      if (EXCLUDED_TOOLS.has(name)) return { name, error: `Tool ${name} is not available to subagents` }
      if (!ctx?.activeTools?.has(name)) return { name, error: `Tool ${name} is not available to this subagent` }
      return parent.execute(name, args, ctx)
    },
  }
}

/** 后台结果注入；Bot 不在线时短暂等待重试 */
async function deliverResult(ctx, event, text) {
  if (typeof ctx?.injectMessage !== "function") {
    log.warn("后台 Agent 结果无法注入：缺少 injectMessage")
    return
  }
  const online = () => !!ctx.bot?.bots?.[String(event?.self_id)]
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!online()) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 60_000)
        timer.unref?.()
      })
      continue
    }
    try {
      await ctx.injectMessage({ self_id: event.self_id, user_id: event.user_id, group_id: event.group_id, text, source: INJECT_SOURCE.AGENT })
    } catch (err) {
      log.warn(`后台 Agent 结果注入失败: ${err.message}`)
    }
    return
  }
  log.warn("后台 Agent 结果注入失败：Bot 不在线")
}

tools.register(
  {
    name: "agent",
    description: "Run a subagent as a worker for the caller with its own fresh context and a caller-defined prompt/tool set. Conversation/user-facing, tool-loading, and memory tools cannot be delegated. Returns its final answer; background=true wakes this conversation when done.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task for the subagent." },
        system_prompt: { type: "string", description: "Optional role/instructions for the subagent." },
        tools: { type: "array", items: { type: "string" }, description: "Tool names to give the subagent; deferred tools are injected directly." },
        background: { type: "boolean", description: "Run in the background and wake this conversation with the result." },
      },
      required: ["prompt"],
    },
    execute: async (args, ctx) => {
      const prompt = String(args?.prompt ?? "").trim()
      if (!prompt) throw new Error("prompt 不能为空")

      const parentTools = ctx?.tools
      if (!parentTools) throw new Error("当前运行环境不支持子代理")

      const requested = Array.isArray(args?.tools) ? [...new Set(args.tools.map(String))] : []
      for (const name of requested) {
        if (EXCLUDED_TOOLS.has(name)) throw new Error(`工具 ${name} 不能交给子代理`)
        if (!parentTools.tools?.has(name)) throw new Error(`未知工具: ${name}`)
      }

      const systemPrompt = String(args?.system_prompt ?? "").trim() || DEFAULT_SYSTEM_PROMPT
      const modelConfig = resolveModelConfig({}, ctx.config?.aigc || {})
      const hasSkills = typeof ctx.skills?.list === "function" ? (await ctx.skills.list()).some(skill => !skill.masterOnly || ctx.event?.isMaster) : false
      const services = {
        config: ctx.config,
        memory: ctx.memory,
        provider: ctx.llm,
        tools: parentTools,
        schedule: ctx.schedule,
        skills: ctx.skills,
        redis: ctx.redis,
        logger: ctx.logger,
        bot: ctx.bot,
        injectMessage: ctx.injectMessage,
      }
      const subTools = subToolset(parentTools, requested)
      const run = signal =>
        runToolLoop({
          provider: ctx.llm,
          tools: subTools,
          toolServices: services,
          event: ctx.event,
          userMessages: [{ role: "user", content: prompt }],
          history: [],
          systemPrompt,
          maxRounds: MAX_ROUNDS,
          channel: "agent",
          modelConfig,
          signal,
          hasSkills,
          activeTools: new Set(requested),
        })

      if (!args?.background) {
        const timeout = AbortSignal.timeout(SYNC_TIMEOUT_MS)
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
        log.info(`Agent 任务开始: ${prompt.slice(0, 80)}`)
        const result = await run(signal)
        log.info(`Agent 任务完成: ${prompt.slice(0, 80)}`)
        if (result?.type !== "text") throw new Error(`子代理结束状态: ${result?.type || "unknown"}`)
        return clip(result.res?.content || "", MAX_RESULT)
      }

      const key = `${ctx.event?.self_id || ""}:${ctx.event?.user_id || ""}`
      const count = running.get(key) || 0
      if (count >= MAX_BACKGROUND_PER_USER) throw new Error(`后台子代理数量已达上限 ${MAX_BACKGROUND_PER_USER}`)
      running.set(key, count + 1)
      log.info(`Agent 后台任务开始: ${prompt.slice(0, 80)}`)

      ;(async () => {
        let text
        try {
          const result = await run(AbortSignal.timeout(BACKGROUND_TIMEOUT_MS))
          const body = result?.type === "text" ? result.res?.content : `结束状态: ${result?.type || "unknown"}`
          text = `[后台 Agent 任务完成]\n任务: ${clip(prompt, 200)}\n结果:\n${clip(body, MAX_INJECT)}`
        } catch (err) {
          text = `[后台 Agent 任务失败]\n任务: ${clip(prompt, 200)}\n原因: ${err.message}`
        } finally {
          running.set(key, Math.max((running.get(key) || 1) - 1, 0))
        }
        await deliverResult(ctx, ctx.event, text)
        log.info(`Agent 后台任务完成: ${prompt.slice(0, 80)}`)
      })()

      return "已启动后台 Agent 任务，完成后会唤醒当前对话。"
    },
  },
  { deferred: true },
)
