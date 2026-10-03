/** 收集元素参数：兼容 v4 的标量/数组形态，以及旧式多参数散写 */
function elementList(args) {
  return args.flat().map(String)
}

export default {
  /** v4 形态：lPush(key, element) 或 lPush(key, [e1, e2])；多元素按 Redis 语义依次头插
   *  @returns {number} push 后的列表长度 */
  lPush(key, ...elements) {
    return this._push(key, elementList(elements), true)
  },

  /** @returns {number} push 后的列表长度 */
  rPush(key, ...elements) {
    return this._push(key, elementList(elements), false)
  },

  /** @returns {string|null} */
  lPop(key) {
    return this._pop(key, true)
  },

  /** @returns {string|null} */
  rPop(key) {
    return this._pop(key, false)
  },

  /** 闭区间，支持负索引，与 zRange 的索引规则一致
   *  @returns {string[]} */
  lRange(key, start, stop) {
    key = String(key)
    if (this._purgeIfExpired(key)) return []

    const rows = this._stmt("SELECT value FROM redis_list WHERE key = ? ORDER BY pos ASC").all(key)
    const len = rows.length
    let s = Number(start)
    let e = Number(stop)
    if (s < 0) s = Math.max(len + s, 0)
    if (e < 0) e = len + e
    if (!Number.isFinite(s) || !Number.isFinite(e) || s > e || s >= len) return []
    return rows.slice(s, e + 1).map(r => r.value)
  },

  /** @returns {number} */
  lLen(key) {
    key = String(key)
    if (this._purgeIfExpired(key)) return 0
    return this._stmt("SELECT count(*) AS c FROM redis_list WHERE key = ?").get(key).c
  },

  /** 头插或尾插一批元素，返回新长度 */
  _push(key, list, head) {
    key = String(key)
    this._purgeIfExpired(key)
    if (!list.length) return this._len(key)

    const edge = head ? this._stmt("SELECT min(pos) AS p FROM redis_list WHERE key = ?").get(key).p : this._stmt("SELECT max(pos) AS p FROM redis_list WHERE key = ?").get(key).p
    let pos = edge ?? 0
    const st = this._stmt("INSERT INTO redis_list (key, pos, value) VALUES (?, ?, ?)")
    for (const value of list) {
      pos += head ? -1 : 1
      st.run(key, pos, value)
    }
    return this._len(key)
  },

  /** 弹出头部或尾部元素，空列表返回 null */
  _pop(key, head) {
    key = String(key)
    this._purgeIfExpired(key)

    const row = this._stmt(`SELECT pos, value FROM redis_list WHERE key = ? ORDER BY pos ${head ? "ASC" : "DESC"} LIMIT 1`).get(key)
    if (!row) return null
    this._stmt("DELETE FROM redis_list WHERE key = ? AND pos = ?").run(key, row.pos)
    this._pruneIfEmpty(key)
    return row.value
  },

  /** 当前长度 */
  _len(key) {
    return this._stmt("SELECT count(*) AS c FROM redis_list WHERE key = ?").get(key).c
  },
}
