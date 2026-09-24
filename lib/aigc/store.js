import db from "../db.js"
import { prefixEnd } from "../redis/glob.js"

const FILE = "data/db/aigc.db"

/** SQLite 持久化 KV 存储，库文件 data/db/aigc.db */
class AigcStore {
  constructor() {
    this._db = null
    this._stmts = null
  }

  _getDb() {
    if (this._db) return this._db

    const d = db.open(FILE)
    d.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this._stmts = {
      get: d.prepare("SELECT value FROM kv WHERE key = ?"),
      set: d.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      del: d.prepare("DELETE FROM kv WHERE key = ?"),
      keys: d.prepare("SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key"),
      delPrefix: d.prepare("DELETE FROM kv WHERE key >= ? AND key < ?"),
    }
    this._db = d
    return d
  }

  async set(key, value) {
    this._getDb()
    const json = JSON.stringify(value)
    this._stmts.set.run(key, json === undefined ? "null" : json)
    return true
  }

  async get(key) {
    this._getDb()
    const row = this._stmts.get.get(key)
    if (!row) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }

  async del(key) {
    this._getDb()
    try {
      this._stmts.del.run(key)
      return true
    } catch {
      return false
    }
  }

  async keys(prefix) {
    this._getDb()
    return this._stmts.keys.all(prefix, prefixEnd(prefix)).map(r => r.key)
  }

  async delByPrefix(prefix) {
    this._getDb()
    this._stmts.delPrefix.run(prefix, prefixEnd(prefix))
  }
}

export default new AigcStore()
