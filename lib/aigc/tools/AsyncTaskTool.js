import tools from "./registry.js"
import { ulid } from "ulid"
import cfg from "../../config/config.js"

// Redis 持久化层: 后台任务状态存储在 Redis，Bot 重启后可查询历史
const REDIS_PREFIX = "aigc:async:"
const TASK_TTL_S = 60 * 60 // 1 小时后自动过期
const MAX_USER_TASKS = 5
const MAX_BG_ROUNDS = 3

/** 后台 LLM 可使用的工具白名单 — 读操作 + 脚本执行，排除会造成副作用的工具 */
const BG_TOOL_ALLOWLIST = new Set(["search", "browse", "query", "fetch_media", "run_script"])

/** 内存缓存: taskId → { status, goal, ... }，运行时查询不穿透 Redis */
const taskCache = new Map()

/** 将任务状态写入 Redis + 更新内存缓存 */
async function saveTask(taskId, entry) {
  taskCache.set(taskId, entry)
  try {
    await redis.set(`${REDIS_PREFIX}${taskId}`, JSON.stringify(entry), { EX: TASK_TTL_S })
  } catch (err) {
    // Redis 写入失败不影响功能
  }
}

/** 读取任务 */
async function getTask(taskId) {
  const cached = taskCache.get(taskId)
  if (cached) return cached

  try {
    const raw = await redis.get(`${REDIS_PREFIX}${taskId}`)
    if (raw) {
      const entry = JSON.parse(raw)
      taskCache.set(taskId, entry) // 回填缓存
      return entry
    }
  } catch {
    /* pass */
  }
  return null
}

// 启动时清理: 将上次 session 残留的 "running" 任务标记为 interrupted
async function cleanupStaleTasks() {
  try {
    const keys = await redis.keys(`${REDIS_PREFIX}*`)
    let cleaned = 0
    for (const key of keys) {
      const raw = await redis.get(key)
      if (!raw) continue
      try {
        const task = JSON.parse(raw)
        if (task.status === "running") {
          task.status = "interrupted"
          task.result = "[Bot 重启，任务丢失]"
          task.completedAt = Date.now()
          await redis.set(key, JSON.stringify(task), { EX: TASK_TTL_S })
          cleaned++
        }
      } catch {
        /* parse error, skip */
      }
    }
    if (cleaned > 0) {
      Bot.makeLog("info", `[AsyncTask] 清理 ${cleaned} 个因重启丢失的运行中任务`)
    }
  } catch {}
}
cleanupStaleTasks()

// 后台任务执行器: mini LLM loop
async function runBackgroundTask(taskId, entry) {
  const { goal, context, userId, selfId, groupId } = entry

  const systemPrompt = ["你是一个后台任务助手。用户提交了一个后台任务给你，请在后台完成它。", "你可以使用搜索、浏览网页、查询数据等工具来完成任务。", "完成后，请直接输出任务结果。不要输出 no_reply 或空内容。", context ? `\n任务相关上下文:\n${context}` : ""].filter(Boolean).join("\n")

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: goal },
  ]

  const toolDefs = Bot.aigc.tools.getDefinitions().filter(d => BG_TOOL_ALLOWLIST.has(d.function?.name))
  let finalResult = ""
  let failed = false

  const bgModel = cfg.aigc?.gemini?.secondary_model || cfg.aigc?.gemini?.model || undefined

  try {
    for (let round = 0; round < MAX_BG_ROUNDS; round++) {
      const opts = {
        stateful: false,
        ...(toolDefs.length ? { tools: toolDefs, tool_choice: "auto" } : {}),
        ...(bgModel ? { model: bgModel } : {}),
      }

      const res = await Bot.aigc.provider.chat(messages, opts)

      if (res.blocked) {
        finalResult = `[任务被安全策略拦截: ${res.finishReason}]`
        failed = true
        break
      }

      if (res.tool_calls?.length) {
        messages.push({ role: "assistant", content: res.content || null, tool_calls: res.tool_calls })

        const bgCtx = { user_id: userId }
        const results = await Promise.all(
          res.tool_calls.map(async tc => {
            const fnName = tc?.function?.name
            if (!fnName) return { name: "unknown", error: "missing function.name" }
            let args = {}
            try {
              args = JSON.parse(tc?.function?.arguments || "{}")
            } catch {
              /* pass */
            }
            try {
              return await Bot.aigc.tools.execute(fnName, args, bgCtx)
            } catch (err) {
              return { name: fnName, error: err?.message || String(err) }
            }
          }),
        )

        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const payload = r.error || r.result
          const tContent = typeof payload === "string" ? payload : payload?.message || JSON.stringify(payload ?? "")
          messages.push({
            role: "tool",
            content: tContent,
            tool_call_id: res.tool_calls[i]?.id || `call_${i}`,
            name: res.tool_calls[i]?.function?.name,
          })
        }

        if (round === MAX_BG_ROUNDS - 1) {
          const finalOpts = { stateful: false, tool_choice: "none", ...(bgModel ? { model: bgModel } : {}) }
          if (toolDefs.length) finalOpts.tools = toolDefs
          const finalRes = await Bot.aigc.provider.chat(messages, finalOpts)
          finalResult = finalRes.content || ""
        }
        continue
      }

      finalResult = res.content || ""
      break
    }

    if (!finalResult && !failed) {
      finalResult = "(后台任务执行完毕但未获得结果)"
    }
  } catch (err) {
    finalResult = `[后台任务执行失败: ${err.message}]`
    failed = true
  }

  const updated = {
    ...entry,
    status: failed ? "failed" : "done",
    result: finalResult,
    completedAt: Date.now(),
  }
  await saveTask(taskId, updated)

  // 注入结果唤醒 LLM
  try {
    await Bot.aigc.injectMessage({
      self_id: selfId,
      user_id: userId,
      ...(groupId ? { group_id: groupId } : {}),
      text: `[后台任务完成: ${taskId}]\n任务目标: ${goal.slice(0, 100)}${goal.length > 100 ? "..." : ""}\n\n执行结果:\n${finalResult}`,
    })
  } catch (err) {
    Bot.makeLog("warn", `[AsyncTask] 无法注入结果到用户 ${userId}，任务 ${taskId} 结果已存储待查询`)
  }
}

