import { globToRe, globPrefix, prefixEnd } from "./glob.js"

/** 字符串类命令 —— 经 Object.assign 挂到 RedisClient 原型 */
export default {
  get(key) {
    key = String(key)
    if (this._purgeIfExpired(key)) return null
    const row = this._stmt("SELECT value FROM redis_kv WHERE key = ?").get(key)
    return row ? row.value : null
  },

  set(key, value, opts) {
    key = String(key)
    this._purgeIfExpired(key)
    if (opts?.NX === true && this._exists(key)) return null

    this._stmt("INSERT INTO redis_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value))
    if (!this._applyExpire(key, opts) && opts?.KEEPTTL !== true) this._stmt("DELETE FROM redis_expires WHERE key = ?").run(key)
    return "OK"
  },

  setEx(key, seconds, value) {
    return this.set(key, value, { EX: seconds })
  },

  del(...keys) {
    let n = 0
    for (const key of keys.flat().map(String)) {
      if (this._purgeIfExpired(key)) continue
      if (this._purge(key)) n++
    }
    return n
  },

  incr(key) {
    key = String(key)
    this._purgeIfExpired(key)
    const row = this._stmt("SELECT value FROM redis_kv WHERE key = ?").get(key)
    let cur = 0
    if (row) {
      if (!/^-?\d+$/.test(String(row.value).trim())) throw new TypeError(`Redis 兼容层: incr 的目标值不是整数 (${key} = ${JSON.stringify(row.value)})`)
      cur = Number(row.value)
    }
    const next = cur + 1
    this._stmt("INSERT INTO redis_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(next))
    return next
  },

  keys(pattern) {
    const re = globToRe(String(pattern))
    const prefix = globPrefix(String(pattern))
    const seen = new Set()
    const now = Date.now()

    for (const table of ["redis_kv", "redis_hash", "redis_zset", "redis_set", "redis_list"]) {
      // 过期过滤下推到 SQL
      for (const { key } of this._stmt(`SELECT DISTINCT key FROM ${table} WHERE key >= ? AND key < ? AND key NOT IN (SELECT key FROM redis_expires WHERE expires_at <= ?)`).all(prefix, prefixEnd(prefix), now)) {
        if (seen.has(key) || !re.test(key)) continue
        seen.add(key)
      }
    }
    return [...seen]
  },

  expire(key, seconds) {
    key = String(key)
    const sec = Number(seconds)
    if (!Number.isFinite(sec)) throw new TypeError(`Redis 兼容层: expire 的秒数必须是数字，收到 ${JSON.stringify(seconds)}`)
    if (this._purgeIfExpired(key) || !this._exists(key)) return false
    return this._applyExpire(key, { EX: sec })
  },

  ttl(key) {
    key = String(key)
    if (this._purgeIfExpired(key) || !this._exists(key)) return -2
    const row = this._stmt("SELECT expires_at FROM redis_expires WHERE key = ?").get(key)
    if (!row) return -1
    return Math.max(0, Math.ceil((row.expires_at - Date.now()) / 1000))
  },

  /** 游标式遍历 */
  scan(cursor, opts) {
    const pattern = String(opts?.MATCH ?? "*")
    const re = globToRe(pattern)
    const prefix = globPrefix(pattern)
    const end = prefixEnd(prefix)
    const count = Math.min(Math.max(Number(opts?.COUNT) || 10, 1), 10000)
    const after = cursor == null || cursor === 0 || cursor === "0" ? "" : String(cursor)
    const resume = after && after >= prefix
    const lowerOp = resume ? ">" : ">="
    const lower = resume ? after : prefix
    const now = Date.now()
    const picked = new Set()
    let boundary = null

    for (const table of ["redis_kv", "redis_hash", "redis_zset", "redis_set", "redis_list"]) {
      const rows = this._stmt(
        `SELECT DISTINCT key FROM ${table}
          WHERE key ${lowerOp} ? AND key < ?
            AND key NOT IN (SELECT key FROM redis_expires WHERE expires_at <= ?)
          ORDER BY key LIMIT ?`,
      ).all(lower, end, now, count)
      if (!rows.length) continue

      const max = rows[rows.length - 1].key
      if (boundary === null || max < boundary) boundary = max
      for (const { key } of rows) if (re.test(key)) picked.add(key)
    }

    // 三张表都没有可取的键 → 遍历结束
    if (boundary === null) return { cursor: 0, keys: [] }

    return { cursor: boundary, keys: [...picked].filter(k => k <= boundary).sort() }
  },

  save() {
    return "OK"
  },

  ping(msg) {
    return msg ?? "PONG"
  },
}
