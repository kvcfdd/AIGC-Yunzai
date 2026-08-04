import cfg from "../../config/config.js"
import log from "./log.js"
import { dateStr } from "../conversation.js"

const con = () => Bot.aigc.conversation

/** 总结单个用户指定日期的对话 → 记忆 → 裁剪 → 删更早键
 *  返回 { ok, reason? } */
export async function summarizeOne(self_id, user_id, date) {
  if (await con().hasMemoryForDate(self_id, user_id, date)) {
    return { ok: true, reason: "已存在记忆，跳过" }
  }

  const key = con().sessionKey(self_id, user_id, date)
  const session = await con()._read(key)
  if (!session?.messages?.length) return { ok: false, reason: "无对话记录" }

  const qa = con().extractQA(session.messages)
  if (!qa) return { ok: false, reason: "无可总结内容" }

  try {
    const ambient = cfg.aigc?.ambient || {}
    const opts = { stateful: false, retry_count: 2 }
    if (ambient.model) opts.model = ambient.model
    const res = await Bot.aigc.provider.chat(
      [
        { role: "system", content: `你是一个对话总结助手。请以AI助手第一人称的视角将以下用户与AI助手的对话总结为一段摘要（不超过200字），即在200字范围内尽可能详细的说明聊了什么。请直接输出摘要文本，不要加任何前缀或解释。\n\n#对话内容：\n${qa}` },
        { role: "user", content: "[记忆总结触发]" },
      ],
      opts,
    )
    const summary = (res.content || "").trim()
    if (summary) {
      await con().addMemory(self_id, user_id, date, summary)
      log.debug(`记忆已保存: ${self_id}/${user_id}`)
    }
  } catch (err) {
    log.warn(`记忆总结 LLM 调用失败 [${self_id}/${user_id}]: ${err.message}`)
    return { ok: false, reason: `LLM 调用失败: ${err.message}` }
  }

  // 裁剪 + 删更早键
  try {
    const s = await con()._read(key)
    if (s) {
      con().trimTo(s, 5)
      await con()._write(key, s)
    }
    await con().deleteOlderThan(self_id, user_id, date)
  } catch (err) {
    log.error(`裁剪失败 [${self_id}/${user_id}]: ${err.message}`)
  }

  return { ok: true }
}

/** 用户级分布式锁，防止同一用户并发归档 */
async function userLock(user_id, fn) {
  const lockKey = `aigc:lock:${user_id}`
  if (await redis.get(lockKey)) return false
  await redis.set(lockKey, "1", { EX: 300 })
  try {
    return await fn()
  } finally {
    await redis.del(lockKey)
  }
}

/** 扫描今天之前所有未归档日期，按时序逐天总结 */
export async function dailyMemoryJob() {
  const today = dateStr()

  const allDates = await con().scanAllActiveDates()
  const pastDates = allDates.filter(d => d < today)
  if (!pastDates.length) {
    log.info("每日记忆总结: 无历史未归档对话记录")
    return
  }

  log.info(`每日记忆总结: 发现 ${pastDates.length} 个历史日期，按时序归档`)

  const failed = []

  for (const targetDate of pastDates.sort()) {
    const users = await con().scanUsersForDate(targetDate)
    if (!users.length) {
      await con().clearActiveUsersForDate(targetDate)
      continue
    }

    log.info(`每日记忆总结: 归档 [${targetDate}] ${users.length} 个用户`)

    const succeeded = new Set()

    for (const user of users) {
      const [self_id, user_id] = user.split(":")
      const executed = await userLock(user_id, async () => {
        const result = await summarizeOne(self_id, user_id, targetDate)
        if (!result.ok) {
          failed.push({ user, date: targetDate })
          log.warn(`归档失败 [${user}] (${targetDate}): ${result.reason}`)
        } else {
          succeeded.add(user)
        }
        return true
      })
      if (executed === false) {
        log.info(`每日记忆总结: 用户忙碌 [${user}] (${targetDate})，加入重试队列`)
        failed.push({ user, date: targetDate })
      }
    }

    if (succeeded.size === users.length) {
      try {
        await con().clearActiveUsersForDate(targetDate)
      } catch (err) {
        log.warn(`清理活跃记录失败 [${targetDate}]: ${err.message}`)
      }
    }
  }

  // 重试失败/忙碌的任务
  if (failed.length) {
    log.info(`每日记忆总结: 等待 5 秒后重试 ${failed.length} 个失败/忙碌记录`)
    await Bot.sleep(5000)

    for (const { user, date } of failed) {
      const [self_id, user_id] = user.split(":")
      const executed = await userLock(user_id, async () => {
        const result = await summarizeOne(self_id, user_id, date)
        if (result.ok) {
          const allUsers = await con().scanUsersForDate(date)
          if (allUsers.length) {
            let allDone = true
            for (const u of allUsers) {
              const [s, uid] = u.split(":")
              if (!(await con().hasMemoryForDate(s, uid, date))) {
                allDone = false
                break
              }
            }
            if (allDone) {
              await con().clearActiveUsersForDate(date)
              log.info(`日期 [${date}] 所有用户归档完成，活跃记录已清理`)
            }
          }
        } else {
          log.warn(`每日记忆总结: 重试仍失败 [${user}] (${date}): ${result.reason}，保留活跃记录待下次 cron 补漏`)
        }
        return true
      })
      if (executed === false) {
        log.warn(`每日记忆总结: 重试时用户 [${user}] (${date}) 仍忙碌，保留活跃记录待下次 cron 补漏`)
      }
    }
  }

  log.info("每日记忆总结: 完成")
}
