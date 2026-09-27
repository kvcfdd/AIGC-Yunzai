"use strict"
/**
 * SQLite 共享连接的统一入口。
 */
const fs = require("node:fs")
const path = require("node:path")
const Database = require("better-sqlite3")

/** 每连接页缓存上限 */
const CACHE_KIB = -16384

/** 共享写连接注册表 */
const REGISTRY = Symbol.for("yunzai.sqlite.shared")

/** 回收批量与触发阈值的下限 */
const VACUUM_PAGES_MIN = 100
const VACUUM_THRESHOLD_MIN = 256

/** 两者随库大小缩放 */
const VACUUM_PAGES_RATIO = 0.01
const VACUUM_THRESHOLD_RATIO = 0.02

const registry = () => (globalThis[REGISTRY] ??= new Map())

/** 统一 pragma，仅用于新建的写连接 */
function applyPragmas(db) {
  db.pragma("busy_timeout = 5000")
  db.pragma(`cache_size = ${CACHE_KIB}`)
  db.pragma("auto_vacuum = INCREMENTAL")
  try {
    db.pragma("journal_mode = WAL")
  } catch {}
  db.pragma("synchronous = NORMAL")
}

/**
 * 取得该路径的共享写连接，不存在则新建并登记
 * @param {string} file 库文件路径
 * @returns {{db: import("better-sqlite3").Database, created: boolean}} created 表示由本次调用创建
 */
function openShared(file) {
  const key = path.resolve(file)
  const map = registry()

  const cached = map.get(key)
  if (cached?.open) return { db: cached, created: false }
  if (cached) map.delete(key)

  fs.mkdirSync(path.dirname(key), { recursive: true })
  const db = new Database(key)
  applyPragmas(db)
  map.set(key, db)
  return { db, created: true }
}

/** 关闭并注销该路径的共享连接
 *  仅供登记它的那一方在收尾时调用，且必须带上它当初拿到的那个句柄 */
function forget(file, db) {
  const key = path.resolve(file)
  const map = registry()
  if (!db || map.get(key) !== db) return
  map.delete(key)
  try {
    db.close()
  } catch {}
}

/**
 * @param {string} file 库文件路径
 * @param {number} [pages] 本次最多回收的页数，缺省按库大小取 1%
 * @param {number} [threshold] 触发回收的空闲页阈值，缺省按库大小取 2%；传 0 表示强制收
 * @returns {number} 实际回收的页数
 */
function incrementalVacuum(file, pages, threshold) {
  if (file === ":memory:" || String(file).startsWith("file:")) return 0

  const { db } = openShared(file)
  if (!db.open) return 0
  try {
    const total = db.pragma("page_count", { simple: true }) || 0
    const maxPages = pages ?? Math.max(VACUUM_PAGES_MIN, Math.floor(total * VACUUM_PAGES_RATIO))
    const minFree = threshold ?? Math.max(VACUUM_THRESHOLD_MIN, Math.floor(total * VACUUM_THRESHOLD_RATIO))

    const before = db.pragma("freelist_count", { simple: true })
    if (before < minFree) return 0
    db.pragma(`incremental_vacuum(${Math.min(maxPages, before)})`)
    return before - db.pragma("freelist_count", { simple: true })
  } catch {
    return 0
  }
}

module.exports = { openShared, forget, incrementalVacuum, CACHE_KIB }
