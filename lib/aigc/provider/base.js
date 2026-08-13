import log from "../helpers/log.js"
import { mediaToFile, imageFileToDataUri, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD, DOCUMENT_MIMES } from "./media.js"

/** LLM Provider 抽象基类 — 各后端适配器继承并实现 chat()
 *  resolveImages/resolveVideo/resolveAudio 与后端无关，由基类统一提供。
 *  均返回 { uris, paths }: uris 供当前请求内联编码；paths 为缓存文件路径
 *  (data/aigc/chat)，供落盘时以 [xx](路径) 形式引用。失败位置 uris 为占位、paths 为 null。
 *
 *  chat() 契约:
 *   options: { signal, stateful, tools, tool_choice, channel, model, previous_interaction_id, ...适配器透传 }
 *   返回:    { content, tool_calls?, reasoning_content?, reasoning_parts?, interaction_id?, blocked?, finishReason?, usage? }
 *   失败:    抛 AigcError(code) / AbortError */
class LlmProvider {
  async chat(messages, options = {}) {
    throw new Error("LlmProvider.chat not implemented")
  }

  /** 将图片 URL/路径数组预转为 data URI（文件缓存于 data/aigc/chat）
   *  @returns {Promise<{ uris: string[], paths: (string|null)[] }|null>} */
  async resolveImages(urls) {
    if (!urls?.length) return null
    const uris = new Array(urls.length)
    const paths = new Array(urls.length).fill(null)
    await Promise.all(
      urls.map(async (u, i) => {
        if (u.startsWith("data:")) {
          uris[i] = u
          return
        }
        if (u === "[图像异常]") {
          uris[i] = u
          return
        }
        try {
          const { file } = await mediaToFile(u, { kind: "image", maxBytes: MAX_IMAGE_BYTES })
          uris[i] = await imageFileToDataUri(file)
          paths[i] = file
        } catch (err) {
          log.debug(`图片处理失败: ${err.message}`)
          uris[i] = "[图像异常]"
        }
      }),
    )
    return { uris, paths }
  }

  /** 下载视频 → 缓存原文件 → ffmpeg 压缩 → data URI
   *  @returns {Promise<{ uris: string[], paths: (string|null)[] }|null>} */
  async resolveVideo(urls, removeAudio = false, signal) {
    if (!urls?.length) return null
    const uris = []
    const paths = []
    for (const u of urls) {
      if (u.startsWith("data:")) {
        uris.push(u)
        paths.push(null)
        continue
      }
      try {
        const { file } = await mediaToFile(u, { kind: "video", maxBytes: MAX_VIDEO_DOWNLOAD, signal })
        uris.push(await videoFileToDataUri(file, removeAudio, signal))
        paths.push(file)
      } catch (err) {
        log.debug(`视频处理失败: ${err.message}`)
        uris.push("[视频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 下载语音 → 缓存原文件 → silk 解码/ffmpeg 转 WAV → data URI
   *  @returns {Promise<{ uris: string[], paths: (string|null)[] }|null>} */
  async resolveAudio(urls, signal) {
    if (!urls?.length) return null
    const uris = []
    const paths = []
    for (const u of urls) {
      if (u.startsWith("data:") || u === "[音频异常]") {
        uris.push(u)
        paths.push(null)
        continue
      }
      try {
        const { file } = await mediaToFile(u, { kind: "audio", maxBytes: MAX_AUDIO_DOWNLOAD, signal })
        uris.push(await audioFileToDataUri(file, signal))
        paths.push(file)
      } catch (err) {
        log.debug(`音频处理失败: ${err.message}`)
        uris.push("[音频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 接收文件 → 缓存原文件 → MIME 白名单校验 → data URI
   *  @param {Array<{ url?: string, file?: string, name?: string }>} segs - 文件消息段
   *  @returns {Promise<{ uris: string[], paths: (string|null)[] }|null>} */
  async resolveFiles(segs, signal) {
    if (!segs?.length) return null
    const uris = []
    const paths = []
    for (const seg of segs) {
      const src = seg?.url || seg?.file
      if (!src) {
        log.debug(`文件消息缺少可下载地址 (${seg?.name || "未知文件名"})`)
        uris.push("[文件异常]")
        paths.push(null)
        continue
      }
      try {
        const { file, mime } = await mediaToFile(src, { kind: "file", name: seg?.name, maxBytes: MAX_FILE_DOWNLOAD, signal })
        if (!mime || !DOCUMENT_MIMES.has(mime)) {
          log.debug(`文件 ${seg?.name || file.split("/").pop()} 类型暂不支持内联 (${mime || "未知"})`)
          uris.push("[文件异常]")
          paths.push(null)
          continue
        }
        uris.push(await fileToDataUri(file, mime))
        paths.push(file)
      } catch (err) {
        log.debug(`文件处理失败: ${err.message}`)
        uris.push("[文件异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }
}

export default LlmProvider
