import tools from "../tool-registry.js"
import { runToolLoop } from "../../core/tool-loop.js"
import { resolveModelConfig } from "../../llm/model-config.js"
import { INJECT_SOURCE } from "../../perception/injected-event.js"
import log from "../../helpers/log.js"

const MAX_ROUNDS = 50
const SYNC_TIMEOUT_MS = 300_000
const BACKGROUND_TIMEOUT_MS = 30 * 60 * 1000
const MAX_RESULT = 8000
const MAX_INJECT = 4000
const MAX_BACKGROUND_PER_USER = 3
/** 会话/用户交互、记忆与 agent 自身都不交给子代理 */
export const EXCLUDED_TOOLS = new Set(["agent", "interact_user", "group_admin", "block_user", "schedule_task", "memory_search", "memory_update"])

const DEFAULT_SYSTEM_PROMPT = "You are a subagent working on a delegated task. Use the available tools when needed, then return a concise final answer. Your output goes back to the caller; do not address the end user directly."

/** 正在运行的后台子代理计数（按 self_id:user_id） */
const running = new Map()
const SYNC_TIMEOUT = Symbol("sync_timeout")

function clip(text, max) {
  const s = String(text ?? "")
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 子代理工具视图：除禁传工具外全部暴露 */
function subToolset(parent) {
  return {
    getDefinitions: () =>
      parent.getDefinitions().filter(def => {
        const name = def.function?.name
        return !!name && !EXCLUDED_TOOLS.has(name)
      }),
    execute: (name, args, ctx) => {
      if (EXCLUDED_TOOLS.has(name)) return { name, error: `Tool ${name} is not available to subagents` }
      if (name === "media" && String(args?.action || "").toLowerCase() === "send") return { name, error: "media action=send is not available to subagents" }
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

/** 等待同步子代理；超时返回 SYNC_TIMEOUT，不中止子代理本身 */
function waitForSync(promise, ms) {
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(SYNC_TIMEOUT), ms)
    timer.unref?.()
  })
  const waited = promise.then(
    result => ({ result }),
    error => ({ error }),
  )
  return Promise.race([waited, timeout]).finally(() => clearTimeout(timer))
}

/** 后台收尾：结果/失败 → 注入 → 计数递减 */
async function settleBackground(ctx, event, key, runPromise, prompt) {
  let text
  try {
    const result = await runPromise
    const body = result?.type === "text" ? result.res?.content : `结束状态: ${result?.type || "unknown"}`
    text = `[后台 Agent 任务完成]\n任务: ${clip(prompt, 200)}\n结果:\n${clip(body, MAX_INJECT)}`
  } catch (err) {
    // 随父轮结束取消时不注入失败信息，避免无意义唤醒
    if (err?.name === "AbortError" && ctx.signal?.aborted) {
      log.info(`Agent 后台任务已随对话打断取消: ${prompt.slice(0, 80)}`)
      return
    }
    text = `[后台 Agent 任务失败]\n任务: ${clip(prompt, 200)}\n原因: ${err.message}`
  } finally {
    running.set(key, Math.max((running.get(key) || 1) - 1, 0))
  }
  await deliverResult(ctx, event, text)
  log.info(`Agent 后台任务完成: ${prompt.slice(0, 80)}`)
}

tools.register({
  name: "agent",
  description:
    "Run a subagent with a fresh, isolated context to complete a self-contained task and return its final answer to you (not the user). The subagent can use every tool except `agent`, `interact_user`, `group_admin`, `block_user`, `schedule_task`, `memory_search`, and `memory_update` (`media` is load-only), and up to 50 tool rounds. It cannot see this conversation or talk to the user, so include all necessary context in `prompt`/`system_prompt`. Use it for independent tasks that can run in parallel, or long tool-heavy work whose intermediate output should stay out of this conversation; don't use it for simple tasks, anything needing user confirmation/interaction, or tasks that depend on this conversation's history. With background=true the result is injected back into this conversation; background runs are capped at 30 minutes, and a synchronous run over 5 minutes is automatically moved to the background.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Task for the subagent. Include all context it needs; it cannot see this conversation." },
      system_prompt: { type: "string", description: "Optional role/instructions for the subagent, including output format and constraints." },
      background: { type: "boolean", description: "Run in the background: return immediately and inject the result into this conversation when done (capped at 30 minutes)." },
    },
    required: ["prompt"],
  },
  execute: async (args, ctx) => {
    const prompt = String(args?.prompt ?? "").trim()
    if (!prompt) throw new Error("prompt 不能为空")

    const parentTools = ctx?.tools
    if (!parentTools) throw new Error("当前运行环境不支持子代理")

    const systemPrompt = String(args?.system_prompt ?? "").trim() || DEFAULT_SYSTEM_PROMPT
    const modelConfig = resolveModelConfig(ctx.config?.aigc?.agent || {}, ctx.config?.aigc || {})
    const hasSkills = typeof ctx.skills?.list === "function" ? (await ctx.skills.list()).length > 0 : false
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
    const subTools = subToolset(parentTools)
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
        contextCompaction: { isMaster: true },
      })

    const key = `${ctx.event?.self_id || ""}:${ctx.event?.user_id || ""}`
    const totalTimeoutMs = args?.background ? BACKGROUND_TIMEOUT_MS : SYNC_TIMEOUT_MS + BACKGROUND_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(totalTimeoutMs)
    const runSignal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal

    if (!args?.background) {
      log.info(`Agent 任务开始: ${prompt.slice(0, 80)}`)
      const runPromise = run(runSignal)
      const outcome = await waitForSync(runPromise, SYNC_TIMEOUT_MS)

      if (outcome === SYNC_TIMEOUT) {
        running.set(key, (running.get(key) || 0) + 1)
        log.info(`Agent 同步任务超过 ${SYNC_TIMEOUT_MS / 1000} 秒，转入后台: ${prompt.slice(0, 80)}`)
        settleBackground(ctx, ctx.event, key, runPromise, prompt).catch(err => log.warn(`Agent 后台任务收尾失败: ${err.message}`))
        return `子代理超过 ${SYNC_TIMEOUT_MS / 1000} 秒仍未完成，已转入后台；完成后会唤醒当前对话。`
      }

      if (outcome.error) throw outcome.error
      log.info(`Agent 任务完成: ${prompt.slice(0, 80)}`)
      if (outcome.result?.type !== "text") throw new Error(`子代理结束状态: ${outcome.result?.type || "unknown"}`)
      return clip(outcome.result.res?.content || "", MAX_RESULT)
    }

    const count = running.get(key) || 0
    if (count >= MAX_BACKGROUND_PER_USER) throw new Error(`后台子代理数量已达上限 ${MAX_BACKGROUND_PER_USER}`)
    running.set(key, count + 1)
    log.info(`Agent 后台任务开始: ${prompt.slice(0, 80)}`)
    settleBackground(ctx, ctx.event, key, run(runSignal), prompt).catch(err => log.warn(`Agent 后台任务收尾失败: ${err.message}`))
    return "已启动后台 Agent 任务，完成后会唤醒当前对话。"
  },
})
