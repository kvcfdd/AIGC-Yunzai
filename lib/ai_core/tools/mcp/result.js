/** SDK CallToolResult → 文本；保持原手写实现的占位符语义 */
export function extractToolResult(result) {
  if (!result) return ""
  const content = Array.isArray(result.content) ? result.content : []
  const parts = []
  for (const c of content) {
    if (!c || typeof c !== "object") continue
    switch (c.type) {
      case "text":
        if (c.text) parts.push(c.text)
        break
      case "image":
        parts.push(`[image ${c.mimeType || "?"}]`)
        break
      case "audio":
        parts.push(`[audio ${c.mimeType || "?"}]`)
        break
      case "resource_link":
        parts.push(`[resource_link ${c.uri || ""}]`)
        break
      case "resource": {
        const r = c.resource || {}
        parts.push(r.text || `[resource ${r.uri || ""}]`)
        break
      }
      default:
        break
    }
  }
  if (parts.length) return parts.join("\n")
  if (result.structuredContent) return JSON.stringify(result.structuredContent)
  return ""
}

/** MCP 图片/音频内容 → data URI；类型或数据缺失时跳过 */
function contentDataUri(content) {
  const { type, mimeType, data } = content || {}
  if (typeof mimeType !== "string" || typeof data !== "string" || !data) return ""
  if (type === "image" ? !/^image\//i.test(mimeType) : !/^audio\//i.test(mimeType)) return ""
  return `data:${mimeType};base64,${data}`
}

/** 提取图片/音频内容，供多模态工具结果原样回传 */
function extractToolMedia(result) {
  let media
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type !== "image" && c?.type !== "audio") continue
    const uri = contentDataUri(c)
    if (!uri) continue
    media ||= {}
    ;(media[c.type === "image" ? "images" : "audios"] ||= []).push(uri)
  }
  return media
}

/** 工具调用结果 → 文本或 { text, images, audios }；isError 时抛错交给上层转为失败提示 */
export function normalizeCallToolResult(result) {
  const text = extractToolResult(result)
  if (result?.isError) throw new Error(text || "MCP tool error")
  const media = extractToolMedia(result)
  return media ? { text, ...media } : text
}
