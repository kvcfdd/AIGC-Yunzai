import log from "../helpers/log.js"
import { mediaToFile, encodeImageFile, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "./media.js"

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

  /** 将图片 URL/路径/data URI 数组预转为 data URI
   *  data URI 与 URL/路径同一管线: 落盘缓存 → 编码，动画 GIF 特化视频化
   *  @returns {Promise<{ uris: string[], paths: (string|null)[] }|null>} */
  async resolveImages(urls, signal) {
    if (!urls?.length) return null
    const uris = new Array(urls.length)
    const paths = new Array(urls.length).fill(null)
    await Promise.all(
      urls.map(async (u, i) => {
        if (u === "[图像异常]") {
          uris[i] = u
          return
        }
        try {
          const { file } = await mediaToFile(u, { kind: "image", maxBytes: MAX_IMAGE_BYTES, signal })
          uris[i] = await encodeImageFile(file, signal)
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

  /** 接收文档类文件 → 缓存原文件 → 格式识别 → data URI
   *  图片/视频后缀的文件由调用方按 classifyFileExt 分流到 resolveImages/resolveVideo，
   *  与用户直接发图/视频走同一管线
   *  @param {Array<{ url?: string, file?: string, name?: string }>} segs - 文件消息段
   *  @returns {Promise<{ files: string[], file_paths: (string|null)[] }|null>} */
  async resolveFiles(segs, signal) {
    if (!segs?.length) return null
    const files = []
    const file_paths = []
    for (const seg of segs) {
      const src = seg?.url || seg?.file
      if (!src) {
        log.debug(`文件消息缺少可下载地址 (${seg?.name || "未知文件名"})`)
        files.push("[文件异常]")
        file_paths.push(null)
        continue
      }
      const name = seg?.name || ""
      try {
        const { file, mime } = await mediaToFile(src, { kind: "file", name, maxBytes: MAX_FILE_DOWNLOAD, signal })
        if (!mime || !file) {
          files.push("[文件格式不支持查看]")
          file_paths.push(null)
          continue
        }
        files.push(await fileToDataUri(file, mime))
        file_paths.push(file)
      } catch (err) {
        log.debug(`文件处理失败: ${err.message}`)
        files.push("[文件异常]")
        file_paths.push(null)
      }
    }
    return { files, file_paths }
  }
}

export default LlmProvider
