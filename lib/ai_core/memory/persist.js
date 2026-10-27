/** 落盘时无条件丢弃的媒体字段 —— 已由 applyMediaPathMarkers 转成文本标记 */
const MEDIA_FIELDS = ["images", "image_paths", "videos", "video_paths", "audios", "audio_paths", "files", "file_paths"]

/** 落盘前把媒体编码替换为 [xx](本地路径) 引用：
 *  用户消息按占位符顺序逐个替换，无路径的标为已过期；工具消息在文本后追加路径标记 */
export function applyMediaPathMarkers(m) {
  // 占位符可能带原始 URL（extractMsgText 提取为 [xx](url)），替换时一并吞掉避免双重标记；
  // 文件类占位符带文件名（[文件: name]），替换后保留文件名
  // 文件名与路径都容忍括号: 原名(如「报告(1).pdf」)会被 safeFileBase 一路带进
  // 缓存路径，用 [^)]* 匹配只会取到第一个 )，占位符替换不成功、本地路径只能
  // 追加到文末，正文里反而留下原始 URL
  const kinds = [
    { list: m.images, paths: m.image_paths, label: "图片", re: /\[图片(?::\s*([^\]\n]*?))?\](?:\((?:[^()\n]|\([^()\n]*\))*\))?/g, hasName: true },
    { list: m.videos, paths: m.video_paths, label: "视频", re: /\[视频(?::\s*([^\]\n]*?))?\](?:\((?:[^()\n]|\([^()\n]*\))*\))?/g, hasName: true },
    { list: m.audios, paths: m.audio_paths, label: "语音", re: /\[语音(?::\s*([^\]\n]*?))?\](?:\((?:[^()\n]|\([^()\n]*\))*\))?/g, hasName: true },
    { list: m.files, paths: m.file_paths, label: "文件", re: /\[文件(?::\s*([^\]\n]*?))?\](?:\((?:[^()\n]|\([^()\n]*\))*\))?/g, hasName: true },
  ]
  for (const { list, paths, label, re, hasName } of kinds) {
    if (!list?.length) continue
    const filePaths = (paths || []).filter(Boolean)
    let content = m.content || ""
    if (m.role === "user") {
      // 用户消息的占位符与媒体数组同序，逐个替换；无路径的标为已过期
      let idx = 0
      content = content.replace(re, (...args) => {
        const p = (paths || [])[idx++]
        const name = hasName ? args[1] : null
        if (!p) return name ? `[${label}: ${name} 已过期]` : `[${label}已过期]`
        return name ? `[${label}: ${name}](${p})` : `[${label}](${p})`
      })
      // 占位符少于媒体数，剩余路径追加到文本末尾
      const extra = (paths || []).slice(idx).filter(Boolean)
      if (extra.length) content += "\n" + extra.map(p => `[${label}](${p})`).join("\n")
    } else if (filePaths.length) {
      const markers = filePaths.map(p => `[${label}](${p})`).join("\n")
      content = content ? `${content}\n${markers}` : markers
    }
    m.content = content || null
  }
}

/** 落盘前准备：媒体标记化 + 删除不再需要的媒体字段 */
export function prepareForPersist(m) {
  applyMediaPathMarkers(m)
  for (const key of MEDIA_FIELDS) delete m[key]
}
