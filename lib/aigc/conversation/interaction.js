import store from "../store.js"

/** Interactions API 有状态模式 — 存储/读取/清除 interaction_id */
export default {
  interactionKey(self_id, user_id) {
    return `iact:${self_id}:${user_id}`
  },

  async getInteractionId(self_id, user_id) {
    const raw = await store.get(this.interactionKey(self_id, user_id))
    return raw?.id || null
  },

  async setInteractionId(self_id, user_id, id) {
    await store.set(this.interactionKey(self_id, user_id), { id, updatedAt: Date.now() })
  },

  async clearInteractionId(self_id, user_id) {
    await store.del(this.interactionKey(self_id, user_id))
  },
}
