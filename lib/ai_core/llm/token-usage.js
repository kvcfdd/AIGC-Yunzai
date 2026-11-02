import { AsyncLocalStorage } from "node:async_hooks"
import log from "../helpers/log.js"

/**
 * Token 用量缓存 — 每次模型调用按
 *   日期 : bot : 调用类型 : 用户QQ : 群ID(私聊为 -)
 * 累加输入 / 输出 / 缓存命中，供后续统计。
 *
 * 调用上下文（event）通过 AsyncLocalStorage 传递，避免每个 provider.chat
 * 调用点都手动带 bot/用户/群参数；子代理、后台任务会继承父轮次的上下文。
 */
const usageContext = new AsyncLocalStorage()

/** 在本轮对话（或注入任务）期间提供用量归属的 event */
export function runWithUsageContext(event, fn) {
  return usageContext.run({ event }, fn)
}

export function currentUsageEvent() {
  return usageContext.getStore()?.event || null
}

/** 本地日期 YYYY-MM-DD */
export function formatUsageDate(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** 用量统计键：aigc:token:<date>:<bot>:<channel>:<user>:<group|-> */
export function tokenUsageKey({ date = new Date(), self_id, channel = "default", user_id, group_id } = {}) {
  return ["aigc:token", formatUsageDate(date), self_id || "unknown", channel || "default", user_id || "unknown", group_id || "-"].join(":")
}

/**
 * 记录一次模型调用的 token 用量；相同键的多次调用累加（输入/输出/缓存命中分别合并）。
 *
 * @param {object} usage 统一用量对象（prompt_tokens / completion_tokens / cached_tokens）
 * @param {string} channel 调用类型：main / ambient / multimodal / agent / audit 等
 * @param {object} [opts]
 * @param {object} [opts.event] 归属的 QQ 事件，默认取当前 AsyncLocalStorage 上下文
 * @param {object} [opts.client] 存储客户端，默认 global.redis
 * @param {Date}   [opts.date]  统计日期，默认当前本地日期
 */
export function recordTokenUsage(usage, channel = "default", { event = currentUsageEvent(), client = globalThis.redis, date = new Date() } = {}) {
  if (!usage || typeof client?.hIncrBy !== "function") return

  const input = Number(usage.prompt_tokens) || 0
  const output = Number(usage.completion_tokens) || 0
  const cacheHit = Number(usage.cached_tokens) || 0
  if (!input && !output && !cacheHit) return

  const key = tokenUsageKey({ date, self_id: event?.self_id, channel, user_id: event?.user_id, group_id: event?.group_id })
  try {
    if (input) client.hIncrBy(key, "input", input)
    if (output) client.hIncrBy(key, "output", output)
    if (cacheHit) client.hIncrBy(key, "cache_hit", cacheHit)
  } catch (err) {
    log.warn(`Token 用量缓存失败: ${err.message}`)
  }
}
