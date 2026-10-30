import nodeSchedule from "node-schedule"
import cfg from "../config.js"
import db, { DEFAULT_FILE } from "../../db.js"
import log from "../helpers/log.js"
import { formatDate } from "../helpers/time.js"
import { INJECT_SOURCE } from "../perception/injected-event.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aigc_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  self_id     TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  group_id    TEXT,
  prompt      TEXT    NOT NULL,
  cron        TEXT,
  at          INTEGER,
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER
);
CREATE INDEX IF NOT EXISTS aigc_schedule_next ON aigc_schedule (next_run_at);
`

const MAX_PER_OWNER = 10
const MAX_TOTAL = 500
const MAX_PROMPT = 1000
/** 注入文本前缀 —— 让落盘历史也能直接看出这是一次定时任务触发 */
const SCHEDULE_PREFIX = "[定时任务]"
/** 一次性任务错过后的补执行窗口 */
const ONE_SHOT_GRACE_MS = 24 * 3600 * 1000
/** Bot 不在线时一次性任务推迟重试 */
const OFFLINE_RETRY_MS = 10 * 60 * 1000
/** 启动时已过期的一次性任务延迟执行，等 Bot 上线 */
const OVERDUE_DELAY_MS = 5 * 1000

/** 解析本地时间 YYYY-MM-DD HH:mm[:ss] */
export function parseAt(input) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(input ?? "").trim())
  if (!match) throw new Error("at 格式应为 YYYY-MM-DD HH:mm")
  const [, ys, mos, ds, hs, mis, ss] = match
  const [y, mo, d, h, mi] = [ys, mos, ds, hs, mis].map(Number)
  const sec = ss == null ? 0 : Number(ss)
  const date = new Date(y, mo - 1, d, h, mi, sec, 0)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== sec) {
    throw new Error("at 不是有效时间")
  }
  if (date.getTime() <= Date.now()) throw new Error("at 必须晚于当前时间")
  return date
}

/** 校验 5 段 cron 表达式，返回规范化后的字符串 */
export function validateCron(input) {
  const expr = String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
  if (expr.split(" ").length !== 5) throw new Error("cron 必须是 5 段：分 时 日 月 周")
  let probe
  try {
    probe = nodeSchedule.scheduleJob(expr, () => {})
    if (!probe?.nextInvocation()) throw new Error("无可执行时间")
  } catch (err) {
    probe?.cancel?.()
    throw new Error(`无效的 cron 表达式: ${err.message}`)
  }
  probe.cancel()
  return expr
}

/** 定时任务存储 + 调度 — 持久化在 SQLite，触发时通过注入器唤醒对话流程 */
export class ScheduleStore {
  constructor() {
    this._db = null
    this._inject = null
    this._ready = false
    this._jobs = new Map()
  }

  async init({ inject, database } = {}) {
    if (this._ready) return
    if (typeof inject === "function") this._inject = inject
    this._db = database || db.open(cfg.db?.storage || DEFAULT_FILE)
    this._db.exec(SCHEMA)
    this._ready = true

    for (const row of this._db.prepare("SELECT * FROM aigc_schedule").all()) {
      try {
        this._schedule(row)
      } catch (err) {
        log.error(`定时任务 #${row.id} 恢复失败: ${err.message}`)
      }
    }
  }

  _open() {
    if (this._db) return this._db
    this._db = db.open(cfg.db?.storage || DEFAULT_FILE)
    this._db.exec(SCHEMA)
    return this._db
  }

  create({ self_id, user_id, group_id, prompt, cron, at }) {
    const promptText = String(prompt ?? "").trim()
    if (!promptText) throw new Error("prompt 不能为空")
    if (promptText.length > MAX_PROMPT) throw new Error(`prompt 不能超过 ${MAX_PROMPT} 字符`)
    const hasCron = cron != null && String(cron).trim() !== ""
    const hasAt = at != null && String(at).trim() !== ""
    if (hasCron === hasAt) throw new Error("cron 与 at 必须二选一")

    const d = this._open()
    const ownerCount = d.prepare("SELECT COUNT(*) AS n FROM aigc_schedule WHERE self_id = ? AND user_id = ?").get(String(self_id), String(user_id)).n
    if (ownerCount >= MAX_PER_OWNER) throw new Error(`每个用户最多 ${MAX_PER_OWNER} 个定时任务`)
    const total = d.prepare("SELECT COUNT(*) AS n FROM aigc_schedule").get().n
    if (total >= MAX_TOTAL) throw new Error(`定时任务总数已达上限 ${MAX_TOTAL}`)

    const cronExpr = hasCron ? validateCron(cron) : null
    const when = hasAt ? parseAt(at).getTime() : null
    const info = d.prepare("INSERT INTO aigc_schedule (self_id, user_id, group_id, prompt, cron, at, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(String(self_id), String(user_id), group_id ? String(group_id) : null, promptText, cronExpr, when, Date.now(), when)

    const row = this.get(Number(info.lastInsertRowid))
    try {
      this._schedule(row)
    } catch (err) {
      this._deleteRow(row.id)
      throw err
    }
    return this.get(row.id)
  }

  list({ self_id, user_id, all = false } = {}) {
    const d = this._open()
    if (all) return d.prepare("SELECT * FROM aigc_schedule ORDER BY id").all()
    return d.prepare("SELECT * FROM aigc_schedule WHERE self_id = ? AND user_id = ? ORDER BY id").all(String(self_id), String(user_id))
  }

  get(id) {
    return this._open().prepare("SELECT * FROM aigc_schedule WHERE id = ?").get(id) || null
  }

  remove(id) {
    if (!this.get(id)) return false
    this._deleteRow(id)
    return true
  }

  shutdown() {
    for (const job of this._jobs.values()) job?.cancel?.()
    this._jobs.clear()
    this._ready = false
  }

  _schedule(row) {
    const id = Number(row.id)
    if (row.cron) {
      const job = nodeSchedule.scheduleJob(row.cron, () => {
        this._fireSafely(id)
      })
      if (!job) throw new Error("无效的 cron 表达式")
      this._jobs.set(id, job)
      this._setNext(id, job.nextInvocation()?.getTime() ?? null)
      return
    }

    let when = Number(row.at)
    if (!Number.isFinite(when)) throw new Error("任务时间无效")
    const now = Date.now()
    if (when <= now) {
      if (now - when > ONE_SHOT_GRACE_MS) {
        this._deleteRow(id)
        return
      }
      when = now + OVERDUE_DELAY_MS
      this._open().prepare("UPDATE aigc_schedule SET at = ?, next_run_at = ? WHERE id = ?").run(when, when, id)
    }
    const job = nodeSchedule.scheduleJob(new Date(when), () => {
      this._fireSafely(id)
    })
    this._jobs.set(id, job)
    this._setNext(id, when)
  }

  _fireSafely(id) {
    this._fire(id).catch(err => log.error(`定时任务 #${id} 调度异常: ${err.message}`))
  }

  async _fire(id) {
    const row = this.get(id)
    if (!row) {
      this._cancel(id)
      return
    }

    if (!globalThis.Bot?.bots?.[String(row.self_id)]) {
      if (row.cron) this._setNext(id, this._jobs.get(id)?.nextInvocation()?.getTime() ?? null)
      else this._deferOneShot(row)
      return
    }

    try {
      if (typeof this._inject === "function") {
        await this._inject({ self_id: row.self_id, user_id: row.user_id, group_id: row.group_id || undefined, text: `${SCHEDULE_PREFIX} ${row.prompt}`, source: INJECT_SOURCE.SCHEDULE })
      } else {
        log.error(`定时任务 #${id} 未初始化注入器，已跳过`)
      }
    } catch (err) {
      log.error(`定时任务 #${id} 执行失败: ${err.message}`)
    }

    if (row.cron) {
      this._open()
        .prepare("UPDATE aigc_schedule SET last_run_at = ?, next_run_at = ? WHERE id = ?")
        .run(Date.now(), this._jobs.get(id)?.nextInvocation()?.getTime() ?? null, id)
    } else {
      this._deleteRow(id)
    }
  }

  _deferOneShot(row) {
    const id = Number(row.id)
    const when = Date.now() + OFFLINE_RETRY_MS
    this._open().prepare("UPDATE aigc_schedule SET at = ?, next_run_at = ? WHERE id = ?").run(when, when, id)
    this._cancel(id)
    const job = nodeSchedule.scheduleJob(new Date(when), () => {
      this._fireSafely(id)
    })
    this._jobs.set(id, job)
    log.warn(`定时任务 #${id}: Bot ${row.self_id} 不在线，推迟到 ${formatDate(new Date(when), "compact").slice(0, 16)}`)
  }

  _cancel(id) {
    const job = this._jobs.get(id)
    if (job) {
      job.cancel()
      this._jobs.delete(id)
    }
  }

  _deleteRow(id) {
    this._cancel(id)
    this._open().prepare("DELETE FROM aigc_schedule WHERE id = ?").run(id)
  }

  _setNext(id, at) {
    this._open()
      .prepare("UPDATE aigc_schedule SET next_run_at = ? WHERE id = ?")
      .run(at ?? null, id)
  }
}

export default new ScheduleStore()
