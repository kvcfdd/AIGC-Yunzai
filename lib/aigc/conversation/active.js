import store from "../store.js"

export default {
  /** 记录当天活跃用户，避免凌晨全表扫描 */
  async addActiveUser(date, self_id, user_id) {
    const key = `active:${date}`
    const entry = (await store.get(key)) || { users: [] }
    const uid = `${self_id}:${user_id}`
    if (!entry.users.includes(uid)) {
      entry.users.push(uid)
      await store.set(key, entry)
    }
  },

  /** 获取指定日期有对话记录的所有用户 */
  async scanUsersForDate(date) {
    const entry = await store.get(`active:${date}`)
    return entry?.users || []
  },

  /** 清理指定日期的活跃用户记录 */
  async clearActiveUsersForDate(date) {
    await store.del(`active:${date}`)
  },

  /** 获取所有活跃日期 */
  async scanAllActiveDates() {
    const keys = await store.keys("active:")
    return keys
      .map(k => k.slice(7)) // "active:2026-07-06" → "2026-07-06"
      .sort()
  },
}
