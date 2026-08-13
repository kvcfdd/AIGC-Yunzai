import cfg from "../../config/config.js"

// API Key 管理

function _collectKeys(config, options) {
  const raw = options.api_key || config.api_key || ""
  return raw
    .split(",")
    .map(k => k.trim())
    .filter(Boolean)
}

// 各通道独立轮询起点
const KEY_IDX = new Map()

// 有状态模式持久游标
const STATEFUL_IDX = new Map()

/** 轮询取 Key：每个通道从各自的起点开始，失败顺延下一个 */
function _rotateKeys(keys, retryOverride, channel = "default") {
  const retry = Math.min(Math.max(retryOverride ?? cfg.aigc?.retry_count ?? 0, 0), 10)
  const max = Math.min(keys.length, retry + 1)
  const start = (KEY_IDX.get(channel) || 0) % keys.length
  KEY_IDX.set(channel, (KEY_IDX.get(channel) || 0) + 1)
  const result = []
  for (let i = 0; i < max; i++) result.push(keys[(start + i) % keys.length])
  return result
}

export { _collectKeys, KEY_IDX, STATEFUL_IDX, _rotateKeys }
