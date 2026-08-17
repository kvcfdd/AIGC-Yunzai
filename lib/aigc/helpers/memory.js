import cfg from "../../config/config.js"
import log from "./log.js"
import conversation, { dateStr } from "../conversation.js"
import provider from "../provider.js"

/** 解析用户昵称: 群成员缓存优先 → 好友信息 → 接口兜底, 拿不到返回 null */
async function resolveUserNickname(user_id) {
  try {
    for (const [, ml] of Bot.gml ?? []) {
      const info = ml.get(Number(user_id)) || ml.get(String(user_id))
      if (info?.card || info?.nickname) return info.card || info.nickname
    }
    const friend = Bot.pickUser(user_id)
    if (friend?.nickname) return friend.nickname
    if (friend?.getInfo) {
      try {
        const info = await friend.getInfo()
        if (info?.nickname) return info.nickname
      } catch {}
    }
  } catch (err) {
    // 忽略昵称解析异常, 不影响总结流程
  }
  return null
}

function buildSummarizePrompt(systemPrompt, qa, memories) {
  const history = memories?.length ? memories.map(m => `- ${m.date}: ${m.summary}`).join("\n") : "（无）"
  const hardcoded = `============================================
[系统提示] 现在是每日总结时间，来总结一下今天与ta的对话历程吧~

本次输出要求: 直接输出摘要文本本身，尽量控制在200字以内，不要输出任何前缀、引导语、问候语或解释；不要模仿 <history> 中的"日期: 内容"格式，不要引用任何日期。

## 往期总结参考
<history>
${history}
</history>

## 今日对话
<conversation>
${qa}
</conversation>`
  return systemPrompt ? `${systemPrompt}\n\n${hardcoded}` : hardcoded
}

/** 总结单个用户指定日期的对话 → 记忆 → 裁剪 → 删更早键
 *  返回 { ok, reason? } */
export async function summarizeOne(self_id, user_id, date) {
  if (await conversation.hasMemoryForDate(self_id, user_id, date)) {
    return { ok: true, reason: "已存在记忆，跳过" }
  }

  const key = conversation.sessionKey(self_id, user_id, date)
  const session = await conversation.getSession(key)
  if (!session?.messages?.length) return { ok: false, reason: "无对话记录" }

  // 对话记录
  const userLabel = (await resolveUserNickname(user_id)) ?? "user"
  const qa = conversation.extractQA(session.messages, { userLabel })
  if (!qa) return { ok: false, reason: "无可总结内容" }

  try {
    const ambient = cfg.aigc?.ambient || {}
    const opts = { stateful: false, retry_count: 2, channel: "ambient", model: ambient.model || "gemini-3-flash-preview" }
    const memories = (await conversation.getMemoryEntries(self_id, user_id)) || []
    const prompt = buildSummarizePrompt(cfg.aigc?.system_prompt, qa, memories)
    const res = await provider.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "[每日总结系统触发]" },
      ],
      opts,
    )
    // 去除学舌自往期总结的日期前缀, 如 "2026-08-06: xxx" / "- 2026-08-06: xxx", 避免记忆里混入日期
    const summary = (res.content || "")
      .trim()
      .replace(/^-?\s*\d{4}-\d{2}-\d{2}:\s*/, "")
      .trim()
    let saved = false
    if (summary) {
      await conversation.addMemory(self_id, user_id, date, summary)
      saved = true
      log.debug(`记忆已保存: ${self_id}/${user_id}`)
    }
    if (!saved) {
      log.warn(`记忆总结为空摘要，跳过裁剪 [${self_id}/${user_id}]，保留完整对话待下次归档`)
      return { ok: false, reason: "LLM 返回空摘要" }
    }
  } catch (err) {
    log.warn(`记忆总结 LLM 调用失败 [${self_id}/${user_id}]: ${err.message}`)
    return { ok: false, reason: `LLM 调用失败: ${err.message}` }
  }

  // 裁剪 + 删更早键
  try {
    const s = await conversation.getSession(key)
    if (s) {
      conversation.trimTo(s)
      await conversation.saveSession(key, s)
    }
    await conversation.deleteOlderThan(self_id, user_id, date)
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

  const allDates = await conversation.scanAllActiveDates()
  const pastDates = allDates.filter(d => d < today)
  if (!pastDates.length) {
    log.info("每日记忆总结: 无历史未归档对话记录")
    return
  }

  log.info(`每日记忆总结: 发现 ${pastDates.length} 个历史日期，按时序归档`)

  const failed = []

  for (const targetDate of pastDates.sort()) {
    const users = await conversation.scanUsersForDate(targetDate)
    if (!users.length) {
      await conversation.clearActiveUsersForDate(targetDate)
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
        await conversation.clearActiveUsersForDate(targetDate)
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
          const allUsers = await conversation.scanUsersForDate(date)
          if (allUsers.length) {
            let allDone = true
            for (const u of allUsers) {
              const [s, uid] = u.split(":")
              if (!(await conversation.hasMemoryForDate(s, uid, date))) {
                allDone = false
                break
              }
            }
            if (allDone) {
              await conversation.clearActiveUsersForDate(date)
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
