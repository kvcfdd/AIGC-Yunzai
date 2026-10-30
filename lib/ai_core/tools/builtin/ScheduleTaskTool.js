import tools from "../tool-registry.js"
import { isMaster } from "../workspace.js"
import { formatDate } from "../../helpers/time.js"

const ACTIONS = new Set(["create", "list", "delete"])

function formatTime(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? formatDate(new Date(n), "compact").slice(0, 16) : "?"
}

function describeTask(row) {
  const when = row.cron ? `cron ${row.cron} / 下次 ${formatTime(row.next_run_at)}` : `一次性 ${formatTime(row.at)}`
  return `- #${row.id} [${when}]: ${String(row.prompt).replace(/\s+/g, " ").slice(0, 100)}`
}

tools.register(
  {
    name: "schedule_task",
    description: "Create, list, or delete scheduled tasks; new tasks fire in the current conversation. When a task fires, its prompt is injected into the AI like a user message and the AI decides how to reply. Use cron for recurring tasks or at for one-shot tasks.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        prompt: { type: "string", description: "Instruction injected when the task fires." },
        cron: { type: "string", description: "5-field cron: minute hour day month weekday (local time)." },
        at: { type: "string", description: "One-shot local time YYYY-MM-DD HH:mm." },
        id: { type: "number", description: "Task id for delete." },
        all: { type: "boolean", description: "Master only: list tasks across conversations." },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const schedule = ctx?.schedule
      if (!schedule) throw new Error("当前运行环境不支持定时任务")

      const event = ctx?.event
      if (!event?.self_id || !event?.user_id) throw new Error("无法确定当前会话")

      const action = String(args?.action || "")
        .trim()
        .toLowerCase()
      if (!ACTIONS.has(action)) throw new Error(`不支持的操作: ${action}`)

      const master = isMaster(ctx)
      const owner = { self_id: String(event.self_id), user_id: String(event.user_id) }
      const groupId = event.isGroup ? String(event.group_id) : null

      if (action === "create") {
        const row = schedule.create({ ...owner, group_id: groupId, prompt: args?.prompt, cron: args?.cron, at: args?.at })
        return `已创建定时任务 #${row.id}，下次执行: ${formatTime(row.next_run_at)}`
      }

      if (action === "list") {
        const rows = schedule.list({ ...owner, all: master && args?.all === true })
        return rows.length ? rows.map(describeTask).join("\n") : "当前没有定时任务。"
      }

      const id = Number(args?.id)
      if (!Number.isInteger(id) || id <= 0) throw new Error("请提供有效的任务 id")
      const row = schedule.get(id)
      if (!row) throw new Error(`任务 #${id} 不存在`)
      const sameOwner = String(row.self_id) === owner.self_id && String(row.user_id) === owner.user_id
      if (!master && !sameOwner) throw new Error("权限不足：只能删除自己的定时任务")
      schedule.remove(id)
      return `已删除定时任务 #${id}`
    },
  },
  { deferred: true },
)
