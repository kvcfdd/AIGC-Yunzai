/** 动画 GIF 抽帧数组标记 —— 与“超长图切段”共用数组结构，但语义是一张动图 */
const ANIMATED = Symbol.for("aigc.animatedFrames")

/** 给帧数组打上动图标记 */
export function markAnimatedFrames(frames) {
  const arr = Array.isArray(frames) ? frames.slice() : []
  Object.defineProperty(arr, ANIMATED, { value: true, enumerable: false })
  return arr
}

export function isAnimatedFrames(item) {
  return Array.isArray(item) && item[ANIMATED] === true
}

/** 给模型的说明：这些是同一张动图的连续帧，不是多张独立图片 */
export function animatedFramesNote(count) {
  return `[动图] 这是一张动画 GIF，以下按时间顺序均匀抽取了 ${count} 帧；它们是同一张动图的连续画面，不是 ${count} 张独立图片。`
}
