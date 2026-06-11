/** LevelDB 持久化 KV 存储，数据目录 data/db/aigc/ */
class AigcStore {
  constructor() {
    this._db = null
  }

  async _getDb() {
    if (this._db) return this._db
    // 初始化进行中复用同一个 Promise，避免并发调用重复 open 导致文件锁冲突
    if (!this._initDb) {
      this._initDb = (async () => {
        const { Level } = await import("level")
        const db = new Level("data/db/aigc", { valueEncoding: "json" })
        await db.open()
        this._db = db
        return db
      })().catch(err => {
        this._initDb = null
        throw err
      })
    }
    return this._initDb
  }

  async set(key, value) {
    const db = await this._getDb()
    await db.put(key, value)
    return true
  }

  async get(key) {
    const db = await this._getDb()
    try {
      return await db.get(key)
    } catch {
      return null
    }
  }

  async del(key) {
    const db = await this._getDb()
    try {
      await db.del(key)
      return true
    } catch {
      return false
    }
  }

  async keys(prefix) {
    const db = await this._getDb()
    const result = []
    for await (const [key] of db.iterator({ gte: prefix, lt: `${prefix}\xFF` })) {
      result.push(key)
    }
    return result
  }

  async delByPrefix(prefix) {
    const db = await this._getDb()
    const batch = db.batch()
    for await (const [key] of db.iterator({ gte: prefix, lt: `${prefix}\xFF` })) {
      batch.del(key)
    }
    if (batch.length) await batch.write()
  }
}

export default new AigcStore()
