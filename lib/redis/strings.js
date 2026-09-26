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
    const next = (row ? Number.parseInt(row.value, 10) || 0 : 0) + 1
    this._stmt("INSERT INTO redis_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(next))
    return next
  },

  keys(pattern) {
    const re = globToRe(String(pattern))
    const prefix = globPrefix(String(pattern))
    const seen = new Set()
    const now = Date.now()

    for (const table of ["redis_kv", "redis_hash", "redis_zset"]) {
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
    if (this._purgeIfExpired(key) || !this._exists(key)) return false
    this._stmt("INSERT INTO redis_expires (key, expires_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at").run(key, Date.now() + Number(seconds) * 1000)
    return true
  },

  ttl(key) {
    key = String(key)
    if (this._purgeIfExpired(key) || !this._exists(key)) return -2
    const row = this._stmt("SELECT expires_at FROM redis_expires WHERE key = ?").get(key)
    if (!row) return -1
    return Math.max(0, Math.ceil((row.expires_at - Date.now()) / 1000))
  },

  scan(cursor, opts) {
    return { cursor: 0, keys: this.keys(opts?.MATCH ?? "*") }
  },

  save() {
    return "OK"
  },

  ping(msg) {
    return msg ?? "PONG"
  },
}
