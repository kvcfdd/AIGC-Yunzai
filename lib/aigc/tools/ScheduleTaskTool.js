import tools from "./registry.js"
import schedule from "node-schedule"
import { execFile } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import cfg from "../../config/config.js"
import log from "../helpers/log.js"

// Redis 持久化层: 定时任务定义存储在 Redis 中，Bot 重启后自动恢复
const REDIS_KEY = "aigc:schedule:tasks"
const MAX_USER_TASKS = 10

/** 定时任务子系统总开关，默认关闭 */
function scheduledTaskEnabled() {
  return cfg.aigc?.scheduled_task?.enable ?? false
}

/** 用户白名单检查: 主人始终可用，白名单用户可用 */
function scheduledTaskUserAllowed(userId, isMaster) {
  if (isMaster) return true
  return (cfg.aigc?.scheduled_task?.qq_whitelist || []).map(String).includes(String(userId))
}

// 脚本型定时任务: 检测脚本存放目录与执行超时
const SCRIPT_DIR = path.resolve("data/aigc/schedule")
const SCRIPT_TIMEOUT_S = 30

/** 执行脚本型任务的检测脚本
 *  返回: 脚本 stdout 或错误信息 → 唤醒主模型;null → 静默不打扰
 *  脚本负责检测(查价/比较/判断), 命中条件才输出, 未命中保持静默
 *  输出截断到 4000 字符, 避免脚本异常输出污染对话历史 */
const MAX_SCRIPT_OUTPUT = 4000
async function runTaskScript(key, script) {
  const scriptFile = await ensureScriptFile(key, script)
  return new Promise(resolve => {
    execFile("node", [scriptFile], { timeout: SCRIPT_TIMEOUT_S * 1000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (err.killed ? `脚本执行超时(${SCRIPT_TIMEOUT_S}s)` : stdout || stderr || `脚本执行失败: ${err.message}`).trim()
        log.warn(`[ScheduleTask] 脚本执行异常: ${key}, ${msg.slice(0, 200)}`)
        return resolve(msg.slice(0, MAX_SCRIPT_OUTPUT))
      }
      const out = String(stdout || "").trim()
      resolve(out ? out.slice(0, MAX_SCRIPT_OUTPUT) : null)
    })
  })
}

/** 确保检测脚本已写入磁盘, 返回文件路径 */
async function ensureScriptFile(key, script) {
  await fsp.mkdir(SCRIPT_DIR, { recursive: true })
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_")
  const file = path.join(SCRIPT_DIR, `${safe}.js`)
  const current = await fsp.readFile(file, "utf-8").catch(() => null)
  if (current !== script) await fsp.writeFile(file, script, "utf-8")
  return file
}

/** 运行中的 node-schedule job 实例 */
const activeJobs = new Map() // key: "userId:taskName" → job

/** 将单个任务写入 Redis Hash */
async function saveTask(key, task) {
  try {
    await redis.hSet(REDIS_KEY, key, JSON.stringify(task))
  } catch (err) {
    log.error(`[ScheduleTask] Redis 写入失败: ${key}, ${err.message}`)
  }
}

/** 从 Redis Hash 删除单个任务, 并清理对应的检测脚本文件 */
async function removeTask(key) {
  try {
    await redis.hDel(REDIS_KEY, key)
  } catch (err) {
    log.error(`[ScheduleTask] Redis 删除失败: ${key}, ${err.message}`)
  }
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_")
  await fsp.unlink(path.join(SCRIPT_DIR, `${safe}.js`)).catch(() => {})
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
    log.error(`[ScheduleTask] Redis 读取失败: ${err.message}`)
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
    // 防重入: 上一次触发未结束时跳过本次
    if (job.running) return
    job.running = true

    try {
      // 脚本型任务: 先执行检测脚本, 仅当脚本有输出时才唤醒主模型
      let text
      if (task.script) {
        const scriptOut = await runTaskScript(key, task.script)
        if (scriptOut === null) return // 未命中, 静默不打扰
        text = `[定时任务触发: ${name}]\n${prompt}\n\n检测结果:\n${scriptOut}`
      } else {
        text = `[定时任务触发: ${name}]\n${prompt}`
      }

      const injectParams = {
        self_id: selfId,
        user_id: userId,
        text,
      }
      if (groupId) injectParams.group_id = groupId

      await Bot.aigc.injectMessage(injectParams)
    } catch (err) {
      if (err.message?.includes("不在线") || err.message?.includes("AIGC 插件尚未加载")) {
        log.warn(`[ScheduleTask] Bot ${selfId} 不在线，任务 "${name}" 触发失败，自动取消`)
        job.cancel()
        activeJobs.delete(key)
        await removeTask(key)
      } else {
        log.error(`[ScheduleTask] 任务 "${name}" 触发异常: ${err.message}`)
      }
    } finally {
      job.running = false
    }
  })

  if (job) {
    activeJobs.set(key, job)
  }

  return job
}

