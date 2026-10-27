/** 请求调度器 — 负责同一用户/群的请求合并、排队与打断。
 *
 *  存储结构: requestKey(self_id:user_id) → { controller, isAmbient, injected, pendingTurns, group_id, done }
 */
export class RequestScheduler {
  constructor() {
    this.requests = new Map()
  }

  /** 请求键: self_id:user_id */
  requestKey(event) {
    return `${event.self_id}:${event.user_id}`
  }

  get(event) {
    return this.requests.get(this.requestKey(event))
  }

  set(event, request) {
    this.requests.set(this.requestKey(event), request)
  }

  /** 条件移除 — 仅当当前请求仍是同一个 controller 时删除，避免误删新请求 */
  delete(event, controller) {
    const key = this.requestKey(event)
    if (this.requests.get(key)?.controller === controller) this.requests.delete(key)
  }

  /** 中止指定用户的进行中请求，返回是否命中 */
  abort(event) {
    const req = this.get(event)
    if (!req) return false
    req.controller.abort()
    return true
  }

  /** 中止指定群内正在进行的水群请求，返回是否命中 */
  abortAmbient(groupId) {
    const gid = String(groupId)
    for (const [, req] of this.requests) {
      if (req.isAmbient && req.group_id === gid) {
        req.controller.abort()
        return true
      }
    }
    return false
  }

  /** 中止全部请求，返回被中止的请求键列表 */
  abortAll() {
    const keys = []
    for (const [key, req] of this.requests) {
      req.controller.abort()
      keys.push(key)
    }
    return keys
  }
}

/** 全局请求调度器 */
export const requestScheduler = new RequestScheduler()
export default requestScheduler
