"use strict"
/**
 * sqlite3 包 API 垫片 —— 底层改用 better-sqlite3
 */
const BS3 = require("better-sqlite3")
const path = require("node:path")

/** 共享连接注册表 */
const REGISTRY = Symbol.for("yunzai.sqlite.shared")

const OPEN_READONLY = 0x00000001
const OPEN_READWRITE = 0x00000002
const OPEN_CREATE = 0x00000004

/** 语句缓存上限 */
const STATEMENT_CACHE_MAX = 1000

class Statement {
  constructor() {
    this.changes = 0
    this.lastID = 0
  }
}

function stripLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""')
}

function normalizeParams(sql, params) {
  if (params == null) return []
  if (!Array.isArray(params)) {
    const out = Object.create(null)
    for (const k of Object.keys(params)) out[k.replace(/^\$/, "")] = params[k]
    return [out]
  }
  if (!params.length) return []
  if (!/\$\d+/.test(stripLiterals(sql))) return params
  const named = Object.create(null)
  params.forEach((v, i) => {
    named[String(i + 1)] = v
  })
  return [named]
}

/** sqlite3 的 Database 构造签名：new Database(filename[, mode][, callback]) */
class Database {
  constructor(filename, mode, cb) {
    if (typeof mode === "function") {
      cb = mode
      mode = undefined
    }
    this.filename = filename
    this.open = true
    this._stmts = new Map()
    this._readOnly = mode != null && (mode & (OPEN_READWRITE | OPEN_CREATE)) === 0
    /** 取自注册表 —— 持有者是 lib/db.js，本对象不能关它 */
    this._shared = false
    /** 由本对象登记进注册表 */
    this._registered = false
    this._resolve()

    if (cb) queueMicrotask(() => cb(null))
  }

  /** 取得底层连接: 优先复用注册表中的共享写连接，没有就自建并登记 */
  _resolve() {
    this._shared = false
    this._registered = false

    if (this._readOnly || this.filename === ":memory:" || String(this.filename).startsWith("file:")) return (this._db = new BS3(this.filename, { readonly: this._readOnly }))

    const registry = (globalThis[REGISTRY] ??= new Map())
    const key = path.resolve(this.filename)
    const shared = registry.get(key)
    if (shared?.open) {
      this._shared = true
      return (this._db = shared)
    }
    if (shared) registry.delete(key)

    const db = new BS3(this.filename)
    db.pragma("busy_timeout = 5000")
    db.pragma("cache_size = -16384")
    db.pragma("auto_vacuum = INCREMENTAL")
    try {
      db.pragma("journal_mode = WAL")
    } catch {}
    db.pragma("synchronous = NORMAL")
    registry.set(key, db)
    this._registered = true
    this._db = db
  }

  _ensure() {
    if (this._db.open || !this.open) return
    this._stmts.clear()
    this._resolve()
  }

  /** 切换 verbose 模式 —— sqlite3 的链式 API，此处无对应行为，仅为接口完整 */
  verbose() {
    return this
  }

  /** better-sqlite3 全程同步、天然串行，直接执行即可 */
  serialize(fn) {
    fn()
    return this
  }

  parallelize(fn) {
    fn()
    return this
  }

  run(sql, params, cb) {
    if (typeof params === "function") {
      cb = params
      params = undefined
    }
    return this._invoke("run", sql, params, cb)
  }

  all(sql, params, cb) {
    if (typeof params === "function") {
      cb = params
      params = undefined
    }
    return this._invoke("all", sql, params, cb)
  }

  get(sql, params, cb) {
    if (typeof params === "function") {
      cb = params
      params = undefined
    }
    return this._invoke("get", sql, params, cb)
  }

  each(sql, params, cb, done) {
    if (typeof params === "function") {
      done = cb
      cb = params
      params = undefined
    }
    const meta = new Statement()
    let rows
    try {
      rows = this._prepare(sql).all(...normalizeParams(sql, params))
    } catch (err) {
      if (cb) cb.call(meta, err)
      if (done) done.call(meta, err)
      return this
    }
    for (const row of rows) cb.call(meta, null, row)
    if (done) done.call(meta, null, rows.length)
    return this
  }

  exec(sql, cb) {
    try {
      this._ensure()
      this._db.exec(sql)
      if (cb) cb(null)
    } catch (err) {
      if (cb) cb(err)
    }
    return this
  }

  close(cb) {
    try {
      if (this.open) {
        this._stmts.clear()
        if (!this._shared) {
          if (this._registered) globalThis[REGISTRY]?.delete(path.resolve(this.filename))
          this._db.close()
        }
        this.open = false
      }
      if (cb) cb(null)
    } catch (err) {
      if (cb) cb(err)
    }
    return this
  }

  /** 语句缓存 —— 按 SQL 文本复用，超过上限整体清空 */
  _prepare(sql) {
    this._ensure()
    const cached = this._stmts.get(sql)
    if (cached) return cached
    if (this._stmts.size >= STATEMENT_CACHE_MAX) this._stmts.clear()
    const st = this._db.prepare(sql)
    this._stmts.set(sql, st)
    return st
  }

  _invoke(method, sql, params, cb) {
    const meta = new Statement()
    let result
    try {
      const st = this._prepare(sql)
      const args = normalizeParams(sql, params)
      const isReader = st.reader !== false

      if (method === "run" || !isReader) {
        const r = st.run(...args)
        meta.changes = Number(r.changes)
        meta.lastID = Number(r.lastInsertRowid)
        result = method === "run" ? undefined : []
      } else if (method === "all") {
        result = st.all(...args)
      } else {
        result = st.get(...args)
      }
    } catch (err) {
      // 语句执行出错：交给回调，没有回调就直接抛
      if (cb) {
        cb.call(meta, err)
        return this
      }
      throw err
    }

    // 回调放在 try 之外：回调自身抛错不应被当成语句错误再回调一次
    if (cb) cb.call(meta, null, result)
    return this
  }
}

const sqlite3 = {
  Database,
  Statement,
  OPEN_READONLY,
  OPEN_READWRITE,
  OPEN_CREATE,
  verbose: () => sqlite3,
  cached: { Database },
}
sqlite3.default = sqlite3

module.exports = sqlite3
