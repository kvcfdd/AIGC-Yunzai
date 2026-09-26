/** 哈希类命令 —— 经 Object.assign 挂到 RedisClient 原型 */
export default {
  /** 支持 v4 的两种形态：hSet(key, field, value) 与 hSet(key, {f1, f2})
   *  @returns {number} 新增字段数 */
  hSet(key, field, value) {
    key = String(key)
    this._purgeIfExpired(key)

    const pairs = typeof field === "object" && field !== null ? Object.entries(field) : [[field, value]]

    let added = 0
    for (const [f, v] of pairs) {
      const exists = this._stmt("SELECT 1 FROM redis_hash WHERE key = ? AND field = ?").get(key, String(f))
      this._stmt("INSERT INTO redis_hash (key, field, value) VALUES (?, ?, ?) ON CONFLICT(key, field) DO UPDATE SET value = excluded.value").run(key, String(f), String(v))
      if (!exists) added++
    }
    return added
  },

  /** @returns {string|null} */
  hGet(key, field) {
    key = String(key)
    if (this._purgeIfExpired(key)) return null
    const row = this._stmt("SELECT value FROM redis_hash WHERE key = ? AND field = ?").get(key, String(field))
    return row ? row.value : null
  },

  /** @returns {Object} v4 返回无原型对象（Object.create(null)），不能返回数组 */
  hGetAll(key) {
    key = String(key)
    const out = Object.create(null)
    if (this._purgeIfExpired(key)) return out
    for (const row of this._stmt("SELECT field, value FROM redis_hash WHERE key = ?").all(key)) out[row.field] = row.value
    return out
  },

  /** @returns {number} 删除的字段数 */
  hDel(key, field) {
    key = String(key)
    this._purgeIfExpired(key)
    const info = this._stmt("DELETE FROM redis_hash WHERE key = ? AND field = ?").run(key, String(field))
    this._pruneIfEmpty(key)
    return info.changes
  },
}
