/** 仅 429 与 5xx 状态码可重试；无 HTTP 状态码（网络/超时）的错误同样可重试，其余 4xx 直接抛出 */
export function isRetryableError(err) {
  const status = Number(err?.status ?? err?.code)
  if (!Number.isFinite(status) || status <= 0) return true
  return status === 429 || status >= 500
}

/** 重试次数归一化，返回总尝试次数 */
export function retryAttempts(retryCount) {
  return Math.min(Math.max(Math.floor(Number(retryCount) || 0), 0), 10) + 1
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

/** 错误码摘要 */
export function describeErrorCode(err) {
  const message = String(err?.message ?? "")
  const code = err?.cause?.code ?? err?.code
  const status = err?.status ?? err?.response?.status
  const bits = []
  if (code !== undefined && !message.includes(String(code))) bits.push(`code=${code}`)
  if (status !== undefined && !message.includes(String(status))) bits.push(`status=${status}`)
  return bits.length ? ` [${bits.join(", ")}]` : ""
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
