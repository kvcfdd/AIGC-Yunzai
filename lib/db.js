import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

/** 统一数据库的默认路径 —— 各层共用的兜底值 */
export const DEFAULT_FILE = "data/db/data.db"

/** 每连接的页缓存上限 */
const CACHE_KIB = -16384

/** 共享连接注册表 */
const REGISTRY = Symbol.for("yunzai.sqlite.shared")
const registry = (globalThis[REGISTRY] ??= new Map())

class Db {
  constructor() {
    /** 已打开的写连接 */
    this._conns = registry
  }

  /** 打开库并返回 better-sqlite3 句柄
   *  @param {string} file 库文件路径
   *  @param {{readonly?: boolean}} [opts] */
  open(file, { readonly = false } = {}) {
    const inMemory = file === ":memory:" || file.startsWith("file:")
    const resolved = inMemory ? file : path.resolve(file)

    if (readonly || inMemory) return this.#create(resolved, readonly, inMemory)

    // 连接可能被某方直接关掉而没有注销，此时不能把死句柄交出去
    let cached = this._conns.get(resolved)
    if (cached && !cached.open) {
      this._conns.delete(resolved)
      cached = null
    }
    if (cached) return cached

    const db = this.#create(resolved, readonly, inMemory)
    this._conns.set(resolved, db)
    return db
  }

  #create(resolved, readonly, inMemory) {
    if (!readonly && !inMemory) fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const db = new Database(resolved, { readonly })
    db.pragma("busy_timeout = 5000")
    db.pragma(`cache_size = ${CACHE_KIB}`)
    if (!readonly) {
      db.pragma("auto_vacuum = INCREMENTAL")
      db.pragma("journal_mode = WAL")
      db.pragma("synchronous = NORMAL")
    }
    return db
  }
}

export default new Db()