// 工具注册
tools.register({
  name: "async_task",
  description: `提交/查看/取消后台异步任务。任务状态持久化到 Redis，Bot 重启后仍可查询。

使用流程:
1. submit 提交任务 → 获得 task_id → 告诉用户"任务已开始处理"
2. 后台执行 (可搜索、浏览网页)，完成后主动通知用户
3. 用户也可随时询问，你调用 check 查看进度

每个用户最多 ${MAX_USER_TASKS} 个并发任务。Bot 重启后，正在运行的任务会丢失(标记为 interrupted)，但已完成/失败的任务仍可查询。`,

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
        description: "任务目标描述 (submit 必填)。如'搜索最近3天的AI新闻，整理成简报'",
      },
      context: {
        type: "string",
        description: "相关上下文 (submit 可选)。如当前对话摘要、用户偏好等",
      },
      task_id: {
        type: "string",
        description: "任务 ID (check/cancel 必填)",
      },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, goal, context, task_id } = args
    const userId = String(ctx.user_id || "unknown")
    const selfId = String(ctx.event?.self_id || "")
    const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null

    if (action === "check") {
      if (!task_id) return "请提供任务 ID"
      const task = await getTask(task_id)
      if (!task) return `未找到任务 ${task_id}。可能已过期、被取消或 Bot 重启导致运行中任务丢失。`
      return `任务 ${task_id}\n状态: ${task.status}\n目标: ${(task.goal || "").slice(0, 200)}\n${task.result ? `结果: ${task.result.slice(0, 800)}` : "暂无结果"}`
    }

    if (action === "cancel") {
      if (!task_id) return "请提供任务 ID"
      const task = await getTask(task_id)
      if (!task) return `未找到任务 ${task_id}。`
      if (task.status !== "running") return `任务 ${task_id} 状态为 ${task.status}，无需取消。`
      await saveTask(task_id, { ...task, status: "cancelled", completedAt: Date.now() })
      return `任务 ${task_id} 已取消。`
    }

    if (action === "submit") {
      if (!goal) return "请提供任务目标 (goal)"

      // 检查并发数
      let running = 0
      for (const [, t] of taskCache) {
        if (t.userId === userId && t.status === "running") running++
      }
      // 也检查 Redis 中是否有当前 session 遗留的 running 任务
      try {
        const keys = await redis.keys(`${REDIS_PREFIX}*`)
        for (const key of keys) {
          const id = key.slice(REDIS_PREFIX.length)
          if (taskCache.has(id)) continue // 已在缓存中统计过
          const raw = await redis.get(key)
          if (!raw) continue
          try {
            const t = JSON.parse(raw)
            if (t.userId === userId && t.status === "running") {
              // 残留的 running 任务，标记为 interrupted
              await redis.set(key, JSON.stringify({ ...t, status: "interrupted", result: "[会话丢失]", completedAt: Date.now() }), { EX: TASK_TTL_S })
            }
          } catch {
            /* pass */
          }
        }
      } catch {}

      if (running >= MAX_USER_TASKS) {
        return `你已有 ${MAX_USER_TASKS} 个后台任务正在运行，请等待部分完成后再提交。`
      }

      const taskId = ulid()
      const entry = {
        status: "running",
        goal,
        context: context || "",
        userId,
        selfId,
        ...(groupId ? { groupId } : {}),
        createdAt: Date.now(),
        result: null,
      }
      await saveTask(taskId, entry)

      // 分离执行
      runBackgroundTask(taskId, entry).catch(err => {
        Bot.makeLog("error", [`[AsyncTask] 后台任务 ${taskId} 异常`, err])
        saveTask(taskId, { ...entry, status: "failed", result: `执行异常: ${err.message}`, completedAt: Date.now() })
      })

      return {
        deferred: true,
        task_id: taskId,
        message: `后台任务已提交 (ID: ${taskId})，正在执行中。目标: ${goal.slice(0, 150)}${goal.length > 150 ? "..." : ""}。完成后我会主动通知你。`,
      }
    }

    return `未知操作: ${action}`
  },
})
