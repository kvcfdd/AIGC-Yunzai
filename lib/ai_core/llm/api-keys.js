// API Key 管理

/** 拆分 API Key：数组或字符串，去重 */
function collectApiKeys(config, options) {
  const raw = options.api_keys ?? config.api_keys ?? ""
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)
  return [...new Set(list.map(k => String(k).trim()).filter(Boolean))]
}

// 各通道独立轮询游标
const KEY_IDX = new Map()

/** 取通道游标处的下一个 Key 并推进游标：每次尝试切换一个 Key，按圈无限轮换 */
function nextApiKey(keys, channel = "default") {
  if (!keys?.length) return undefined
  const idx = (KEY_IDX.get(channel) || 0) % keys.length
  KEY_IDX.set(channel, (idx + 1) % keys.length)
  return keys[idx]
}

export { collectApiKeys, nextApiKey }
