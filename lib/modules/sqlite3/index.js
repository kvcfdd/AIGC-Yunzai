"use strict"
/**
 * sqlite3 包 API 垫片 —— 底层改用 better-sqlite3
 */
const BS3 = require("better-sqlite3")

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

    const readOnly = mode != null && (mode & (OPEN_READWRITE | OPEN_CREATE)) === 0
    this._db = new BS3(filename, { readonly: readOnly })

    if (!readOnly) {
      try {
        this._db.pragma("journal_mode = WAL")
      } catch {}
    }

    if (cb) queueMicrotask(() => cb(null))
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
        this._db.close()
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
