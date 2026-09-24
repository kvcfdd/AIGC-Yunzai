import cfg from "./config.js"
import { createClient } from "../redis/index.js"

/**
 * 初始化全局存储客户端
 */
export default async function redisInit() {
  const file = cfg.redis?.storage || "data/db/redis.db"

  try {
    const client = createClient(file)
    client.startSweeper(cfg.redis?.sweep_interval_ms ?? 60000)
    Bot.makeLog("info", `正在打开存储 ${logger.cyan(file)}`, "SQLite")
    return (global.redis = client)
  } catch (err) {
    Bot.makeLog("error", ["存储打开失败", err], "SQLite")
    await Bot.exit()
    return false
  }
}
