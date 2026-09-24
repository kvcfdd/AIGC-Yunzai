import db from "../db.js"
import { initSchema } from "./schema.js"
import strings from "./strings.js"
import hash from "./hash.js"
import zset from "./zset.js"
import pipeline from "./pipeline.js"

const METHOD_GROUPS = [strings, hash, zset, pipeline]
const COMMANDS = [...new Set(METHOD_GROUPS.flatMap(g => Object.keys(g)).filter(n => !n.startsWith("_")))]

const INFRA = new Set(["process", "class", "opts", "err", "lock", "options", "isOpen", "isReady", "then", "toJSON", "constructor", "inspect", "ready", "sweep", "close", "connect", "disconnect", "on", "once"])

/** sweep 的批大小，以及取样语句 */
const SWEEP_BATCH = 1000
const SWEEP_SELECT = "SELECT key FROM expires WHERE expires_at <= ? LIMIT ?"

/**
 * Redis 兼容层 —— 用 SQLite 顶替真实 Redis，接口面按 node-redis v4
 */
class RedisClient {
  constructor(file) {
    this._file = file
    this._db = db.open(file)
    initSchema(this._db)
    this._stmts = new Map()
    this._sweepers = null
    for (const name of COMMANDS) {
      const bound = this[name].bind(this)
      this[name] = bound
      const upper = name.toUpperCase()
      if (upper !== name) this[upper] = bound
    }
  }

  /** 命令名列表 —— 供 multi() 构建链式对象 */
  _commandNames() {
    return COMMANDS
  }

  /** 预处理语句缓存 */
  _stmt(sql) {
    let st = this._stmts.get(sql)
    if (!st) {
      st = this._db.prepare(sql)
      this._stmts.set(sql, st)
    }
    return st
  }

  /** 删除该键在所有类型表与过期表中的记录，返回删除的行数 */
  _purge(key) {
    let n = 0
    n += this._stmt("DELETE FROM kv WHERE key = ?").run(key).changes
    n += this._stmt("DELETE FROM hash WHERE key = ?").run(key).changes
    n += this._stmt("DELETE FROM zset WHERE key = ?").run(key).changes
    this._stmt("DELETE FROM expires WHERE key = ?").run(key)
    return n
  }

  /** 键是否还存在 */
  _exists(key) {
    return !!(this._stmt("SELECT 1 FROM kv WHERE key = ?").get(key) || this._stmt("SELECT 1 FROM hash WHERE key = ?").get(key) || this._stmt("SELECT 1 FROM zset WHERE key = ?").get(key))
  }

  /** 键已过期则清除并返回 true —— 读时惰性过期 */
  _purgeIfExpired(key) {
    const row = this._stmt("SELECT expires_at FROM expires WHERE key = ?").get(key)
    if (!row || row.expires_at > Date.now()) return false
    this._purge(key)
    return true
  }

  /** 容器空了就把过期记录一并清掉，与 Redis 中空键自动消失一致 */
  _pruneIfEmpty(key) {
    if (this._exists(key)) return
    this._stmt("DELETE FROM expires WHERE key = ?").run(key)
  }

  /** 应用 set 的 EX / PX 选项；未知选项键一律忽略
   *  @returns {boolean} 是否写入了过期时间 */
  _applyExpire(key, opts) {
    if (!opts) return false
    const sec = opts.EX ?? (opts.PX != null ? Number(opts.PX) / 1000 : null)
    if (sec == null) return false
    this._stmt("INSERT INTO expires (key, expires_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at").run(key, Date.now() + Number(sec) * 1000)
    return true
  }

  /** 清扫已过期的键 —— 分批 + 单次时间预算，避免大批量过期时长时间卡住事件循环
   *  @param {number} [budgetMs] 单次调用最多占用的毫秒数
   *  @returns {number} 本次清除的键数 */
  sweep(budgetMs = 25) {
    const deadline = Date.now() + budgetMs
    let total = 0
    for (;;) {
      const keys = this._stmt(SWEEP_SELECT)
        .all(Date.now(), SWEEP_BATCH)
        .map(r => r.key)
      if (!keys.length) break

      // 一批键只扫一次 expires，再把键表交给 json_each
      const list = JSON.stringify(keys)
      for (const table of ["kv", "hash", "zset"]) this._stmt(`DELETE FROM ${table} WHERE key IN (SELECT value FROM json_each(?))`).run(list)
      const info = this._stmt("DELETE FROM expires WHERE key IN (SELECT value FROM json_each(?))").run(list)
      total += keys.length

      if (!info.changes) break
      if (Date.now() >= deadline) break
    }
    return total
  }

  // 生命周期 —— 进程内 SQLite 无需建连，保留这些方法只为接口完整

  connect() {
    return this
  }

  /** 启动后台清扫。unref 以免吊住进程退出
   *  间隔非法就退回默认值，避免变成忙循环 */
  startSweeper(intervalMs) {
    if (this._sweepers) return
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = 60000
    this._sweepers = setInterval(() => {
      try {
        this.sweep()
      } catch {}
    }, intervalMs)
    this._sweepers.unref?.()
  }

  /** 事件接口 */
  once() {
    return this
  }

  on() {
    return this
  }

  disconnect() {
    this.close()
    return this
  }

  close() {
    if (this._sweepers) {
      clearInterval(this._sweepers)
      this._sweepers = null
    }
    try {
      this._stmts.clear()
      this._db.close()
    } catch {}
  }
}

Object.assign(RedisClient.prototype, strings, hash, zset, pipeline)

/** 创建客户端
 *  @param {string} file 库文件路径 */
export function createClient(file) {
  const client = new RedisClient(file)
  return new Proxy(client, {
    get(target, prop) {
      if (typeof prop === "symbol") return target[prop]
      if (prop in target || INFRA.has(prop)) return target[prop]
      throw new Error(`Redis 兼容层未实现命令: ${prop}（如需使用请在 lib/redis/ 下补充实现）`)
    },
  })
}

export { COMMANDS }
