import tools from "./registry.js"
import schedule from "node-schedule"

// Redis 持久化层: 定时任务定义存储在 Redis 中，Bot 重启后自动恢复
const REDIS_KEY = "aigc:schedule:tasks"
const MAX_USER_TASKS = 10

/** 运行中的 node-schedule job 实例 */
const activeJobs = new Map() // key: "userId:taskName" → job

/** 将单个任务写入 Redis Hash */
async function saveTask(key, task) {
  try {
    await redis.hSet(REDIS_KEY, key, JSON.stringify(task))
  } catch (err) {
    Bot.makeLog("error", [`[ScheduleTask] Redis 写入失败: ${key}`, err.message])
  }
}

/** 从 Redis Hash 删除单个任务 */
async function removeTask(key) {
  try {
    await redis.hDel(REDIS_KEY, key)
  } catch (err) {
    Bot.makeLog("error", [`[ScheduleTask] Redis 删除失败: ${key}`, err.message])
  }
}

/** 读取所有持久化任务 */
async function loadAllTasks() {
  try {
    const all = await redis.hGetAll(REDIS_KEY)
    return Object.entries(all || {})
      .map(([key, json]) => {
        try {
          return { key, ...JSON.parse(json) }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    Bot.makeLog("error", [`[ScheduleTask] Redis 读取失败`, err.message])
    return []
  }
}

/** 为用户创建一个 cron job 并注册到 activeJobs */
function createJob(key, task) {
  const { name, cron, prompt, userId, selfId, groupId } = task

  const job = schedule.scheduleJob(cron.trim().split(/\s+/).slice(0, 6).join(" "), async () => {
    // 回调中重新检查 — 任务可能在两次触发之间被用户取消了
    if (!activeJobs.has(key)) {
      job.cancel()
      return
    }

    try {
      const injectParams = {
        self_id: selfId,
        user_id: userId,
        text: `[定时任务触发: ${name}]\n${prompt}`,
      }
      if (groupId) injectParams.group_id = groupId

      await Bot.aigc.injectMessage(injectParams)
    } catch (err) {
      if (err.message?.includes("不在线") || err.message?.includes("AIGC 插件尚未加载")) {
        Bot.makeLog("warn", `[ScheduleTask] Bot ${selfId} 不在线，任务 "${name}" 触发失败，自动取消`)
        job.cancel()
        activeJobs.delete(key)
        await removeTask(key)
      } else {
        Bot.makeLog("error", [`[ScheduleTask] 任务 "${name}" 触发异常`, err.message])
      }
    }
  })

  if (job) {
    activeJobs.set(key, job)
  }

  return job
}

// 启动时从 Redis 恢复所有定时任务
async function restoreTasks() {
  const tasks = await loadAllTasks()
  if (!tasks.length) return

  let restored = 0
  let skipped = 0

  for (const t of tasks) {
    const job = createJob(t.key, t)
    if (job) {
      restored++
    } else {
      // cron 表达式已失效，清理持久化
      await removeTask(t.key)
      skipped++
    }
  }

  if (restored > 0 || skipped > 0) {
    Bot.makeLog("info", `[ScheduleTask] 从 Redis 恢复 ${restored} 个定时任务${skipped > 0 ? `，清理 ${skipped} 个失效任务` : ""}`)
  }
}

// 模块加载时自动恢复
restoreTasks().catch(err => {
  Bot.makeLog("error", [`[ScheduleTask] 恢复任务失败`, err.message])
})

// 工具注册
tools.register({
  name: "schedule_task",
  description: `创建/查看/取消定时任务。任务持久化到 Redis，Bot 重启后自动恢复。

cron 表达式: 5 个字段，空格分隔: "分 时 日 月 星期"
  - 分: 0-59
  - 时: 0-23
  - 日: 1-31
  - 月: 1-12
  - 星期: 0-6 (0=周日)
  - 例: "0 9 * * *" = 每天早上 9 点
  - 例: "*/30 * * * *" = 每 30 分钟
  - 例: "0 12 * * 1-5" = 工作日中午 12 点

trigger_prompt 在任务触发时作为系统消息注入对话，你应以第一人称描述任务背景。
例如: "现在是早上9点，你之前设置了每日早间简报任务。请主动向用户问好并推送今日简报。"`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "cancel"],
        description: "操作类型: create=创建, list=列出所有, cancel=取消",
      },
      name: {
        type: "string",
        description: "任务名称 (create/cancel 时必填)，唯一标识",
      },
      cron: {
        type: "string",
        description: "cron 表达式 (create 时必填)。5 字段: 分 时 日 月 星期",
      },
      prompt: {
        type: "string",
        description: "触发 prompt (create 时必填)。注入对话的完整文本，第一人称描述上下文。",
      },
    },
    required: ["action"],
  },

  execute: async (args, ctx) => {
    const { action, name, cron, prompt } = args
    const userId = String(ctx.user_id || "unknown")
    const selfId = String(ctx.event?.self_id || "")
    const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null

    if (action === "list") {
      const all = await loadAllTasks()
      const myTasks = all.filter(t => t.userId === userId)
      if (!myTasks.length) return "你当前没有定时任务。"

      const lines = myTasks.map((t, i) => {
        const job = activeJobs.get(t.key)
        const next = job?.nextInvocation?.()
        const nextStr = next ? `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}` : "已过期"
        return `${i + 1}. "${t.name}" | cron: ${t.cron} | 下次: ${nextStr}`
      })

      return `你的定时任务列表 (共 ${myTasks.length}/${MAX_USER_TASKS} 个):\n${lines.join("\n")}`
    }

    if (action === "cancel") {
      if (!name) return "请提供要取消的任务名称"
      const key = `${userId}:${name}`

      // 取消运行中的 job
      const job = activeJobs.get(key)
      if (job) {
        job.cancel()
        activeJobs.delete(key)
      }

      // 从 Redis 删除
      const all = await loadAllTasks()
      const exists = all.find(t => t.key === key)
      if (!exists && !job) return `未找到名为 "${name}" 的定时任务。`
      await removeTask(key)

      return `定时任务 "${name}" 已取消。`
    }

    if (action === "create") {
      if (!name || !cron || !prompt) return "缺少必填参数: name, cron, prompt"

      const key = `${userId}:${name}`

      // 检查用户任务数上限
      const all = await loadAllTasks()
      const myTasks = all.filter(t => t.userId === userId && t.key !== key)
      if (myTasks.length >= MAX_USER_TASKS) {
        return `你已达到定时任务数上限 (${MAX_USER_TASKS}个)。请先取消不需要的任务再创建。`
      }

      // 取消同名旧任务
      const oldJob = activeJobs.get(key)
      if (oldJob) {
        oldJob.cancel()
        activeJobs.delete(key)
      }

      // 校验 cron 格式
      const cronFields = cron.trim().split(/\s+/)
      if (cronFields.length < 5) return `cron 格式错误: "${cron}"。需要 5 个字段: 分 时 日 月 星期`

      const task = { name, cron, prompt, userId, selfId, ...(groupId ? { groupId } : {}) }

      // 创建 job
      const job = createJob(key, task)
      if (!job) {
        return `无法创建任务 "${name}": cron 表达式 "${cron}" 无效或已过期。`
      }

      // 持久化到 Redis
      await saveTask(key, task)

      const next = job.nextInvocation()
      const nextStr = next ? `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}` : "未知"

      Bot.makeLog("info", `[ScheduleTask] ✅ 创建成功: "${name}" | cron=${cron} | 下次触发=${nextStr} | user=${userId}`)

      return `✅ 定时任务 "${name}" 已创建。cron: ${cron}，下次触发: ${nextStr}。任务已持久化，Bot 重启后自动恢复。`
    }

    return `未知操作: ${action}`
  },
})
