import { AigcError } from "../errors.js"

const API_VERSION = "v1beta"

/** 拼接 Gemini REST 地址；base_url 可能已带 /v1beta，先剥掉再拼接口路径 */
export function geminiUrl(baseUrl, path) {
  let endpoint = (baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "")
  if (endpoint.endsWith(`/${API_VERSION}`)) endpoint = endpoint.slice(0, -(API_VERSION.length + 1))
  return `${endpoint}/${API_VERSION}${path}`
}

/** Gemini REST 错误体可能被数组包裹，取出真正带 error 的对象 */
function unwrapErrorBody(data) {
  if (Array.isArray(data)) return data.find(item => item && item.error) || {}
  return data || {}
}

/** 将 Gemini REST 错误体中的真实原因、状态与配额元数据补进错误消息
 *  返回传入的 err，便于 `throw describeApiError(err)` */
export function describeApiError(err) {
  if (!err?.body) return err

  let payload
  try {
    payload = JSON.parse(err.body)
  } catch {
    return err
  }

  const error = unwrapErrorBody(payload).error
  if (!error) return err

  const status = err.status ?? error.code
  const reason = error.message || error.status || "API 错误"
  const meta = []
  if (error.status && !String(reason).includes(error.status)) meta.push(error.status)

  const details = Array.isArray(error.details) ? error.details : []
  const quota = details.map(d => d?.metadata).find(m => m && m.quota_limit_value !== undefined)
  if (quota) {
    meta.push(`limit=${quota.quota_limit_value}`)
    if (quota.quota_location) meta.push(`region=${quota.quota_location}`)
  }

  err.message = `${status ?? ""} ${reason}${meta.length ? ` (${meta.join(", ")})` : ""}`.trim()
  if (err.status === undefined && Number.isFinite(Number(status))) err.status = Number(status)
  return err
}

/** 读取非 2xx 响应并构造带 status/body 的错误，供调用方直接抛出 */
export async function apiErrorFrom(res) {
  const body = await res.text()
  const err = new AigcError(String(res.status), `API 错误 [${res.status}]: ${body}`)
  err.status = res.status
  err.body = body
  return describeApiError(err)
}

/** 解析 2xx 响应 JSON；响应体非 JSON 时按 520 处理 */
export async function readJson(res) {
  try {
    return await res.json()
  } catch {
    throw new AigcError("520", "API 错误 [200]: 响应非 JSON 格式")
  }
}
