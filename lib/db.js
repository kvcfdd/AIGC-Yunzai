import Database from "better-sqlite3"
import sqliteConn from "./sqlite-conn.cjs"

/** 统一数据库的默认路径 —— 各层共用的兜底值 */
export const DEFAULT_FILE = "data/db/data.db"

/** 不与他人共享的连接：内存库与 file: URI */
const isPrivate = file => file === ":memory:" || String(file).startsWith("file:")

class Db {
  /** 打开库并返回 better-sqlite3 句柄
   *  可写的文件库按绝对路径全局共享
   *  只读库与内存库各自独立，不进注册表 */
  open(file, { readonly = false } = {}) {
    if (readonly || isPrivate(file)) {
      // 私有连接不共享，也就没有写者竞争；只设这两项，不碰 WAL / auto_vacuum
      const db = new Database(file, { readonly })
      db.pragma("busy_timeout = 5000")
      db.pragma(`cache_size = ${sqliteConn.CACHE_KIB}`)
      return db
    }
    return sqliteConn.openShared(file).db
  }

  /** 关闭并注销共享写连接 —— 只应由登记它的那一方在收尾时调用，并带上它持有的句柄 */
  forget(file, db) {
    sqliteConn.forget(file, db)
  }

  /** 回收空闲页，返回本次回收的页数
   *  默认带滞回阈值，只在空闲页明显堆积时动手；传 threshold = 0 可强制回收 */
  incrementalVacuum(file, pages, threshold) {
    return sqliteConn.incrementalVacuum(file, pages, threshold)
  }
}

export default new Db()
