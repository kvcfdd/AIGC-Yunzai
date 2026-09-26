import cfg from "./config.js"
import { createClient } from "../redis/index.js"
import { DEFAULT_FILE } from "../db.js"

/** 过期键后台清扫间隔 */
const SWEEP_INTERVAL_MS = 60000

/**
 * 初始化全局存储客户端
 */
export default async function redisInit() {
  const file = cfg.db?.storage || DEFAULT_FILE

  try {
    const client = createClient(file)
    client.startSweeper(SWEEP_INTERVAL_MS)
    Bot.makeLog("info", `正在打开存储 ${logger.cyan(file)}`, "SQLite")
    return (global.redis = client)
  } catch (err) {
    Bot.makeLog("error", ["存储打开失败", err], "SQLite")
    await Bot.exit()
    return false
  }
}