// 启动时从 Redis 恢复所有定时任务
async function restoreTasks() {
  // 总开关关闭时不恢复任务
  if (!scheduledTaskEnabled()) {
    log.info("[ScheduleTask] 定时任务子系统未开启，跳过恢复")
    return
  }
  const tasks = await loadAllTasks()
  if (!tasks.length) return

  let restored = 0
  let skipped = 0

  for (const t of tasks) {
    // 幂等：已在运行的任务跳过
    if (activeJobs.has(t.key)) continue
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
    log.info(`[ScheduleTask] 从 Redis 恢复 ${restored} 个定时任务${skipped > 0 ? `，清理 ${skipped} 个失效任务` : ""}`)
  }
}

// 模块加载时自动恢复
await restoreTasks().catch(err => {
  log.error(`[ScheduleTask] 恢复任务失败: ${err.message}`)
})

// aigc.yaml 热更新时尝试恢复：支持启动时开关关闭、之后热开启的场景
const _prevChangeAigc = cfg.change_aigc
cfg.change_aigc = () => {
  try {
    _prevChangeAigc?.()
  } catch {}
  if (scheduledTaskEnabled()) {
    restoreTasks().catch(err => log.error(`[ScheduleTask] 热更新恢复任务失败: ${err.message}`))
  }
}

// 工具注册
tools.register(
  {
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

trigger_prompt 在任务触发时注入对话，你应以第一人称描述任务背景。
例如: "现在是早上9点，你之前设置了每日早间简报任务。请主动向用户问好并推送今日简报。"

可选 script (仅主人): node 检测脚本。触发时先执行脚本，脚本 stdout 非空才将其内容注入对话唤醒 LLM，适合监控类任务 (脚本负责查价/比较，命中条件才输出，未命中静默零成本)。`,

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
        script: {
          type: "string",
          description: "node 检测脚本 (可选, 仅主人可用)。触发时先执行脚本, stdout 非空时其内容作为检测结果注入对话; stdout 为空则静默不打扰。",
        },
      },
      required: ["action"],
    },

    execute: async (args, ctx) => {
      const { action, name, cron, prompt, script } = args
      const userId = String(ctx.user_id || "unknown")
      const selfId = String(ctx.event?.self_id || "")
      const groupId = ctx.event?.group_id ? String(ctx.event.group_id) : null
      // 任务操作者的权限身份：任务所有者本人或 master
      const isMaster = ctx.event?.isMaster === true

      // 仅主人或白名单用户可调用本工具
      if (!scheduledTaskUserAllowed(userId, isMaster)) {
        return "用户尚未获得bot owner (master)授权，无法使用定时任务子系统！"
      }

      if (action === "list") {
        const all = await loadAllTasks()
        const myTasks = all.filter(t => t.userId === userId)
        if (!myTasks.length) return "你当前没有定时任务。"

        const lines = myTasks.map((t, i) => {
          const job = activeJobs.get(t.key)
          const next = job?.nextInvocation?.()
          const nextStr = next ? `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}` : "已过期"
          return `${i + 1}. "${t.name}" | cron: ${t.cron} | 下次: ${nextStr}${t.script ? " | 脚本" : ""}`
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

        // 脚本型任务会以 bot 进程权限执行任意代码, 仅主人可创建
        if (script && !ctx.event?.isMaster) return "仅主人可创建脚本型定时任务"

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

        const task = { name, cron, prompt, userId, selfId, ...(groupId ? { groupId } : {}), ...(script ? { script } : {}) }

        // 创建 job
        const job = createJob(key, task)
        if (!job) {
          return `无法创建任务 "${name}": cron 表达式 "${cron}" 无效或已过期。`
        }

        // 持久化到 Redis
        await saveTask(key, task)

        const next = job.nextInvocation()
        const nextStr = next ? `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}` : "未知"

        log.info(`[ScheduleTask] ✅ 创建成功: "${name}" | cron=${cron} | 下次触发=${nextStr} | user=${userId}`)

        return `✅ 定时任务 "${name}" 已创建。cron: ${cron}，下次触发: ${nextStr}。任务已持久化，Bot 重启后自动恢复。`
      }

      return `未知操作: ${action}`
    },
  },
  { enabled: scheduledTaskEnabled },
)
