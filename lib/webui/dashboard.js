import fs from "node:fs"
import os from "node:os"
import cfg from "../config/config.js"
import { DEFAULT_FILE } from "../db.js"

/** 单次查询允许的最大天数，避免一次扫描过多统计键 */
const MAX_RANGE_DAYS = 30
/** token 调用类型展示顺序 */
export const TOKEN_CHANNELS = ["main", "ambient", "multimodal", "agent", "audit", "default"]

function pad(value) {
  return String(value).padStart(2, "0")
}

export function formatDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null
  return date
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** 起止日期 → 日期字符串数组，超出上限时保留最近一段 */
export function buildDateRange(from, to, limit = MAX_RANGE_DAYS) {
  if (from > to) [from, to] = [to, from]
  const days = []
  for (let day = new Date(from); day <= to; day = addDays(day, 1)) days.push(formatDay(day))
  return days.length > limit ? days.slice(days.length - limit) : days
}

/** 已有 #状态 统计键：Yz:count:<receive|send>:msg:<total|bot:id>:<YYYY:MM:DD> */
function messageCountKey(kind, botId, day) {
  const [year, month, date] = day.split("-")
  return `Yz:count:${kind}:msg:${botId ? `bot:${botId}` : "total"}:${year}:${month}:${date}`
}

async function readNumber(redis, key) {
  try {
    return Number(await redis?.get?.(key)) || 0
  } catch {
    return 0
  }
}

function emptyTokenBucket() {
  return { input: 0, output: 0, cacheHit: 0 }
}

function addTokenBucket(target, input, output, cacheHit) {
  target.input += input
  target.output += output
  target.cacheHit += cacheHit
}

function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    for (const value of Object.values(cpu.times)) total += value
  }
  return { idle, total }
}

/** 采样一小段时间的系统 CPU 占用 */
export async function sampleCpuUsage(waitMs = 150) {
  const start = cpuSnapshot()
  await new Promise(resolve => setTimeout(resolve, waitMs))
  const end = cpuSnapshot()
  const total = end.total - start.total
  if (total <= 0) return null
  return Math.max(0, Math.min(100, ((total - (end.idle - start.idle)) / total) * 100))
}

function botList(bot) {
  return Object.entries(bot?.bots || {})
    .filter(([, item]) => item?.adapter && item.adapter.id !== "stdin" && item.adapter.name !== "标准输入")
    .map(([id, item]) => ({
      self_id: String(item.uin ?? item.info?.user_id ?? item.self_id ?? id),
      nickname: String(item.nickname ?? item.info?.nickname ?? ""),
      adapter: String(item.adapter?.name ?? item.adapter?.id ?? ""),
    }))
}

function packageVersion() {
  try {
    return cfg.package?.version || ""
  } catch {
    return ""
  }
}

function databaseSize() {
  const file = cfg.db?.storage || DEFAULT_FILE
  let size = 0
  let wal = 0
  try {
    size = fs.statSync(file).size
  } catch {}
  try {
    wal = fs.statSync(`${file}-wal`).size
  } catch {}
  return { file, size, wal, total: size + wal }
}

function systemInfo(bot, cpuUsage) {
  const memory = process.memoryUsage()
  const total = os.totalmem()
  const free = os.freemem()
  const cpus = os.cpus()
  const bots = botList(bot)
  return {
    online: bot?.stat?.online === 2,
    version: packageVersion(),
    node: process.version,
    pid: process.pid,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    cpu: {
      model: String(cpus[0]?.model || "").trim(),
      cores: cpus.length,
      usage: cpuUsage == null ? null : Math.round(cpuUsage * 10) / 10,
      load: os.loadavg().map(value => Math.round(value * 100) / 100),
    },
    memory: {
      total,
      free,
      used: total - free,
      usage: total ? ((total - free) / total) * 100 : 0,
      process: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
    },
    uptime: { process: process.uptime(), system: os.uptime() },
    db: databaseSize(),
    bots,
    counts: {
      bots: bots.length,
      groups: safeCount(() => bot?.getGroupList?.().length),
      friends: safeCount(() => bot?.getFriendList?.().length),
    },
    aigc: {
      enable: cfg.aigc?.enable === true,
      model_config: String(cfg.aigc?.model_config || ""),
      adapter: String(cfg.aigc?.adapter || ""),
      security_audit: cfg.aigc?.security_audit?.enable === true,
    },
  }
}

