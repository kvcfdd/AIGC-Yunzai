import test from "node:test"
import assert from "node:assert/strict"
import { retryAttempts, isRetryableError, isTimeoutError, isUserAbortError, sleepWithSignal, describeErrorCode } from "../../lib/ai_core/llm/retry.js"

test("retry: 仅 429 与 5xx 可重试，其余 HTTP 状态码直接抛出", () => {
  for (const status of [429, 500, 502, 503, 599]) assert.equal(isRetryableError({ status }), true, String(status))
  for (const status of [400, 401, 403, 404, 408, 409, 422]) assert.equal(isRetryableError({ status }), false, String(status))
  // 没有 HTTP 状态码的网络/超时错误仍可重试
  assert.equal(isRetryableError(new Error("network")), true)
  assert.equal(isRetryableError({ code: "ETIMEDOUT" }), true)
})

test("retry: 总尝试次数只由 retry_count 决定（0-10）", () => {
  assert.equal(retryAttempts(0), 1)
  assert.equal(retryAttempts(3), 4)
  assert.equal(retryAttempts(10), 11)
  assert.equal(retryAttempts(99), 11)
  assert.equal(retryAttempts(-1), 1)
  assert.equal(retryAttempts(undefined), 1)
  assert.equal(retryAttempts("2"), 3)
})

test("retry: SDK 错误类型识别", () => {
  class APIConnectionTimeoutError extends Error {}
  class APIUserAbortError extends Error {}
  assert.equal(isTimeoutError(new APIConnectionTimeoutError()), true)
  assert.equal(isUserAbortError(new APIUserAbortError()), true)
})

test("retry: 错误码摘要", () => {
  assert.equal(describeErrorCode({ message: "terminated", cause: { code: "UND_ERR_SOCKET" } }), " [code=UND_ERR_SOCKET]")
  assert.equal(describeErrorCode({ message: "boom", status: 500 }), " [status=500]")
  assert.equal(describeErrorCode({ message: "请求超时[300秒]", code: "TIMEOUT" }), " [code=TIMEOUT]")
  // 消息里已经包含状态码时不重复
  assert.equal(describeErrorCode({ message: "API 错误 [429]: x", status: 429 }), "")
})

test("retry: sleep 可被 AbortSignal 中断", async () => {
  const controller = new AbortController()
  const p = sleepWithSignal(5000, controller.signal)
  controller.abort()
  await assert.rejects(p, /Aborted/)
})
