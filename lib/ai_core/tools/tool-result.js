/** 工具返回值 → 统一的工具消息字段。
 *
 *  支持三种返回:
 *  - 字符串: 直接作为 content
 *  - { text, images, image_paths, videos, video_paths, audios, audio_paths, files, file_paths }
 *  - 其它对象: JSON 序列化为 content
 */
export function normalizeToolResult(payload) {
  const result = {
    content: "",
    images: [],
    image_paths: [],
    videos: [],
    video_paths: [],
    audios: [],
    audio_paths: [],
    files: [],
    file_paths: [],
  }

  let content
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.images)) {
      result.images = payload.images
      result.image_paths = payload.image_paths
      content = payload.text || "图片获取成功"
    }
    if (Array.isArray(payload.videos)) {
      result.videos = payload.videos
      result.video_paths = payload.video_paths
      content = payload.text || "视频获取成功"
    }
    if (Array.isArray(payload.audios)) {
      result.audios = payload.audios
      result.audio_paths = payload.audio_paths
      content = payload.text || "音频获取成功"
    }
    if (Array.isArray(payload.files)) {
      result.files = payload.files
      result.file_paths = payload.file_paths
      content = payload.text || "文件获取成功"
    }
  }
  if (!content) content = typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
  result.content = content
  return result
}
