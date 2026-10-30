/** 上下文窗口：
 *  历史累计到 max 轮后，下一次请求只携带最近 keep 轮，再继续累计到 max，周而复始
 *  返回本次请求应携带的历史轮数
 *  不滑动、不逐轮裁剪，保证每个周期内的前缀稳定，便于命中缓存 */
export function contextWindowSize(total, max, keep) {
  const totalRounds = Math.floor(Number(total) || 0)
  const maxRounds = Math.floor(Number(max) || 0)
  if (totalRounds <= 0 || maxRounds <= 0) return 0
  if (totalRounds <= maxRounds) return totalRounds

  const keepRaw = Math.floor(Number(keep))
  const keepRounds = Math.min(Math.max(Number.isFinite(keepRaw) && keepRaw > 0 ? keepRaw : 10, 1), maxRounds)
  const cycle = maxRounds - keepRounds + 1
  const cycles = Math.floor((totalRounds - maxRounds - 1) / cycle)
  const resetTotal = maxRounds + 1 + cycles * cycle
  return totalRounds - (resetTotal - keepRounds)
}
