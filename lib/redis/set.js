/** 收集成员参数：兼容 v4 的标量/数组形态，以及旧式多参数散写 */
function memberList(args) {
  return args.flat().map(String)
}

export default {
  /** v4 形态：sAdd(key, member) 或 sAdd(key, [m1, m2])
   *  @returns {number} 新增成员数 */
  sAdd(key, ...members) {
    key = String(key)
    this._purgeIfExpired(key)

    const st = this._stmt("INSERT INTO redis_set (key, member) VALUES (?, ?) ON CONFLICT(key, member) DO NOTHING")
    let added = 0
    for (const member of memberList(members)) added += st.run(key, member).changes
    return added
  },

  /** @returns {number} 删除的成员数 */
  sRem(key, ...members) {
    key = String(key)
    this._purgeIfExpired(key)

    const st = this._stmt("DELETE FROM redis_set WHERE key = ? AND member = ?")
    let n = 0
    for (const member of memberList(members)) n += st.run(key, member).changes
    this._pruneIfEmpty(key)
    return n
  },

  /** 成员顺序在 Redis 中不保证，这里按字典序稳定返回
   *  @returns {string[]} */
  sMembers(key) {
    key = String(key)
    if (this._purgeIfExpired(key)) return []
    return this._stmt("SELECT member FROM redis_set WHERE key = ? ORDER BY member ASC")
      .all(key)
      .map(r => r.member)
  },

  /** @returns {boolean} v4 语义是布尔值 */
  sIsMember(key, member) {
    key = String(key)
    if (this._purgeIfExpired(key)) return false
    return !!this._stmt("SELECT 1 FROM redis_set WHERE key = ? AND member = ?").get(key, String(member))
  },

  /** @returns {number} */
  sCard(key) {
    key = String(key)
    if (this._purgeIfExpired(key)) return 0
    return this._stmt("SELECT count(*) AS c FROM redis_set WHERE key = ?").get(key).c
  },
}
