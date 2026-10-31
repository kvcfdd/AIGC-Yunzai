/** 统一的 token 用量字段与格式化 */

export const USAGE_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "cached_tokens"]

/** 空用量对象 */
export function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 }
}

/** 累加多轮用量 */
export function addUsage(total, usage) {
  if (!usage) return total
  for (const field of USAGE_FIELDS) total[field] = (Number(total[field]) || 0) + (Number(usage[field]) || 0)
  return total
}

/** 与 token 日志一致的文本；key 为空时不展示 */
export function formatUsage(usage, { key } = {}) {
  const input = Number(usage?.prompt_tokens) || 0
  const output = Number(usage?.completion_tokens) || 0
  const thinking = Number(usage?.reasoning_tokens) || 0
  const total = Number(usage?.total_tokens) || 0
  const cached = Number(usage?.cached_tokens) || 0
  const cachePct = input > 0 ? Math.round((cached / input) * 100) : 0
  return `Token: 输入${input} | 输出${output} | 思考${thinking} | 总消耗${total} | 缓存命中${cached}(${cachePct}%)${key ? ` | key: ${key}` : ""}`
}
