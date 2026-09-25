import { existsSync } from "node:fs"

/** 只匹配带 (路径) 的媒体标记 —— 因此永远不会碰到 _applyMediaPathMarkers
 *  已写出的 [图片已过期] / [图片: name 已过期] 形式，构造上幂等。
 *  路径与文件名都容忍一层括号: 原始文件名(「报告(1).pdf」)与旧缓存路径都可能含
 *  ( )，而 [^)]+ 只会取到第一个 ) 为止。safeFileBase 现在已不再把括号写进
 *  缓存路径，所以嵌套两层以上的旧路径是唯一残留的缺口 —— 匹配不到即原样保留 */
const MARKER = /\[(图片|视频|语音|文件)(?::\s*([^\]\n]*?))?\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g

/** 把指向已删除文件的媒体标记改写为「已过期」。
 *
 *  maint_task 会清理 data/aigc 下超过 3 天的文件，而 send_media 接受本地路径，
 *  所以陈旧的 [图片](path) 是「可行动的路径」—— 模型拿去用就会失败，
 *  改写不是装饰而是防真实故障。
 *
 *  仅供读取路径使用 —— 绝不能作用于将要落盘的内容，否则会永久损坏历史。
 *  @param {string} content 消息文本
 *  @param {Map<string, boolean>} [cache] 跨消息共享的存在性缓存 */
export function expireMediaMarkers(content, cache = new Map()) {
  if (typeof content !== "string" || !content.includes("](")) return content
  return content.replace(MARKER, (full, label, name, path) => {
    // 非本地路径(网页里的 markdown 图片等)一律不动
    if (path.includes("://")) return full
    let ok = cache.get(path)
    if (ok === undefined) cache.set(path, (ok = existsSync(path)))
    if (ok) return full
    // 与 _applyMediaPathMarkers 的无名形式保持一致
    return name ? `[${label}: ${name} 已过期]` : `[${label}已过期]`
  })
}