function safeCount(fn) {
  try {
    const value = fn()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/**
 * WebUI 主页统计。
 * 消息收发复用已有的 Yz:count:receive/send:msg 键，
 * Token 复用 aigc:token:<date>:<bot>:<channel>:<user>:<group> 哈希。
 */
export async function getDashboard(bot, query = {}, { redis = globalThis.redis, now = new Date(), cpuUsage } = {}) {
  const to = parseDay(query.to) || parseDay(formatDay(now)) || now
  const from = parseDay(query.from) || addDays(to, -6)
  const days = buildDateRange(from, to)
  const botFilter = String(query.bot || "").trim()

  const series = days.map(day => ({
    date: day,
    received: 0,
    sent: 0,
    input: 0,
    output: 0,
    cacheHit: 0,
    channels: {},
  }))
  const byDate = new Map(series.map(item => [item.date, item]))
  const channelTotals = new Map()

  for (const day of days) {
    const item = byDate.get(day)
    item.received = await readNumber(redis, messageCountKey("receive", botFilter, day))
    item.sent = await readNumber(redis, messageCountKey("send", botFilter, day))

    const pattern = botFilter ? `aigc:token:${day}:${botFilter}:*` : `aigc:token:${day}:*`
    let keys = []
    try {
      keys = (await redis?.keys?.(pattern)) || []
    } catch {
      keys = []
    }
    for (const key of keys) {
      const parts = String(key).split(":")
      if (parts.length < 7) continue
      const [, , , botId, channel] = parts
      if (botFilter && botId !== botFilter) continue
      let values = {}
      try {
        values = (await redis?.hGetAll?.(key)) || {}
      } catch {
        values = {}
      }
      const input = Number(values.input) || 0
      const output = Number(values.output) || 0
      const cacheHit = Number(values.cache_hit) || 0
      if (!input && !output && !cacheHit) continue

      addTokenBucket(item, input, output, cacheHit)
      const channelBucket = item.channels[channel] || (item.channels[channel] = emptyTokenBucket())
      addTokenBucket(channelBucket, input, output, cacheHit)
      const totalBucket = channelTotals.get(channel) || emptyTokenBucket()
      addTokenBucket(totalBucket, input, output, cacheHit)
      channelTotals.set(channel, totalBucket)
    }
  }

  const messageTotals = series.reduce((total, item) => ({ received: total.received + item.received, sent: total.sent + item.sent }), { received: 0, sent: 0 })
  const tokenTotals = series.reduce(
    (total, item) => {
      total.input += item.input
      total.output += item.output
      total.cacheHit += item.cacheHit
      return total
    },
    { input: 0, output: 0, cacheHit: 0 },
  )
  tokenTotals.total = tokenTotals.input + tokenTotals.output

  const channels = [...channelTotals.entries()]
    .map(([channel, bucket]) => ({ channel, ...bucket, total: bucket.input + bucket.output }))
    .sort((a, b) => {
      const ai = TOKEN_CHANNELS.indexOf(a.channel)
      const bi = TOKEN_CHANNELS.indexOf(b.channel)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || b.total - a.total
    })

  const usage = cpuUsage === undefined ? await sampleCpuUsage() : cpuUsage

  return {
    generated_at: Date.now(),
    range: { from: series[0]?.date || formatDay(from), to: series.at(-1)?.date || formatDay(to), days: series.length },
    filter: { bot: botFilter },
    system: systemInfo(bot, usage),
    messages: {
      totals: messageTotals,
      series: series.map(({ date, received, sent }) => ({ date, received, sent })),
    },
    tokens: {
      totals: tokenTotals,
      series: series.map(({ date, input, output, cacheHit, channels: byChannel }) => ({ date, input, output, cacheHit, channels: byChannel })),
      channels,
    },
  }
}
