import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

class Db {
  /** 打开库并返回 better-sqlite3 句柄
   *  @param {string} file 库文件路径
   *  @param {{readonly?: boolean}} [opts] */
  open(file, { readonly = false } = {}) {
    const inMemory = file === ":memory:" || file.startsWith("file:")
    const resolved = inMemory ? file : path.resolve(file)
    if (!readonly && !inMemory) fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const db = new Database(resolved, { readonly })
    db.pragma("busy_timeout = 5000")
    if (!readonly) {
      db.pragma("journal_mode = WAL")
      db.pragma("synchronous = NORMAL")
    }
    return db
  }
}

export default new Db()
