import log from "../helpers/log.js"
import { formatMsgTime } from "../helpers/time.js"
import { AigcError } from "./errors.js"
import { nextApiKey } from "./api-keys.js"
import { isRetryableError, isTimeoutError, isUserAbortError, sleepWithSignal, describeErrorCode } from "./retry.js"

/** 单次请求超时 300 秒 */
export const REQUEST_TIMEOUT_MS = 300_000
/** 失败重试间隔 5~10 秒随机 */
const RETRY_DELAY_MIN_MS = 5_000
const RETRY_DELAY_MAX_MS = 10_000

/** API Key 脱敏: 前 5 位 + *** + 末 4 位，过短返回 ? */
export function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "?"
  return `${key.slice(0, 5)}***${key.slice(-4)}`
}

/** 用户消息文本 + 时间/会话上下文 */
export function textWithContext(msg) {
  if (!msg.time) return msg.content || ""
  const ctx = msg.chat_type ? ` ${msg.chat_type}${msg.chat_type === "群聊" && msg.group_name ? ` ${msg.group_name}` : ""}` : ""
  return `[${formatMsgTime(msg.time)}${ctx}] ${msg.content || ""}`
}

/** 展开可能被切段包裹的媒体数组 */
export function flatten(list) {
  return (list || []).flatMap(x => (Array.isArray(x) ? x : [x])).filter(Boolean)
}

/** 是否为可发送的真实媒体（data URI 或 http(s) URL）；[xx异常] 等失败占位符返回 false */
export function isRealMedia(uri) {
  return typeof uri === "string" && (uri.startsWith("data:") || /^https?:\/\//i.test(uri))
}

/**
 * 按通道轮询 key 并执行请求。
 *
 * call(apiKey) 只负责发请求并返回原始响应；响应解析放在返回后由调用方处理，
 * 避免解析/编程错误被 isRetryableError 当作网络错误反复重试。
 * 成功时返回 { result, apiKey }，便于调用方记录实际使用的 key。
 */
export async function runWithRetry({ label, keys, channel, attempts, timeout, signal, call }) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    const apiKey = nextApiKey(keys, channel)
    try {
      return { result: await call(apiKey), apiKey }
    } catch (err) {
      if (signal?.aborted || isUserAbortError(err)) throw new DOMException("Aborted", "AbortError")
      if (isTimeoutError(err)) err = new AigcError("TIMEOUT", `请求超时[${timeout / 1000}秒]`)
      if (!isRetryableError(err)) throw err

      lastError = err
      if (attempt < attempts - 1) {
        const delay = RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1))
        log.warn(`${label} API 调用失败 (key ${maskKey(apiKey)}): ${err.message}${describeErrorCode(err)}，${Math.round(delay / 1000)}秒后重试...`)
        await sleepWithSignal(delay, signal)
      }
    }
  }

  // 最终抛出的错误也带上错误码，便于上层日志定位
  if (lastError) {
    const meta = describeErrorCode(lastError)
    if (meta) {
      try {
        lastError.message = `${lastError.message}${meta}`
      } catch {}
    }
  }
  throw lastError
}
