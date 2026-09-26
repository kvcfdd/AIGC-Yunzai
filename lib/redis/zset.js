/** 有序集合命令 —— 经 Object.assign 挂到 RedisClient 原型
 */

/** 解析 score 边界，支持 -inf / +inf */
function parseBound(v, fallback) {
  if (v === "+inf" || v === "inf" || v === "+Infinity" || v === Infinity) return Infinity
  if (v === "-inf" || v === "-Infinity" || v === -Infinity) return -Infinity
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export default {
  /** v4 形态：zAdd(key, {score, value}) 或 zAdd(key, [{score, value}, ...])
   *  score 可 string 可 number
   *  @returns {number} 新增成员数 */
  zAdd(key, members) {
    key = String(key)
    this._purgeIfExpired(key)

    const list = Array.isArray(members) ? members : [members]
    let added = 0
    for (const m of list) {
      const member = String(m.value)
      const score = Number(m.score)
      if (!Number.isFinite(score)) continue

      const exists = this._stmt("SELECT 1 FROM redis_zset WHERE key = ? AND member = ?").get(key, member)
      this._stmt("INSERT INTO redis_zset (key, member, score) VALUES (?, ?, ?) ON CONFLICT(key, member) DO UPDATE SET score = excluded.score").run(key, member, score)
      if (!exists) added++
    }
    return added
  },

  /** 按排名取成员，支持负索引
   *  @returns {string[]} */
  zRange(key, start, stop) {
    return this._zRangeRows(key, start, stop).map(r => r.member)
  },

  /** @returns {{value: string, score: number}[]} */
  zRangeWithScores(key, start, stop) {
    return this._zRangeRows(key, start, stop).map(r => ({ value: r.member, score: r.score }))
  },

  /** 闭区间，min == max 必须能命中
   *  @returns {string[]} */
  zRangeByScore(key, min, max) {
    return this._zScoreRows(key, min, max, null).map(r => r.member)
  },

  /** @returns {{value: string, score: number}[]} */
  zRangeByScoreWithScores(key, min, max) {
    return this._zScoreRows(key, min, max, null).map(r => ({ value: r.member, score: r.score }))
  },

  /** @returns {number|null} 必须是数字，调用方用它做真值判断与算术 */
  zScore(key, member) {
    key = String(key)
    if (this._purgeIfExpired(key)) return null
    const row = this._stmt("SELECT score FROM redis_zset WHERE key = ? AND member = ?").get(key, String(member))
    return row ? row.score : null
  },

  /** 从高到低的名次，0 起算
   *  @returns {number|null} 必须是 number|null —— 调用方用 lodash.isNumber 判断，
   *  返回字符串会让后续 rank + 1 变成字符串拼接 */
  zRevRank(key, member) {
    key = String(key)
    member = String(member)
    if (this._purgeIfExpired(key)) return null

    const row = this._stmt("SELECT score FROM redis_zset WHERE key = ? AND member = ?").get(key, member)
    if (!row) return null
    return this._stmt("SELECT count(*) AS c FROM redis_zset WHERE key = ? AND (score > ? OR (score = ? AND member > ?))").get(key, row.score, row.score, member).c
  },

  /** @returns {number} */
  zRem(key, member) {
    key = String(key)
    this._purgeIfExpired(key)
    const info = this._stmt("DELETE FROM redis_zset WHERE key = ? AND member = ?").run(key, String(member))
    this._pruneIfEmpty(key)
    return info.changes
  },

  /** @returns {number} */
  zRemRangeByScore(key, min, max) {
    key = String(key)
    this._purgeIfExpired(key)
    const lo = parseBound(min, -Infinity)
    const hi = parseBound(max, Infinity)
    const info = this._stmt("DELETE FROM redis_zset WHERE key = ? AND score >= ? AND score <= ?").run(key, lo, hi)
    this._pruneIfEmpty(key)
    return info.changes
  },

  /** @returns {number} */
  zCount(key, min, max) {
    key = String(key)
    if (this._purgeIfExpired(key)) return 0
    const lo = parseBound(min, -Infinity)
    const hi = parseBound(max, Infinity)
    return this._stmt("SELECT count(*) AS c FROM redis_zset WHERE key = ? AND score >= ? AND score <= ?").get(key, lo, hi).c
  },

  /** 排名区间 → 原始行，负索引从尾部计 */
  _zRangeRows(key, start, stop) {
    key = String(key)
    if (this._purgeIfExpired(key)) return []

    const rows = this._stmt("SELECT member, score FROM redis_zset WHERE key = ? ORDER BY score ASC, member ASC").all(key)
    const len = rows.length
    let s = Number(start)
    let e = Number(stop)
    if (s < 0) s = Math.max(len + s, 0)
    if (e < 0) e = len + e
    if (!Number.isFinite(s) || !Number.isFinite(e) || s > e || s >= len) return []
    return rows.slice(s, e + 1)
  },

  /** score 闭区间 → 原始行 */
  _zScoreRows(key, min, max) {
    key = String(key)
    if (this._purgeIfExpired(key)) return []

    const lo = parseBound(min, -Infinity)
    const hi = parseBound(max, Infinity)
    return this._stmt("SELECT member, score FROM redis_zset WHERE key = ? AND score >= ? AND score <= ? ORDER BY score ASC, member ASC").all(key, lo, hi)
  },
}
