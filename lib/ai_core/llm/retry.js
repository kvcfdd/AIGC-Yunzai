/** 可重试错误：鉴权/限流/超时/冲突/5xx/网络错误；400、404、422 等参数类错误不重试 */
export function isRetryableError(err) {
  const status = err?.status ?? Number(err?.code)
  if (!status || Number.isNaN(status)) return true
  if (status === 401 || status === 403 || status === 408 || status === 409 || status === 429) return true
  return status >= 500
}

/** OpenAI/Anthropic SDK 的 Error.name 恒为 "Error"，用 constructor.name 或 instanceof 判断 */
export function isTimeoutError(err) {
  const name = err?.constructor?.name || err?.name
  return name === "APIConnectionTimeoutError" || name === "TimeoutError"
}

export function isUserAbortError(err) {
  const name = err?.constructor?.name || err?.name
  return name === "APIUserAbortError" || name === "AbortError"
}

/** 可被 AbortSignal 中断的 sleep */
export function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const onAbort = () => {
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
