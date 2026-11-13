/** 数据保留默认天数 */
export const DEFAULT_RETENTION_DAYS = 30

const DAY_MS = 86400000
/** 消息统计键尾部 */
const COUNT_KEY_RE = /:(\d{4})(?::(\d{2})(?::(\d{2}))?)?$/
/** token 统计键 */
const TOKEN_KEY_RE = /^aigc:token:(\d{4})-(\d{2})-(\d{2}):/

/** 本地日期 0 点时间戳；非法日期返回 NaN */
function dayStart(year, month, day) {
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return NaN
  return date.getTime()
}

function monthLastDay(year, month) {
  return new Date(year, month, 0).getDate()
}

/** 统计周期的最后一天 0 点 —— 月/年键只有整段过期才删除 */
function countKeyEnd(key) {
  const match = COUNT_KEY_RE.exec(key)
  if (!match) return NaN
  const year = Number(match[1])
  const month = match[2] ? Number(match[2]) : 12
  if (month < 1 || month > 12) return NaN
  const day = match[3] ? Number(match[3]) : monthLastDay(year, month)
  return dayStart(year, month, day)
}

function tokenKeyStart(key) {
  const match = TOKEN_KEY_RE.exec(key)
  if (!match) return NaN
  return dayStart(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** 删除超过保留期的消息统计（Yz:count:*）与 token 统计（aigc:token:*）键。
 *  days <= 0 表示不限制；返回删除的键数量 */
export async function pruneStats(redis, days, now = Date.now()) {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0 || typeof redis?.keys !== "function" || typeof redis?.del !== "function") return 0
  const cutoff = now - n * DAY_MS
  let removed = 0
  for (const [pattern, keyEnd] of [
    ["Yz:count:*", countKeyEnd],
    ["aigc:token:*", tokenKeyStart],
  ]) {
    let keys = []
    try {
      keys = (await redis.keys(pattern)) || []
    } catch (err) {
      logger.warn(`统计键扫描失败 (${pattern}): ${err.message}`)
      continue
    }
    const expired = keys.filter(key => {
      const end = keyEnd(key)
      return Number.isFinite(end) && end < cutoff
    })
    for (let i = 0; i < expired.length; i += 200) {
      try {
        removed += (await redis.del(...expired.slice(i, i + 200))) || 0
      } catch (err) {
        logger.warn(`统计键删除失败: ${err.message}`)
      }
    }
  }
  return removed
}
