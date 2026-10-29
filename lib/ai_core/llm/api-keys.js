// API Key 管理

/** 拆分 API Key：数组或字符串，去重 */
function collectApiKeys(config, options) {
  const raw = options.api_keys ?? config.api_keys ?? ""
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)
  return [...new Set(list.map(k => String(k).trim()).filter(Boolean))]
}

// 各通道独立轮询起点
const KEY_IDX = new Map()

/** 轮询取 Key：每个通道从各自的起点开始，失败顺延下一个
 *  单次最多取 retry_count + 1 个；游标由 advanceApiKeyCursor 按实际尝试数量推进 */
function rotateApiKeys(keys, retryOverride, channel = "default") {
  const retry = Math.min(Math.max(retryOverride ?? 0, 0), 10)
  const max = Math.min(keys.length, retry + 1)
  const start = (KEY_IDX.get(channel) || 0) % keys.length
  KEY_IDX.set(channel, (start + 1) % keys.length)
  const result = []
  for (let i = 0; i < max; i++) result.push(keys[(start + i) % keys.length])
  return result
}

/** 一轮结束后按实际尝试数量推进游标：下次从最后一个尝试过的 Key 之后开始 */
function advanceApiKeyCursor(keys, extraAttempts, channel = "default") {
  if (!keys.length) return
  const step = Math.max(0, Math.floor(Number(extraAttempts) || 0))
  const current = KEY_IDX.get(channel) || 0
  KEY_IDX.set(channel, (((current + step) % keys.length) + keys.length) % keys.length)
}

export { collectApiKeys, rotateApiKeys, advanceApiKeyCursor }
